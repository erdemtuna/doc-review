import { createReviewApi, decodePage, record } from "./chrome-api.js";
import { createConversationController } from "./conversation-controller.js";
import { createControllerStore } from "./controller-store.js";
import { createFrameHost } from "./frame-host.js";
import { createFrameController } from "./frame-controller.js";
import { createSaveController } from "./save-controller.js";
import { framePolicy } from "./frame-policy.js";
import { createCaptureRequests } from "./history-client.js";
import { limitEditFields } from "./edit-limits.js";
import { externalHref } from "./editing.js";
import { reviewSchema, directEditContentSchema } from "./contracts/index.js";
import type { PageResponse, ReviewMode, SavePolicy } from "./contracts/page.js";
import { createConversationAnchorController, describeConversationAnchor } from "./conversation-anchor-controller.js";
import { placeConversationSurface, placeNewMessageSurface, visibleViewport } from "./positioning.js";
import { readNewMessageTarget, type NewMessageTarget } from "./new-message-target.js";
import { normalizeView, sameObservedView } from "./view-identity.js";
import { createResultCaptures, decodeComparison, resultCaptureKey, type ResultCaptureScope } from "./conversation-capture.js";

export function createConversationShell() {
  const reference = { reviewId: decodeURIComponent(document.body.dataset.review!), entryKey: decodeURIComponent(document.body.dataset.entry!) };
  const api = createReviewApi({ token: document.body.dataset.token! });
  let sessionId = document.body.dataset.session!;
  const artifactOrigin = `${location.protocol}//${location.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1"}:${location.port}`;
  let page: PageResponse | null = null, mode: ReviewMode = "view", theme: "light" | "dark" = "light";
  let loading = true, sourceError = "", captureError = "", reloadPending = false, connectionError = "";
  let comparison: { value: Record<string, unknown> | null; submissionId: string; pageKey: string; mode: "source" | "content"; loading: boolean; error: string } | null = null;
  let comparisonOpen = false, comparisonRequest = 0;
  let disposed = false, eventSource: EventSource | null = null, reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnecting: Promise<void> | null = null, scroll = { x: 0, y: 0 };
  let pendingTarget: number | null = null, hadNewMessage = false;
  let newTarget: NewMessageTarget | null = null, targetHighWater = 0, retiredTarget = 0;
  let composer: ReturnType<typeof placeNewMessageSurface> = null, composerHeight = 310;
  let composerNotice = "";
  let pendingJump: string | null = null;
  const geometry = createConversationAnchorController();
  let adjacent: ReturnType<typeof placeConversationSurface> = null;
  let anchorNotice = "", anchorThread: string | null = null, activeMark: string | null = null;
  let fallbackSpace = false;
  let unavailable: "render-loading" | "render-unavailable" | "render-changed" = "render-loading";
  const capturesAttempted = new Set<string>();
  let observedView: ReturnType<typeof normalizeView> | null = null;
  let captureCycle: Promise<void> | null = null;
  const assetUrls = new Map<string, string>();
  const normalizeAssets = (value: string) => {
    for (const [url, relative] of assetUrls) value = value.replaceAll(url, relative);
    return value;
  };
  const lifetime = new AbortController();
  const owner = createConversationController({
    ...reference, request: api.request,
    barrier: () => save.barrier(), baseline: () => capture(null),
    navigate(key) { pendingJump = null; return navigate(key); }, async jump(id) {
      const thread = owner.getSnapshot().threads.find((item) => item.thread.threadId === id);
      if (!thread) return;
      if (thread.thread.pageKey === frame.state.key && !loading) {
        revealThread(id);
      }
      else {
        pendingJump = id;
        try { await navigate(thread.thread.pageKey); }
        catch (cause) { if (pendingJump === id) pendingJump = null; throw cause; }
      }
    },
    async revert() {
      await save.barrier();
      const current = owner.pages.find((item) => item.page.pageKey === frame.state.key);
      if (!current?.canRevert || !current.revert) throw new Error("This review does not own a current revert baseline.");
      await owner.mutate("revert", { pageKey: current.page.pageKey, expectedSourceHash: current.revert.sourceHash,
        baselineRevisionId: current.revert.baselineRevisionId });
      await load(current.page.pageKey);
    },
  });
  function currentPage() { return owner.pages.find((item) => item.page.pageKey === frame.state.key); }
  function blocked() { return owner.review?.state !== "open" || !!currentPage()?.writeBlockedBy.length || !!owner.getSnapshot().uncertain; }
  function policy(): SavePolicy { return save.state.dynamic ? "feedback-only" : frame.state.execution?.savePolicy ?? currentPage()?.savePolicy ?? "feedback-only"; }
  function reportSource(value: unknown) {
    sourceError = value instanceof Error ? value.message : String(value);
    publish();
  }
  function makeFrame() {
    const element = document.querySelector<HTMLIFrameElement>("#frame");
    if (!element) throw new Error("Document frame is missing.");
    return createFrameController({
      sessionId, host: createFrameHost(element, artifactOrigin), request: api.request,
      suspended() { loading = true; clearAnchors("render-loading"); publish(); },
      failed(message) { pendingJump = null; clearAnchors("render-unavailable"); reportSource(message); },
      activated() { loading = false; void activate().catch(reportSource); },
    });
  }
  let frame = makeFrame();
  const captures = createCaptureRequests({ send: (message: Record<string, unknown>) => frame.send(message), current: () => frame.identity() });
  const resultCaptures = createResultCaptures({
    current: currentCapture,
    compare: (scope) => api.request("/api/conversation/comparison", { method: "POST", body: JSON.stringify({
      ...reference, submissionId: scope.submissionId, pageKey: scope.pageKey, mode: "content",
    }) }),
    capture: (scope) => capture(scope.submissionId, scope),
    refresh: () => owner.refresh(),
    changed: publish,
  });
  const save = createSaveController({
    sessionId, current: () => frame.identity(), policy, request: api.request,
    flush: (strict) => frame.flush(strict), send: (message) => frame.send(message),
    sourceHash: (hash) => frame.setSourceHash(hash), pageChanged() {},
    conflict() { reportSource("Source changed or write permission was withdrawn. Inspect source and reload before further edits; conversation drafts are kept."); mode = "view"; void configure(); },
    failed: reportSource, diagnostic() {}, sending: () => owner.getSnapshot().busy,
    conversation: {
      record(key, payload) {
        if (blocked()) return Promise.reject(new Error("Direct writes are blocked. Saved discussion can still be prepared."));
        const { feedback_only: _feedback, ...content } = payload;
        for (const field of ["before_html", "after_html"]) if (typeof content[field] === "string") content[field] = normalizeAssets(content[field]);
        if (Array.isArray(content.staged_assets)) content.staged_assets = content.staged_assets.map((value) => {
          const asset = record(value);
          return { ...asset, preview_src: typeof asset.preview_src === "string" ? normalizeAssets(asset.preview_src) : asset.preview_src };
        });
        const limited = limitEditFields(content);
        if (limited.truncated) {
          save.markDynamic();
          reportSource("Incomplete edit capture retained as source-pending. No truncated content will be saved to source.");
          void frame.configure(mode, "feedback-only").catch(reportSource);
        }
        return owner.recordEdit(key, directEditContentSchema.parse({
          ...content, ...limited.fields, truncated: limited.truncated || content.truncated === true,
          truncated_fields: [...new Set([...limited.truncated_fields, ...(Array.isArray(content.truncated_fields) ? content.truncated_fields : [])])],
          staged_assets: content.staged_assets ?? [],
        }));
      },
      // serializeDocument adds a file terminator outside </html>. Parsing that
      // terminator would invent a body text node unrelated to the recorded edit.
      save: (key, html, sourceHash) => owner.saveHtml(key, normalizeAssets(html).replace(/(<\/html>)\n$/, "$1"), sourceHash),
    },
  });
  const chrome = createControllerStore(() => ({
    pageKey: frame.state.key, pageName: page?.filename ?? "", mode, theme, loading,
    contentTop: contentTop(),
    pollCommand: page?.pollCommand ?? "",
    themeSync: frame.themeSync, executionPreference: page?.executionPreference ?? "auto",
    supportsRecovery: page?.kind === "file" && !page.markdown,
    sourceError, captureError, captureFailures: resultCaptures.failures, connectionError, reloadPending, save: save.getSnapshot(), blocked: blocked(),
    canRevert: currentPage()?.canRevert ?? false, policy: policy(), comparison, comparisonOpen,
    adjacent, anchorNotice, anchorThread, composer, composerNotice,
    canComposeBeside: !!newTarget?.geometry && newTarget.geometry.relation !== "unavailable" && !loading,
    composerRelation: newTarget?.geometry?.relation ?? "unavailable", viewport: visibleViewport(window),
    anchorViews: Object.fromEntries(owner.getSnapshot().threads.map(({ thread }) => [thread.threadId,
      thread.pageKey !== frame.state.key
        ? { canJump: !loading, offscreen: false, reason: "Jump to opens its review page." }
        : describeConversationAnchor(geometry.states.find((state) => state.threadId === thread.threadId) ??
          { threadId: thread.threadId, state: "unavailable", reason: unavailable })])),
    anchorPeers: Object.fromEntries(owner.getSnapshot().threads.map(({ thread }) => [thread.threadId, geometry.peers(thread.threadId)])),
  }));
  function publish() { if (!disposed) chrome?.publish(); }
  const stopSave = save.subscribe(publish);
  let stopFrame = frame.subscribe(frameChanged);
  let priorEdits = owner.getSnapshot().edits;
  const stopOwner = owner.subscribe(() => {
    if (blocked() && mode === "edit") {
      mode = "view"; frame.send({ type: "eh:abortSave" }); void configure().catch(reportSource);
    }
    const current = owner.getSnapshot();
    if (hadNewMessage && !current.newMessage && pendingTarget !== null) {
      retiredTarget = Math.max(retiredTarget, targetHighWater, pendingTarget);
      frame.send({ type: "eh:cancel", targetGeneration: pendingTarget, discardThroughGeneration: retiredTarget, restoreFocus: true });
      pendingTarget = null;
      newTarget = null; composer = null; composerNotice = "";
      if (current.host === "compose") owner.commands.open(false);
    }
    hadNewMessage = !!current.newMessage;
    if (!save.state.dirty && !save.queued(frame.state.key)) {
      const submitted = current.submissions.flatMap((item) => item.value.submission.edits);
      const labels = priorEdits.filter((edit) => edit.pageKey === frame.state.key &&
        submitted.some((item) => item.editId === edit.editId && item.version === edit.version) &&
        !current.edits.some((item) => item.pageKey === edit.pageKey && item.content.label === edit.content.label))
        .map((edit) => edit.content.label);
      if (labels.length) frame.send({ type: "eh:submittedEdits", labels });
    }
    priorEdits = current.edits;
    syncAnchors(); updatePlacement();
    const latest = owner.getSnapshot();
    if (comparisonOpen && !comparison && latest.history.some((item) => item.result)) void showChanges().catch(owner.report);
    const wanted = latest.open ? latest.focusId : null;
    if (wanted !== activeMark) {
      if (activeMark && geometry.projection?.anchors.some((item) => item.threadId === activeMark)) sendThreadAction("dismiss", activeMark);
      activeMark = null;
      if (wanted && geometry.states.some((state) => state.threadId === wanted && state.state === "found")) {
        activeMark = wanted; sendThreadAction("activate", wanted);
      }
    }
    if (!loading) void captureResults().catch(reportSource);
    publish();
  });
  function clearAnchors(reason: typeof unavailable) {
    geometry.reset(); unavailable = reason; adjacent = null; activeMark = null;
    pendingTarget = null; newTarget = null; targetHighWater = 0; retiredTarget = 0; composer = null;
    if (owner.getSnapshot().newMessage) {
      composerNotice = "The original target belongs to a replaced render. Your draft is kept in Feedback.";
      if (owner.getSnapshot().host === "compose") owner.commands.focus(null);
    }
    fallbackSpace = false;
    if (owner.getSnapshot().host === "adjacent") {
      anchorNotice = describeConversationAnchor({ threadId: anchorThread ?? "", state: "unavailable", reason }).reason;
      owner.commands.fallback();
    }
  }
  function frameChanged() {
    const projection = geometry.projection;
    if (projection && (projection.renderId !== frame.state.renderId || projection.generation !== frame.state.generation ||
      projection.pageKey !== frame.state.key || frame.state.phase.kind !== "ready")) clearAnchors("render-changed");
    if (!frame.identity().loading) void captureResults().catch(reportSource);
    publish();
  }
  function syncAnchors() {
    if (loading || frame.state.phase.kind !== "ready" || !frame.state.capability || !frame.state.key || !frame.state.renderId) return;
    const projection = {
      type: "eh:threadAnchors" as const, capability: frame.state.capability, ...reference,
      pageKey: frame.state.key, renderId: frame.state.renderId, generation: frame.state.generation,
      anchors: owner.getSnapshot().threads.filter((item) => item.thread.pageKey === frame.state.key)
        .map(({ thread }) => ({ threadId: thread.threadId, target: thread.target })),
    };
    const { entryKey: _entryKey, ...payload } = projection;
    if (geometry.project(payload)) frame.send(geometry.projection!);
  }
  function sendThreadAction(action: "activate" | "reveal" | "dismiss", id: string) {
    const projection = geometry.projection;
    if (loading || projection?.capability !== frame.state.capability || projection?.renderId !== frame.state.renderId ||
        projection?.generation !== frame.state.generation || projection?.pageKey !== frame.state.key) {
      throw new Error("The target belongs to a replaced or unavailable frame.");
    }
    frame.send(geometry.outgoing(action, id));
  }
  function revealThread(id: string) {
    // Validate before hiding Feedback. Close first so Focus dismissal cannot erase the new reveal.
    geometry.outgoing("reveal", id);
    owner.commands.open(false);
    sendThreadAction("reveal", id);
  }
  function updatePlacement() {
    const current = owner.getSnapshot();
    composer = null;
    if (current.open && current.newMessage && current.host === "compose") {
      const element = document.querySelector<HTMLIFrameElement>("#frame");
      const viewport = visibleViewport(window);
      composer = element && newTarget?.geometry ? placeNewMessageSurface(newTarget.geometry, {
        frameRect: element.getBoundingClientRect(), viewport, surfaceWidth: 340, surfaceHeight: composerHeight,
        toolbarHeight: Math.max(0, contentTop() - viewport.top),
      }) : null;
      if (!composer) {
        composerNotice = !newTarget?.geometry || newTarget.geometry.relation === "unavailable"
          ? "The original target cannot currently be shown. Your draft is kept in Feedback."
          : "Opened in Feedback because there is not enough clear room beside the target.";
        owner.commands.focus(null);
      } else composerNotice = "";
    }
    adjacent = null;
    if (!current.open || current.host !== "adjacent" || !current.focusId) {
      const state = geometry.states.find((item) => item.threadId === anchorThread);
      if (anchorNotice && state && !(fallbackSpace && state.state === "found" && state.relation === "visible")) {
        anchorNotice = describeConversationAnchor(state).reason;
      }
      publish(); return;
    }
    const state = geometry.states.find((item) => item.threadId === current.focusId);
    const element = document.querySelector<HTMLIFrameElement>("#frame");
    if (document.body.dataset.conversationPane !== "open" || document.body.dataset.conversationHost !== "adjacent") { publish(); return; }
    if (state?.state === "found" && element &&
        (Math.abs(element.clientWidth - state.viewport.width) > 1 || Math.abs(element.clientHeight - state.viewport.height) > 1)) {
      publish(); return; // Wait for the adjacent-only document gutter and its fresh anchor geometry.
    }
    adjacent = element && state ? placeConversationSurface(state, {
      frameRect: element.getBoundingClientRect(), viewport: visibleViewport(window),
      toolbarHeight: Math.max(0, contentTop() - visibleViewport(window).top),
    }) : null;
    if (!adjacent) {
      fallbackSpace = state?.state === "found" && state.relation === "visible";
      anchorNotice = fallbackSpace
        ? "Opened in Feedback because there is not enough room beside the target."
        : describeConversationAnchor(state).reason;
      owner.commands.fallback();
    } else anchorNotice = "";
    publish();
  }
  function showAdjacent(id: string) {
    if (!geometry.states.some((state) => state.threadId === id && state.state === "found")) {
      throw new Error("The target is unavailable. Continue this conversation in Feedback.");
    }
    anchorThread = id; anchorNotice = ""; fallbackSpace = false;
    owner.commands.adjacent(id);
    requestAnimationFrame(() => { if (!disposed) updatePlacement(); });
  }
  async function configure() {
    if (loading) return;
    if (!await frame.configure(blocked() ? "view" : mode, policy())) throw new Error("The page did not confirm its review mode.");
    publish();
  }
  async function activate() {
    syncAnchors();
    frame.send({ type: "eh:restoreScroll", ...scroll });
    frame.setTheme(theme);
    await configure();
    frame.restoredScroll();
    if (page?.kind !== "url") {
      const identity = frame.identity();
      const raw = record(await api.request(`/api/page/${identity.key}/raw`));
      if (identity.renderId !== frame.state.renderId) return;
      if (typeof raw.hash !== "string" || typeof raw.html !== "string") throw new Error("Invalid source baseline.");
      if (frame.state.sourceHash !== raw.hash) throw new Error("Source changed while rendering. Reload latest before editing.");
      save.baseline(raw.hash);
      if (policy() === "writable") frame.send({ type: "eh:raw", html: raw.html });
    }
    await owner.refresh();
    void captureResults().catch(reportSource);
    publish();
  }
  async function load(key: string) {
    captures.cancel();
    observedView = null;
    if (frame.state.renderId) frame.startReload();
    loading = true; sourceError = ""; reloadPending = false; clearAnchors("render-loading");
    const generation = frame.begin(key);
    publish();
    const loaded = decodePage(await api.request(`/api/page/${key}?session=${encodeURIComponent(sessionId)}`));
    if (frame.state.key !== key || frame.state.generation !== generation) return;
    page = loaded;
    document.title = loaded.filename || "doc-review";
    frame.setPolicy(framePolicy(page, artifactOrigin));
    save.reset();
    await frame.register(key, generation);
  }
  async function navigate(key: string) {
    if (key === frame.state.key) return;
    await save.barrier();
    await api.request(`/api/session/${sessionId}/goto`, { method: "POST", body: JSON.stringify({ key }) });
    scroll = { x: 0, y: 0 };
    await load(key);
  }
  async function navigateHref(href: string) {
    pendingJump = null;
    await save.barrier();
    const resolved = record(await api.request(`/api/session/${sessionId}/resolve-target`, { method: "POST", body: JSON.stringify({ href }) }));
    if (typeof resolved.target !== "string") throw new Error("Navigation target could not be identified.");
    const joined = owner.pages.find(({ page }) => (page.target.kind === "file" ? page.target.path : page.target.url) === resolved.target);
    if (joined) return navigate(joined.page.pageKey);
    const receipt = await owner.mutate("join-page", { target: resolved.target });
    if (!receipt.value.pageKey) throw new Error("Joined page identity is missing.");
    await navigate(receipt.value.pageKey);
  }
  function captureScope(submissionId: string): ResultCaptureScope {
    const identity = frame.identity();
    if (!identity.key || !identity.renderId || identity.loading) throw new Error("The page is not ready to capture.");
    return { ...reference, submissionId, pageKey: identity.key, sessionId, renderId: identity.renderId,
      generation: identity.generation, sourceHash: frame.state.sourceHash, view: normalizeView(observedView) };
  }
  function currentCapture(scope: ResultCaptureScope) {
    if (disposed || loading || frame.identity().loading || !frame.state.renderId) return false;
    return resultCaptureKey(scope) === resultCaptureKey(captureScope(scope.submissionId));
  }
  async function capture(submissionId: string | null, scope?: ResultCaptureScope) {
    const snapshot = record(await save.captureStable(() => captures.request()));
    const identity = frame.identity();
    if (scope && (!currentCapture(scope) || !sameObservedView(scope.view, snapshot.view))) {
      throw new Error("The page or visible view changed during capture. Retry on the current page.");
    }
    await api.request("/api/conversation/capture", { method: "POST", body: JSON.stringify({
      ...reference, pageKey: identity.key, submissionId, sessionId, renderId: identity.renderId,
      generation: identity.generation, expectedSourceHash: snapshot.sourceHash ?? frame.state.sourceHash,
      semantic: snapshot.semantic, semanticCapturedAt: snapshot.semanticCapturedAt, view: snapshot.view,
    }) });
  }
  function captureResults(): Promise<void> {
    if (frame.identity().loading) return Promise.resolve();
    if (captureCycle) return captureCycle;
    captureCycle = capturePendingResults().finally(() => { captureCycle = null; });
    return captureCycle;
  }
  async function capturePendingResults() {
    for (const item of owner.getSnapshot().history) {
      if (frame.identity().loading) return;
      const scope = captureScope(item.submissionId), key = resultCaptureKey(scope);
      if (item.result?.effect !== "changes-reported" || !["pending", "partial", "failed", "unavailable"].includes(item.comparisonStatus) || capturesAttempted.has(key)) continue;
      const submission = owner.getSnapshot().submissions.find((entry) => entry.id === item.submissionId)?.value.submission;
      if (!submission?.pageKeys.includes(frame.state.key ?? "")) continue;
      capturesAttempted.add(key);
      try { await resultCaptures.request(scope); }
      catch { /* The exact result/page owns its capture failure, not the source-save banner. */ }
    }
  }
  function connect() {
    eventSource?.close();
    eventSource = new EventSource(`/events/${sessionId}`);
    eventSource.addEventListener("invalidate", () => { void owner.refresh().catch(owner.report); });
    eventSource.addEventListener("open", () => {
      owner.commands.connected(true); connectionError = ""; publish();
      void owner.refresh().catch(owner.report);
    });
    eventSource.addEventListener("reload", () => {
      if (save.state.dirty || save.state.conflict || save.queued(frame.state.key)) {
        reloadPending = true; save.hold(); publish();
      } else if (frame.state.key) void load(frame.state.key).catch(reportSource);
    });
    eventSource.onerror = () => {
      eventSource?.close(); owner.commands.connected(false);
      connectionError = "Connection lost. Reattaching this exact review; local drafts remain in this tab."; publish();
      scheduleReconnect();
    };
  }
  function scheduleReconnect() {
    if (!disposed && !reconnectTimer) reconnectTimer = setTimeout(() => {
      reconnectTimer = null; void reconnect().catch((cause) => { connectionError = String(cause); publish(); scheduleReconnect(); });
    }, 1000);
  }
  async function reconnect() {
    if (reconnecting) return reconnecting;
    reconnecting = (async () => {
      const response = await fetch(`/r/${encodeURIComponent(reference.reviewId)}`, { cache: "no-store", signal: lifetime.signal });
      if (!response.ok) throw new Error(`Review reattachment failed (${response.status}).`);
      const body = new DOMParser().parseFromString(await response.text(), "text/html").body;
      if (decodeURIComponent(body.dataset.review ?? "") !== reference.reviewId || decodeURIComponent(body.dataset.entry ?? "") !== reference.entryKey ||
          !body.dataset.token || !body.dataset.session) throw new Error("Reattachment returned a different or invalid review.");
      api.setToken(body.dataset.token); sessionId = body.dataset.session;
      document.body.dataset.session = sessionId; document.body.dataset.token = body.dataset.token;
      const key = frame.state.key ?? reference.entryKey;
      captures.cancel(); stopFrame(); frame.dispose();
      frame = makeFrame();
      clearAnchors("render-changed");
      stopFrame = frame.subscribe(frameChanged);
      await owner.refresh();
      if (save.state.dirty || save.queued(key)) {
        sourceError = "Server restarted with local source edits. Reconcile any unknown request and inspect source before reloading; conversation drafts are kept.";
        reloadPending = true; loading = true;
      } else {
        if (key !== reference.entryKey) await api.request(`/api/session/${sessionId}/goto`, { method: "POST", body: JSON.stringify({ key }) });
        await load(key);
      }
      connect();
    })().finally(() => { reconnecting = null; });
    return reconnecting;
  }
  window.addEventListener("message", (event) => {
    if (frame.handleThemeMessage(event) || !frame.accepts(event)) return;
    const message = event.data;
    void (async () => {
      switch (message.type) {
        case "eh:ready": await frame.ready(); break;
        case "eh:configurationApplied": frame.configured(message.mode, message.savePolicy); break;
        case "eh:openComment": {
          let accepted = false;
          try {
            const detail = readNewMessageTarget(message);
            if (detail.generation <= retiredTarget ||
                (detail.generation < targetHighWater && detail.generation !== pendingTarget)) throw new Error("The new-comment target is stale.");
            targetHighWater = Math.max(targetHighWater, detail.generation);
            if (owner.review?.state === "open" && frame.state.key && !loading) {
              if (pendingTarget === detail.generation && owner.getSnapshot().newMessage) {
                if (JSON.stringify(detail.target) !== JSON.stringify(newTarget?.target)) throw new Error("Target identity changed without a new generation.");
                newTarget = detail; owner.commands.compose(); accepted = true;
              } else {
                const previous = newTarget;
                newTarget = detail;
                try { accepted = owner.commands.begin(frame.state.key, detail.target, true); }
                catch (cause) { newTarget = previous; throw cause; }
                if (accepted) pendingTarget = detail.generation;
                else newTarget = previous;
              }
            }
          } finally { frame.send({ type: "eh:commentOpenResult", accepted, requestedGeneration: message.targetGeneration, targetGeneration: pendingTarget }); }
          break;
        }
        case "eh:target": {
          const detail = readNewMessageTarget(message);
          targetHighWater = Math.max(targetHighWater, detail.generation);
          break;
        }
        case "eh:targetGeometry": {
          if (message.targetGeneration !== pendingTarget || !newTarget) break;
          const detail = readNewMessageTarget(message);
          if (JSON.stringify(detail.target) !== JSON.stringify(newTarget.target)) throw new Error("Target geometry cannot replace the original anchor.");
          newTarget = detail; updatePlacement(); break;
        }
        case "eh:revealTargetResult":
          if (message.targetGeneration === pendingTarget && message.success === false) {
            composerNotice = "The original target could not be revealed. Your draft is kept in Feedback.";
            if (owner.getSnapshot().open) owner.commands.focus(null);
            publish();
          }
          break;
        case "eh:threadAnchorStates":
          if (!geometry.receive(message)) break;
          updatePlacement();
          if (pendingJump && owner.getSnapshot().threads.some(({ thread }) =>
            thread.threadId === pendingJump && thread.pageKey === frame.state.key)) {
            const id = pendingJump; pendingJump = null;
            const state = geometry.states.find((item) => item.threadId === id);
            if (state?.state === "found") revealThread(id);
            else {
              anchorNotice = describeConversationAnchor(state).reason;
              owner.commands.focus(null);
            }
          }
          break;
        case "eh:threadAction": {
          const action = geometry.incoming(message);
          if (!action) break;
          if (action.action === "activate") showAdjacent(action.threadId);
          else if (owner.getSnapshot().focusId === action.threadId) owner.commands.open(false);
          break;
        }
        case "eh:edit": {
          if (!frame.state.key || blocked()) throw new Error("Direct edits are blocked by review lifecycle or outstanding work.");
          const content: Record<string, unknown> = {};
          for (const name of ["label", "kind", "before", "after", "before_html", "after_html", "moved_after", "moved_before", "truncated", "truncated_fields", "staged_assets"]) {
            if (message[name] !== undefined) content[name] = message[name];
          }
          save.markEdit(); await save.persistEdit(frame.state.key, content); break;
        }
        case "eh:html": if (typeof message.html === "string") {
          if (blocked()) throw new Error("Source writes are blocked.");
          await save.settleEdits(frame.state.key);
          if (!save.state.dynamic) await save.save(message.html);
        } break;
        case "eh:saving": save.markSaving(); break;
        case "eh:clean": save.observeClean(); break;
        case "eh:dynamic": save.markDynamic(); break;
        case "eh:flushed": frame.flushed(message.requestId); break;
        case "eh:snapshot": captures.receive(message); break;
        case "eh:viewChanged": {
          const view = normalizeView(message.view);
          if (!sameObservedView(observedView, view)) {
            observedView = view;
            await captureCycle;
            await captureResults();
          }
          break;
        }
        case "eh:scroll": if (typeof message.x === "number" && typeof message.y === "number") scroll = { x: message.x, y: message.y }; break;
        case "eh:navigate": if (typeof message.href === "string") await navigateHref(message.href); break;
        case "eh:external": {
          const url = externalHref(message.href, location.href);
          if (!url) throw new Error("Unsupported external link.");
          window.open(url, "_blank", "noopener");
          break;
        }
        case "eh:formBlocked": throw new Error(typeof message.reason === "string" ? message.reason : "This form cannot be submitted from View mode.");
        case "eh:asset": {
          const identity = frame.identity();
          try {
            if (blocked() || !(message.bytes instanceof ArrayBuffer)) throw new Error("Image staging is unavailable.");
            const bytes = new Uint8Array(message.bytes);
            let binary = "";
            for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
            const asset = record(await api.request("/api/conversation/asset", { method: "POST", body: JSON.stringify({
              ...reference, pageKey: identity.key, type: message.assetType, base64: btoa(binary),
            }) }));
            if (!frame.matches(identity)) throw new Error("Image upload belongs to a replaced render and was not inserted.");
            if (typeof asset.id !== "string" || asset.preview_src !== `__doc_review_paste__/${asset.id}`) throw new Error("Invalid staged image reference.");
            const preview = `${artifactOrigin}/artifact/${identity.renderId}/${asset.preview_src}`;
            assetUrls.set(preview, asset.preview_src);
            frame.send({ type: "eh:assetSaved", id: message.id, src: preview, stagedId: asset.id });
          } catch (cause) { if (frame.matches(identity)) frame.send({ type: "eh:assetFailed", id: message.id }); throw cause; }
          break;
        }
      }
    })().catch(owner.report);
  }, { signal: lifetime.signal });
  window.addEventListener("beforeunload", (event) => {
    if (owner.draftsPresent || save.state.dirty || owner.getSnapshot().uncertain) { event.preventDefault(); event.returnValue = ""; }
  }, { signal: lifetime.signal });
  function dispose() {
    disposed = true; eventSource?.close(); if (reconnectTimer) clearTimeout(reconnectTimer);
    captures.cancel(); lifetime.abort(); stopOwner(); stopSave(); stopFrame(); save.dispose(); frame.dispose(); api.dispose(); owner.dispose(); chrome.dispose();
  }
  window.addEventListener("pagehide", (event) => { if (!event.persisted) dispose(); }, { signal: lifetime.signal });
  window.addEventListener("online", () => { void owner.refresh().catch(owner.report); }, { signal: lifetime.signal });
  window.addEventListener("resize", updatePlacement, { signal: lifetime.signal });
  window.visualViewport?.addEventListener("resize", updatePlacement, { signal: lifetime.signal });
  window.visualViewport?.addEventListener("scroll", updatePlacement, { signal: lifetime.signal });
  function contentTop() { return document.querySelector(".shell-toolbar")?.getBoundingClientRect().bottom ?? 0; }
  function updateLayout() {
    document.documentElement.style.setProperty("--toolbar-h", `${contentTop()}px`);
    updatePlacement();
  }
  const layoutObserver = new ResizeObserver(updateLayout);
  const stage = document.querySelector(".stage");
  if (stage) layoutObserver.observe(stage);
  const toolbar = document.querySelector(".shell-toolbar");
  if (toolbar) layoutObserver.observe(toolbar);
  lifetime.signal.addEventListener("abort", () => layoutObserver.disconnect(), { once: true });
  async function selectComparison(submissionId: string, pageKey: string, mode: "source" | "content") {
    const detail = owner.getSnapshot().submissions.find((item) => item.id === submissionId)?.value;
    if (!detail?.result || !detail.submission.pageKeys.includes(pageKey) || !["source", "content"].includes(mode)) {
      throw new Error("Choose a handled submission and a page belonging to that submission.");
    }
    const request = ++comparisonRequest;
    const previous = comparison?.submissionId === submissionId && comparison.pageKey === pageKey && comparison.mode === mode ? comparison.value : null;
    comparisonOpen = true;
    comparison = { value: previous, submissionId, pageKey, mode, loading: true, error: "" }; publish();
    try {
      const value = decodeComparison(await api.request("/api/conversation/comparison", { method: "POST", body: JSON.stringify({ ...reference, submissionId, pageKey, mode }) }), mode);
      if (disposed || request !== comparisonRequest) return;
      if (mode === "content") resultCaptures.confirmContent({ ...reference, submissionId, pageKey }, value);
      comparison = { value: JSON.stringify(previous) === JSON.stringify(value) ? previous : value, submissionId, pageKey, mode, loading: false, error: "" };
    } catch (cause) {
      if (disposed || request !== comparisonRequest) return;
      comparison = { value: previous, submissionId, pageKey, mode, loading: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
    publish();
  }
  async function showChanges() {
    const snapshot = owner.getSnapshot();
    const previous = comparison && snapshot.submissions.find((item) => item.id === comparison?.submissionId)?.value;
    if (comparison && previous?.result && previous.submission.pageKeys.includes(comparison.pageKey)) {
      if (comparisonOpen) return;
      await selectComparison(comparison.submissionId, comparison.pageKey, comparison.mode);
      return;
    }
    const latest = snapshot.history.find((item) => item.result &&
      snapshot.submissions.some((detail) => detail.id === item.submissionId && detail.value.result));
    const detail = snapshot.submissions.find((item) => item.id === latest?.submissionId)?.value;
    if (latest && detail?.submission.pageKeys[0]) {
      const key = detail.submission.pageKeys.includes(frame.state.key ?? "") ? frame.state.key! : detail.submission.pageKeys[0];
      await selectComparison(latest.submissionId, key, "content");
    } else { comparison = null; comparisonOpen = true; publish(); }
  }
  async function start() {
    try { theme = localStorage.getItem("doc-review:theme") === "dark" ? "dark" : "light"; }
    catch (cause) { owner.report(`Theme preference unavailable: ${String(cause)}`); }
    document.documentElement.dataset.theme = theme;
    await owner.refresh();
    const bootstrap = record(await api.request(`/api/session/${sessionId}/page`));
    const reviewed = reviewSchema.parse(bootstrap.review);
    if (reviewed.reviewId !== reference.reviewId || reviewed.entryKey !== reference.entryKey || typeof bootstrap.key !== "string") throw new Error("Review bootstrap scope mismatch.");
    if (typeof bootstrap.generation === "number") frame.seedGeneration(bootstrap.generation);
    await load(bootstrap.key); connect();
  }
  void start().catch(owner.report);
  return {
    owner, getSnapshot: chrome.getSnapshot, subscribe: chrome.subscribe,
    commands: {
      measureComposer(height: number) {
        if (!Number.isFinite(height) || height <= 0 || Math.abs(height - composerHeight) < 1) return;
        composerHeight = height; updatePlacement();
      },
      composeBeside() { owner.commands.compose(); },
      revealSelection() {
        if (pendingTarget === null || !newTarget?.geometry || newTarget.geometry.relation === "unavailable" || loading) return;
        frame.send({ type: "eh:revealTarget", targetGeneration: pendingTarget });
      },
      adjacent: showAdjacent,
      async mode(next: ReviewMode) {
        if (next === "edit" && blocked()) throw new Error("Edit is blocked by ended review or outstanding work.");
        if (mode === "edit") await save.barrier();
        const previous = mode;
        try { mode = next; await configure(); }
        catch (cause) { mode = previous; throw cause; }
        finally { publish(); }
      },
      theme() {
        theme = theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = theme; frame.setTheme(theme);
        try { localStorage.setItem("doc-review:theme", theme); } catch (cause) { owner.report(`Theme preference not saved: ${String(cause)}`); }
        publish();
      },
      reconnect,
      async retryTheme() { if (!await frame.retryTheme()) throw new Error("The annotation tools could not confirm the latest theme."); },
      async execution(preference: "auto" | "static") {
        if (!page || page.kind !== "file" || page.markdown) throw new Error("Script recovery is available only for HTML files.");
        await save.barrier();
        await api.request(`/api/session/${sessionId}/execution`, { method: "POST", body: JSON.stringify({ key: page.key, preference }) });
        await load(page.key);
      },
      async reload() {
        const key = frame.state.key ?? reference.entryKey;
        await save.discardLocal(key);
        await load(key);
      },
      showChanges,
      comparison: selectComparison,
      async recapture(submissionId: string, pageKey: string) {
        if (pageKey !== frame.state.key) throw new Error("Open this submission page before capturing its rendered content.");
        const detail = owner.getSnapshot().submissions.find((item) => item.id === submissionId)?.value;
        if (!detail?.result || !detail.submission.pageKeys.includes(pageKey)) throw new Error("Choose a handled submission and its own page.");
        const selected = comparisonRequest;
        try {
          await resultCaptures.request(captureScope(submissionId));
          if (!disposed && selected === comparisonRequest && comparisonOpen && comparison?.submissionId === submissionId &&
            comparison.pageKey === pageKey && comparison.mode === "content") await selectComparison(submissionId, pageKey, "content");
        } catch { /* The correlated result warning remains available without stealing the current view. */ }
      },
      closeComparison() { comparisonRequest++; comparisonOpen = false; if (comparison) comparison = { ...comparison, loading: false }; publish(); },
    },
    dispose,
  };
}
export type ConversationShell = ReturnType<typeof createConversationShell>;
