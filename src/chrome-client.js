/**
 * doc-review chrome. Owns the toolbar, contextual surfaces, drawer, and every
 * call to the local server.
 * It never touches the artifact DOM directly — the SDK does that, over
 * postMessage, because the artifact iframe lives on the other loopback
 * hostname: a separate origin that can never reach this page or its token.
 */
import { tidyMiddle } from "./anchor-text.js";
import {
  clearOwned,
  createCommentUi,
  migrateCommentUi,
  mutationIsCurrent,
  ownConfirmation,
  ownEdit,
  ownMenu,
  newestComments,
  pageUrl,
  reconcileCommentUi,
  replacePage,
} from "./chrome-session.js";
import { sanitizeClientRects, sanitizeClipRect, sanitizeRelation } from "./comment-target.js";
import { externalHref } from "./editing.js";
import { framePolicy } from "./frame-policy.js";
import { createIcon } from "./icons.js";
import { createComparisonView } from "./comparison-view.js";
import { createExecutionControls } from "./execution-client.js";
import { alignedCardPosition, placeContextualSurface, visibleViewport } from "./positioning.js";
import { normalizeReviewMode, reviewConfiguration } from "./review-mode.js";
import { createCaptureRequests, captureError, sameRender, draftCount, excerpt, changeKind, pendingCaptureTarget, comparisonFreshness } from "./history-client.js";
import { createCaptureCoordinator, createHistoryController, historyPresentation, requireCaptureSuccess } from "./history-coordinator.js";

import { createReviewApi, decodePage } from "./chrome-api.js";
import { createFrameHost } from "./frame-host.js";
import { createFrameController } from "./frame-controller.js";
import { createSaveController } from "./save-controller.js";
import { createFeedbackController } from "./feedback-controller.js";
import { createReviewController } from "./review-controller.js";

const $ = (id) => document.getElementById(id);
const ARTIFACT_HOST = location.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
const ARTIFACT_ORIGIN = `${location.protocol}//${ARTIFACT_HOST}:${location.port}`;
const frameHost = createFrameHost($("frame"), ARTIFACT_ORIGIN);
const uiLifetime = new AbortController();
const uiTimers = new Set();
const uiFrames = new Set();
function afterPaint(callback) {
  const id = requestAnimationFrame(() => {
    uiFrames.delete(id);
    if (!uiLifetime.signal.aborted) callback();
  });
  uiFrames.add(id);
}
function afterDelay(callback, milliseconds) {
  const id = setTimeout(() => {
    uiTimers.delete(id);
    if (!uiLifetime.signal.aborted) callback();
  }, milliseconds);
  uiTimers.add(id);
}
function listen(target, type, handler, options = {}) {
  target.addEventListener(type, handler, {
    ...(typeof options === "boolean" ? { capture: options } : options),
    signal: uiLifetime.signal,
  });
}

const state = {
  sessionId: document.body.dataset.session,
  token: document.body.dataset.token,
  page: null,
  compose: null,
  composeLifecycle: "closed",
  composePlacement: "hidden",
  target: null,
  activeSavedCommentId: null,
  activeGeometry: new Map(),
  commentUi: createCommentUi(),
  pageEpoch: 0,
  reviewMode: "view",
  savePolicy: "writable",
  modeApplying: false,
  modeMenuOpen: false,
  drawerOpen: false,
  agent: "idle",
  orphans: new Set(),
  pollCommand: "",
  editsExpanded: false,
  others: [],
  scroll: { x: 0, y: 0 },
  comparing: false,
  executionPreference: null,
  ended: false,
};

const diagnostic = (event, detail = {}) => {
  console.info("[doc-review]", { event, ...detail });
};

const patchFlights = new Map();
const deleteFlights = new Map();
let requestedFocus = null;
let editFocusRequested = false;
let skipEditCaptureOnce = false;

function advancePageEpoch(reason) {
  state.pageEpoch += 1;
  diagnostic("page-epoch-advanced", { epoch: state.pageEpoch, reason });
  return state.pageEpoch;
}

function commentById(id) {
  return state.page?.comments?.find((comment) => comment.id === id) || null;
}

function domId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `-${char.codePointAt(0).toString(16)}-`);
}

function controlId(commentId, surface, action) {
  return `comment-${surface}-${domId(commentId)}-${action}`;
}

function requestControlFocus(id) {
  requestedFocus = id;
}

function editTextarea(commentId) {
  const root = state.drawerOpen ? $("cards") : $("alignedCard");
  return root?.querySelector(`textarea[data-comment-edit="${CSS.escape(commentId)}"]`) || null;
}

function captureEditState() {
  const edit = state.commentUi.edit;
  if (!edit) return false;
  const input = editTextarea(edit.commentId);
  if (!input) return false;
  edit.draft = input.value;
  edit.selectionStart = input.selectionStart;
  edit.selectionEnd = input.selectionEnd;
  return document.activeElement === input;
}

function restoreTransientFocus(editWasFocused = false) {
  const focusId = requestedFocus;
  requestedFocus = null;
  const shouldFocusEdit = editWasFocused || editFocusRequested;
  afterPaint(() => {
    if (focusId) {
      document.getElementById(focusId)?.focus();
      return;
    }
    const edit = state.commentUi.edit;
    if (!shouldFocusEdit || !edit) return;
    const input = editTextarea(edit.commentId);
    if (!input || input.closest("[hidden]")) {
      editFocusRequested = true;
      return;
    }
    editFocusRequested = false;
    input.focus();
    input.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  });
}

function moveTransientSurface(surface) {
  const menu = state.commentUi.menu;
  if (menu) {
    menu.surface = surface;
    menu.triggerId = controlId(menu.commentId, surface, "more");
  }
  if (state.commentUi.confirmation) state.commentUi.confirmation.surface = surface;
}

function announce(message) {
  const region = $("liveRegion");
  region.textContent = "";
  afterPaint(() => {
    region.textContent = message;
  });
}

function replaceIcon(container, name, title = "") {
  container.textContent = "";
  container.append(createIcon(name, { title }));
}

function installStaticIcons() {
  document.querySelectorAll("[data-icon]").forEach((container) => {
    replaceIcon(container, container.dataset.icon);
  });
  replaceIcon($("modeChevron"), "chevronDown");
  replaceIcon($("composeClose"), "x");
  replaceIcon($("drawerClose"), "x");
}

function openModeMenu() {
  if (state.modeMenuOpen) return;
  state.modeMenuOpen = true;
  $("modeMenu").hidden = false;
  $("modeButton").setAttribute("aria-expanded", "true");
  toFrame({ type: "eh:modeMenuState", open: true });
  $("modeMenu").querySelector(`[data-mode="${state.reviewMode}"]`)?.focus();
}

function closeModeMenu(reason = "dismissed", { restoreFocus = false } = {}) {
  if (!state.modeMenuOpen) return false;
  state.modeMenuOpen = false;
  $("modeMenu").hidden = true;
  $("modeButton").setAttribute("aria-expanded", "false");
  toFrame({ type: "eh:modeMenuState", open: false });
  diagnostic("mode-menu-close", { reason });
  if (restoreFocus) $("modeButton").focus();
  return true;
}

function openDrawer() {
  captureEditState();
  skipEditCaptureOnce = true;
  state.drawerOpen = true;
  moveTransientSurface("drawer");
  editFocusRequested = !!state.commentUi.edit;
  render();
  if (!state.commentUi.edit) afterPaint(() => $("commentsSection").focus());
}

function closeDrawer() {
  if (!state.drawerOpen) return;
  captureEditState();
  skipEditCaptureOnce = true;
  state.drawerOpen = false;
  const transientOwner =
    state.commentUi.edit?.commentId ||
    state.commentUi.confirmation?.commentId ||
    state.commentUi.menu?.commentId ||
    null;
  if (transientOwner && commentById(transientOwner)) {
    state.activeSavedCommentId = transientOwner;
    moveTransientSurface("aligned");
    toFrame({ type: "eh:activate", id: transientOwner, scroll: false });
  } else if (state.activeSavedCommentId) {
    moveTransientSurface("aligned");
  }
  editFocusRequested = !!state.commentUi.edit;
  render();
  if (!state.commentUi.edit) $("commentsButton").focus();
}

function setComposeLifecycle(next, reason) {
  if (state.composeLifecycle === next) return;
  const from = state.composeLifecycle;
  state.composeLifecycle = next;
  const submitting = next === "submitting";
  $("composeCancel").disabled = submitting;
  $("composeClose").disabled = submitting;
  diagnostic("composer-lifecycle-transition", { from, to: next, reason });
}

function setComposePlacement(next) {
  if (state.composePlacement === next) return;
  const from = state.composePlacement;
  state.composePlacement = next;
  diagnostic("placement-transition", { from, to: next });
}

/**
 * Most reviewers drive an agent from a chat (Claude Code, Codex, Cursor), not
 * a bare terminal — so the handoff is a prompt the agent can act on, with the
 * poll command embedded for anyone who does live in a shell.
 */
function handoffPrompt(pollCommand) {
  const cmd = String(pollCommand || "").trim();
  if (!cmd) return "";
  return `Run \`${cmd} --timeout 600\`, apply the feedback it returns, then run its exact \`next_step\` command with \`--ack <batch_id>\` until I end the review.`;
}

// ------------------------------------------------------------------- server

const transport = createReviewApi({ token: state.token });
const api = transport.request;
const frameController = createFrameController({
  sessionId: state.sessionId, host: frameHost, request: api,
  suspended() {
    captures.cancel();
    captureCoordinator.reset();
    manualCaptureController?.abort();
  },
  transitioning() {
    reviewController.invalidate();
    if (state.compose) {
      state.compose.unresolved = true;
      state.compose.relation = "unavailable";
      state.compose.rects = [];
      state.compose.generation = -1;
    }
    state.target = null;
    state.activeGeometry.clear();
    saveController.baseline(null);
  },
  failed(message) {
    $("reloadNotice").hidden = false;
    $("reloadMessage").textContent = `${message} Reload keeps your comment drafts.`;
    toast(message);
  },
});
const saveController = createSaveController({
  sessionId: state.sessionId, current: () => frameController.identity(),
  policy: () => state.savePolicy, request: api,
  flush: (strict) => frameController.flush(strict), send: (message) => frameController.send(message),
  sourceHash: (hash) => frameController.setSourceHash(hash),
  pageChanged(page) { state.page = page; feedbackController.clearSent(); render(); },
  conflict() { holdReload(); announce("Save conflict. Edit mode remains active so you can reload safely."); },
  failed(message) { toast(message); announce("An edit could not be saved. Retry before leaving the page or sending feedback."); },
  diagnostic, sending: () => feedbackController.sending,
});
const feedbackController = createFeedbackController({
  sessionId: state.sessionId, current: () => frameController.identity(),
  sourceHash: () => frameController.state.sourceHash, save: saveController,
  policy: () => state.savePolicy, request: api,
  capture: () => captureStablePage({ timeout: 500 }), refresh: () => refreshHistory(),
  note: () => $("note").value,
  clearNote(sent) { if ($("note").value === sent) $("note").value = ""; },
  pauseCapture() {
    if ($("captureWarning")) $("captureWarning").hidden = true;
    captureCoordinator.reset();
    manualCaptureController?.abort();
  },
  resumeCapture: () => scheduleResultCapture(),
  failed(message) { toast(message); announce(message); },
  warning: toast, announce,
});
const reviewController = createReviewController({
  sessionId: state.sessionId, key: () => frameController.state.key,
  generation: () => frameController.state.generation, request: api,
  beforeRefresh: () => advancePageEpoch("acknowledgement"),
  refreshPage(page) {
    reconcilePage(page, { syncAnchors: true, reason: "acknowledgement", advance: false });
    feedbackController.clearSent();
    render();
  },
  load: async (key) => { state.scroll = { x: 0, y: 0 }; await loadPage(key); },
  reload: () => reloadLatest(), history: () => refreshHistory(),
  save: () => saveController.barrier(), suspend: () => frameController.suspend(),
  hasDrafts: () => !!draftCount(state),
  agent(value) { state.agent = value; render(); },
  ended: showEnded, failed: (error) => { toast(error.message || String(error)); },
});
reviewController.own(frameController.subscribe(renderExecution));
reviewController.own(saveController.subscribe(renderSave));
reviewController.own(feedbackController.subscribe(render));
reviewController.own(() => uiLifetime.abort());
reviewController.own(() => {
  for (const id of uiTimers) clearTimeout(id);
  for (const id of uiFrames) cancelAnimationFrame(id);
  uiTimers.clear();
  uiFrames.clear();
});
reviewController.own(() => frameController.dispose());
reviewController.own(() => saveController.dispose());
reviewController.own(() => feedbackController.dispose());
reviewController.own(() => transport.dispose());

const executionControls = createExecutionControls({
  api,
  sessionId: state.sessionId,
  elements: {
    static: $("executionStatic"), auto: $("executionAuto"), status: $("executionStatus"),
    details: $("executionDetails"), menu: $("reviewDetails"),
    editDescription: $("modeMenu").querySelector('[data-mode="edit"] small'),
  },
  changed(page) {
    if (!page || page.key !== frameController.state.key) return;
    state.executionPreference = page.executionPreference || null;
    state.page = {
      ...state.page,
      executionPreference: page.executionPreference,
      ...frameController.state.execution,
    };
    state.savePolicy = reviewConfiguration(state.page, state.reviewMode).savePolicy;
    render();
  },
  failed(error) { toast(error.message || String(error)); },
});

const toolbar = document.querySelector(".toolbar");
const toolbarObserver = new ResizeObserver(() => {
  document.documentElement.style.setProperty("--toolbar-h", `${toolbar.getBoundingClientRect().height}px`);
});
toolbarObserver.observe(toolbar);
reviewController.own(() => toolbarObserver.disconnect());

function renderExecution() {
  executionControls.render(state.page, frameHost.visibleExecution, {
    pendingReload: frameController.state.pendingReload || !!frameHost.previous,
    loading: frameController.loading,
    error: frameController.state.phase.kind === "failed" ? frameController.state.phase.message : null,
  });
}

const persistEdit = (key, payload) => saveController.persistEdit(key, payload);
const settleEditPersistence = (key) => saveController.settleEdits(key);

function reconcilePage(page, { syncAnchors = false, reason = "mutation", advance = reason !== "mutation" } = {}) {
  const previousIds = new Set((state.page?.comments || []).map((comment) => comment.id));
  if (advance) advancePageEpoch(reason);
  replacePage(state, page);
  const commentIds = new Set((page.comments || []).map((comment) => comment.id));
  for (const id of state.activeGeometry.keys()) {
    if (!commentIds.has(id)) state.activeGeometry.delete(id);
  }
  if (state.activeSavedCommentId && !commentIds.has(state.activeSavedCommentId)) {
    state.activeSavedCommentId = null;
  }
  const removedTransient = reconcileCommentUi(state.commentUi, page.comments || []);
  state.orphans = new Set([...state.orphans].filter((id) => commentIds.has(id)));
  if (syncAnchors && !frameController.loading) {
    toFrame({ type: "eh:anchors", comments: page.comments || [] });
  }
  if (reason === "acknowledgement") {
    const removed = [...previousIds].filter((id) => !commentIds.has(id));
    if (removed.length) {
      announce(`${removed.length === 1 ? "Comment" : "Comments"} delivered and removed`);
      if (removedTransient.size) afterPaint(() => (state.drawerOpen ? $("commentsSection") : frameHost.current).focus());
    }
  }
  diagnostic("page-reconciled", { reason, epoch: state.pageEpoch });
}

const toFrame = (message) => frameController.send(message);
function beginFrameTransition(key = frameController.state.key) {
  return frameController.begin(key);
}
const registerFrame = (key, generation) => frameController.register(key, generation);
const failFrame = (message) => frameController.fail(message);
const flushFrame = ({ strict = false } = {}) => saveController.flush(strict);
function configureFrame() {
  if (!frameController.state.execution) return Promise.resolve(false);
  Object.assign(state.page, frameController.state.execution);
  const configuration = reviewConfiguration(state.page, state.reviewMode);
  state.savePolicy = configuration.savePolicy;
  return frameController.configure(configuration.mode, configuration.savePolicy);
}

async function setReviewMode(nextMode) {
  const next = normalizeReviewMode(nextMode);
  closeModeMenu("selection");
  if (next === state.reviewMode || state.modeApplying) return;
  state.modeApplying = true;
  render();
  try {
    if (state.reviewMode === "edit" && next === "view") {
      await fullSaveBarrier();
      if (saveController.state.conflict) {
        toast("Resolve the save conflict before leaving Edit");
        announce("Save conflict. Edit mode remains active.");
        return;
      }
    }
    state.reviewMode = next;
    const applied = await configureFrame();
    if (!applied) throw new Error("The reviewed page did not confirm the mode change");
    diagnostic("mode-change", { mode: next, savePolicy: state.savePolicy });
    announce(`${next === "edit" ? "Edit" : "View"} mode active`);
  } catch (err) {
    state.reviewMode = next === "edit" ? "view" : "edit";
    toast(`${err.message}. Stay in ${state.reviewMode === "edit" ? "Edit" : "View"} and retry.`);
  } finally {
    state.modeApplying = false;
    render();
  }
}

async function loadPage(key, { reload = true } = {}) {
  const returning = state.page;
  advancePageEpoch(returning ? "navigation" : "reload");
  const generation = beginFrameTransition(key);
  frameController.resetRetries();
  const page = await api(pageUrl(key, state.sessionId), undefined, decodePage);
  if (frameController.state.key !== key || frameController.state.generation !== generation) return;
  state.executionPreference = page.executionPreference || null;
  reconcilePage(page, { reason: "reload", advance: false });
  state.savePolicy = reviewConfiguration(state.page, state.reviewMode).savePolicy;
  frameController.setPolicy(framePolicy(state.page, ARTIFACT_ORIGIN));
  state.orphans = new Set();
  state.compose = null;
  setComposeLifecycle("closed", "page-change");
  setComposePlacement("hidden");
  state.target = null;
  state.activeSavedCommentId = null;
  state.activeGeometry.clear();
  state.commentUi = createCommentUi();
  feedbackController.clearSent();
  saveController.reset();
  if (reload) {
    frameController.startReload();
    await registerFrame(key, generation);
  }
  render();
  // Coming back to a dev-server page shows the app's own copy again, without
  // the direct edits — which reads as data loss unless we say what happened.
  const edits = state.page.edits ? state.page.edits.length : 0;
  if (returning && state.page.feedbackOnly && edits > 0) {
    toast(`${edits} ${edits === 1 ? "edit is" : "edits are"} queued for the agent to apply to the source`);
  }
}

// -------------------------------------------------------------------- clock

function ago(ts) {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

// -------------------------------------------------------------------- render

function render() {
  if (state.ended) return;
  const page = state.page;
  if (!page) return;
  // Source updates cannot change the policy of a frame awaiting draft-safe reload.
  if (frameController.state.execution) Object.assign(page, frameController.state.execution);
  if (state.executionPreference) page.executionPreference = state.executionPreference;
  renderExecution();
  syncFrameInteraction();
  const editWasFocused = skipEditCaptureOnce ? false : captureEditState();
  skipEditCaptureOnce = false;
  document.title = page.filename || 'doc-review';

  const comments = newestComments(page.comments);
  const edits = page.edits || [];

  $("count").textContent = String(comments.length);
  $("toolbarCount").textContent = String(comments.length);
  $("empty").hidden = comments.length > 0 || !!state.compose;
  $("modeLabel").textContent = state.reviewMode === "edit" ? "Edit" : "View";
  replaceIcon($("modeIcon"), state.reviewMode === "edit" ? "pencil" : "eye");
  $("modeButton").disabled = state.modeApplying || state.comparing || feedbackController.sending || !frameController.state.execution;
  for (const item of $("modeMenu").querySelectorAll("[data-mode]")) {
    const checked = item.dataset.mode === state.reviewMode;
    item.setAttribute("aria-checked", String(checked));
    const check = item.querySelector(".menu-check");
    check.textContent = "";
    if (checked) check.append(createIcon("check"));
  }
  $("drawer").classList.toggle("open", state.drawerOpen);
  $("drawer").setAttribute("aria-hidden", String(!state.drawerOpen));
  $("commentsButton").setAttribute("aria-expanded", String(state.drawerOpen));
  $("drawerBackdrop").hidden = !state.drawerOpen;

  // --- compose
  const composeWrap = $("compose");
  if (state.compose) {
    composeWrap.hidden = false;
    $("composeKind").textContent = state.compose.kind === "element" ? "Element" : "Selection";
    $("composeQuote").textContent = tidyMiddle(state.compose.quote, 260);
    afterPaint(positionCompose);
  } else {
    composeWrap.hidden = true;
    $("composeText").value = "";
    $("composeError").hidden = true;
  }

  // --- comment cards
  const list = $("cards");
  list.textContent = "";
  for (const comment of comments) {
    list.append(renderCommentCard(comment, "drawer"));
  }
  renderAlignedCard(comments);

  // --- your edits
  const box = $("editsBox");
  box.hidden = edits.length === 0;
  if (edits.length) {
    $("editCount").textContent = String(edits.length);
    const rows = $("editList");
    rows.textContent = "";
    const LIMIT = 5;
    const shown = state.editsExpanded ? edits : edits.slice(0, LIMIT);
    for (const edit of shown) {
      const row = document.createElement("div");
      row.className = `edit-row${edit.kind === "deleted" ? " deleted" : ""}`;
      const pip = document.createElement("span");
      pip.className = "pip";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = edit.label;
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = edit.kind;
      row.append(pip, label, kind);
      rows.append(row);
    }
    if (edits.length > LIMIT) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "edit-more";
      more.textContent = state.editsExpanded ? "Show fewer" : `${edits.length - LIMIT} more…`;
      more.addEventListener("click", () => {
        state.editsExpanded = !state.editsExpanded;
        render();
      });
      rows.append(more);
    }
    renderSave();
  }

  // --- pages you left feedback on but are not looking at
  const others = state.others || [];
  const othersBox = $("othersBox");
  othersBox.hidden = others.length === 0;
  if (others.length) {
    $("othersCount").textContent = String(others.length);
    const list = $("othersList");
    list.textContent = "";
    for (const other of others) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "edit-row other-row";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = other.filename;
      const count = document.createElement("span");
      count.className = "kind";
      count.textContent = String(other.count);
      row.append(label, count);
      row.addEventListener("click", async () => {
        try {
          await reviewController.navigate({ key: other.key });
        } catch (err) {
          toast(`${err.message}. Stay on this page and retry.`);
        }
      });
      list.append(row);
    }
  }

  // --- send
  const otherTotal = others.reduce((sum, o) => sum + o.count, 0);
  const total = comments.length + edits.length + otherTotal;
  // An overall note is sendable on its own — the server already accepts
  // note-only batches; the button must not stay dead while one is typed.
  const hasNote = $("note").value.trim().length > 0;
  const send = $("send");
  const delivered = state.agent === "working";
  const stranded = state.agent === "stranded";
  const busy = delivered || stranded || feedbackController.sent;
  send.disabled = (total === 0 && !hasNote) || busy || feedbackController.sending;
  send.textContent = feedbackController.sending ? "Sending feedback…" : delivered
    ? "Feedback delivered"
    : stranded
      ? "Sent — agent is not listening"
      : feedbackController.sent
        ? "Sent — waiting for agent"
        : total
          ? `Send ${total} to agent`
          : hasNote
            ? "Send note to agent"
            : "Nothing to send yet";
  // After sending, say what happens next. If nothing is polling, the loop would
  // otherwise dead-end silently, so hand over the exact command to run.
  $("agentLine").hidden = !delivered;
  $("agentText").textContent = "Feedback delivered — page reloads when fixes land";

  // Server-authoritative, so it survives a browser refresh.
  $("handoff").hidden = !stranded;
  if (stranded) $("handoffCmd").textContent = handoffPrompt(state.pollCommand || page.pollCommand);
  const excluded = draftCount(state);
  $("draftWarning").hidden = excluded === 0;
  $("draftWarning").textContent = `${excluded} open ${excluded === 1 ? "draft is" : "drafts are"} not included. Save comments explicitly before sending.`;
  restoreTransientFocus(editWasFocused);
}

function positionCompose() {
  if (!state.compose || state.composeLifecycle === "closed") {
    setComposePlacement("hidden");
    return;
  }
  if (state.compose.unresolved) {
    const surface = $("compose");
    surface.hidden = false;
    surface.classList.add("sheet");
    surface.classList.remove("edge-top", "edge-bottom");
    $("composeDirection").hidden = true;
    setComposePlacement("sheet");
    return;
  }
  const viewport = visibleViewport();
  const frameRect = frameHost.current.getBoundingClientRect();
  const surface = $("compose");
  if (state.compose.relation !== "unavailable") surface.hidden = false;
  const placement = placeContextualSurface(state.compose, {
    frameRect,
    viewport,
    surfaceWidth: Math.min(340, viewport.width - 24),
    surfaceHeight: Math.max(190, surface.offsetHeight),
    narrow: matchMedia("(max-width: 720px)").matches,
    toolbarHeight: document.querySelector(".toolbar").getBoundingClientRect().height,
  });
  surface.classList.toggle("sheet", placement.kind === "sheet");
  surface.classList.toggle("edge-top", placement.kind === "edge-top");
  surface.classList.toggle("edge-bottom", placement.kind === "edge-bottom");
  setComposePlacement(placement.kind);
  const edge = placement.kind === "edge-top" || placement.kind === "edge-bottom";
  $("composeDirection").hidden = !edge;
  $("composeDirectionText").textContent = placement.kind === "edge-top"
    ? "Selection is above"
    : placement.kind === "edge-bottom"
      ? "Selection is below"
      : "";
  surface.hidden = placement.kind === "hidden";
  if (placement.kind !== "sheet" && placement.kind !== "hidden") {
    surface.style.left = `${placement.left}px`;
    surface.style.top = `${placement.top}px`;
    surface.style.width = `${placement.width}px`;
  } else {
    surface.style.left = "";
    surface.style.top = "";
    surface.style.width = "";
  }
}

function makeAction(label, className = "card-action") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}

function makeWho(comment, surface) {
  const who = document.createElement("span");
  who.className = "who";
  who.append("You");
  if (surface === "drawer") {
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "·";
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = ago(comment.updatedAt || comment.createdAt);
    who.append(sep, when);
  }
  if (comment.correction) {
    const badge = document.createElement("span");
    badge.className = "badge correction";
    badge.textContent = "correction";
    who.append(badge);
  } else if (comment.updatedAt) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "edited";
    who.append(badge);
  }
  if (state.orphans.has(comment.id)) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "orphaned";
    who.append(badge);
  }
  return who;
}

function commentUiKind(commentId) {
  if (state.commentUi.edit?.commentId === commentId) return "edit";
  if (state.commentUi.confirmation?.commentId === commentId) return "confirmation";
  if (state.commentUi.menu?.commentId === commentId) return "menu";
  return "normal";
}

function renderMore(comment, surface, open, disabled = false) {
  const triggerId = controlId(comment.id, surface, "more");
  const menuId = controlId(comment.id, surface, "menu");
  const trigger = makeAction("More", "card-action more-trigger");
  trigger.id = triggerId;
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", String(open));
  trigger.setAttribute("aria-controls", menuId);
  trigger.disabled = disabled;
  trigger.prepend(createIcon("moreHorizontal", { size: 14 }));
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    if (open) {
      closeCommentMenu({ restoreFocus: true });
    } else {
      if (!ownMenu(state.commentUi, comment.id, surface, triggerId)) {
        focusCurrentCommentEdit();
        return;
      }
      toFrame({ type: "eh:modeMenuState", open: true });
      requestControlFocus(controlId(comment.id, surface, "delete-item"));
      render();
    }
  });
  return trigger;
}

function renderCommentCard(comment, surface) {
  const card = document.createElement(surface === "aligned" ? "article" : "div");
  if (surface === "drawer") {
    card.className = `comment${state.activeSavedCommentId === comment.id ? " active" : ""}`;
  }
  card.dataset.id = comment.id;
  card.dataset.surface = surface;

  const kind = commentUiKind(comment.id);
  const editOwnedElsewhere = !!(
    state.commentUi.edit &&
    state.commentUi.edit.commentId !== comment.id
  );
  const head = document.createElement("div");
  head.className = "comment-head";
  head.append(makeWho(comment, surface));

  if (kind === "normal") {
    if (surface === "drawer") {
      const jump = makeAction("Jump to");
      jump.disabled = editOwnedElsewhere;
      jump.addEventListener("click", (event) => {
        event.stopPropagation();
        setActive(comment.id, true);
      });
      head.append(jump);
    }
    const edit = makeAction("Edit");
    edit.id = controlId(comment.id, surface, "edit");
    edit.setAttribute("aria-label", "Edit comment");
    edit.disabled = editOwnedElsewhere;
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      startCommentEdit(comment, surface);
    });
    head.append(edit);
    if (surface === "aligned") {
      const close = makeAction("Close");
      close.setAttribute("aria-label", "Close comment card");
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        dismissActiveComment("close", { restoreFocus: true });
      });
      head.append(close);
    }
    head.append(renderMore(comment, surface, false, editOwnedElsewhere));
  } else if (kind === "menu") {
    head.append(renderMore(comment, surface, true));
  }

  const quote = document.createElement("p");
  quote.className = "quote";
  quote.textContent = tidyMiddle(comment.quote, 140);
  card.append(head, quote);

  if (kind === "edit") {
    const edit = state.commentUi.edit;
    const input = document.createElement("textarea");
    input.className = "body-edit";
    input.rows = 3;
    input.value = edit.draft;
    input.readOnly = edit.status === "saving";
    input.dataset.commentEdit = comment.id;
    input.setAttribute("aria-label", "Edit comment text");
    input.addEventListener("input", () => {
      edit.draft = input.value;
      edit.selectionStart = input.selectionStart;
      edit.selectionEnd = input.selectionEnd;
      edit.validation = "";
    });
    const rememberSelection = () => {
      edit.selectionStart = input.selectionStart;
      edit.selectionEnd = input.selectionEnd;
    };
    input.addEventListener("select", rememberSelection);
    input.addEventListener("keyup", rememberSelection);
    input.addEventListener("click", (event) => {
      event.stopPropagation();
      rememberSelection();
    });
    input.addEventListener("compositionstart", () => {
      edit.composing = true;
    });
    input.addEventListener("compositionend", () => {
      edit.composing = false;
      rememberSelection();
    });
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      rememberSelection();
      if (event.key === "Enter" && !event.shiftKey) {
        if (edit.composing || event.isComposing) return;
        event.preventDefault();
        void saveCommentEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelCommentEdit();
      }
    });
    card.append(input);

    const helper = document.createElement("p");
    helper.className = "edit-help";
    helper.textContent = "Enter to save · Shift+Enter for new line";
    card.append(helper);
    if (edit.validation) {
      const validation = document.createElement("p");
      validation.className = "comment-validation";
      validation.setAttribute("role", "alert");
      validation.textContent = edit.validation;
      card.append(validation);
    }
    const actions = document.createElement("div");
    actions.className = "comment-edit-actions";
    const save = makeAction(edit.status === "saving" ? "Saving…" : "Save", "btn-primary");
    save.disabled = edit.status === "saving";
    save.addEventListener("click", (event) => {
      event.stopPropagation();
      void saveCommentEdit();
    });
    const cancel = makeAction("Cancel", "btn-ghost");
    cancel.disabled = edit.status === "saving";
    cancel.addEventListener("click", (event) => {
      event.stopPropagation();
      cancelCommentEdit();
    });
    actions.append(save, cancel);
    card.append(actions);
  } else if (kind === "confirmation") {
    const confirmation = state.commentUi.confirmation;
    const prompt = document.createElement("p");
    prompt.className = "delete-prompt";
    prompt.textContent = "Delete this comment?";
    const actions = document.createElement("div");
    actions.className = "delete-actions";
    const cancel = makeAction("Cancel", "btn-ghost");
    cancel.disabled = confirmation.status === "deleting";
    cancel.addEventListener("click", (event) => {
      event.stopPropagation();
      cancelDeleteConfirmation();
    });
    const remove = makeAction(confirmation.status === "deleting" ? "Deleting…" : "Delete", "btn-danger");
    remove.id = controlId(comment.id, surface, "confirm-delete");
    remove.disabled = confirmation.status === "deleting";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteComment(comment.id);
    });
    actions.append(cancel, remove);
    card.append(prompt, actions);
  } else {
    const body = document.createElement("p");
    body.className = "body";
    body.textContent = comment.feedback;
    body.title = "Click to edit";
    if (!editOwnedElsewhere) {
      body.addEventListener("click", (event) => {
        event.stopPropagation();
        startCommentEdit(comment, surface);
      });
    }
    card.append(body);
  }

  if (kind === "menu") {
    const menu = document.createElement("div");
    menu.id = controlId(comment.id, surface, "menu");
    menu.className = "comment-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-labelledby", controlId(comment.id, surface, "more"));
    const remove = makeAction("Delete", "comment-menu-item");
    remove.id = controlId(comment.id, surface, "delete-item");
    remove.setAttribute("role", "menuitem");
    remove.prepend(createIcon("trash", { size: 14 }));
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      toFrame({ type: "eh:modeMenuState", open: false });
      if (!ownConfirmation(state.commentUi, comment.id, surface)) {
        focusCurrentCommentEdit();
        return;
      }
      requestControlFocus(controlId(comment.id, surface, "confirm-delete"));
      render();
    });
    menu.append(remove);
    card.append(menu);
  }

  if (surface === "drawer") {
    card.addEventListener("click", () => {
      if (kind === "normal" && !editOwnedElsewhere) setActive(comment.id, false);
    });
  }
  return card;
}

function positionAlignedCard() {
  const host = $("alignedCard");
  const comment = commentById(state.activeSavedCommentId);
  const geometry = comment ? state.activeGeometry.get(comment.id) : null;
  if (!comment || state.drawerOpen || matchMedia("(max-width: 720px)").matches || !geometry?.visible) {
    host.hidden = true;
    return false;
  }
  const viewport = visibleViewport();
  const position = alignedCardPosition(geometry.rects, {
    frameRect: frameHost.current.getBoundingClientRect(),
    viewport,
  });
  if (!position) {
    host.hidden = true;
    return false;
  }
  host.style.left = `${position.left}px`;
  host.style.top = `${position.top}px`;
  host.hidden = false;
  return true;
}

function renderAlignedCard(comments) {
  const host = $("alignedCard");
  host.textContent = "";
  const comment = comments.find((item) => item.id === state.activeSavedCommentId);
  if (!comment) {
    host.hidden = true;
    return;
  }
  const card = renderCommentCard(comment, "aligned");
  while (card.firstChild) host.append(card.firstChild);
  positionAlignedCard();
}

async function deleteComment(id) {
  if (deleteFlights.has(id)) return deleteFlights.get(id);
  const confirmation = state.commentUi.confirmation;
  if (!confirmation || confirmation.commentId !== id || confirmation.status === "deleting") return false;
  confirmation.status = "deleting";
  render();
  const startEpoch = state.pageEpoch;
  const flight = (async () => {
    try {
      const result = await api(`/api/page/${frameController.state.key}/comment/${id}`, { method: "DELETE" });
      if (!mutationIsCurrent(startEpoch, state.pageEpoch, state.page?.comments, id)) return false;
      reconcilePage(result.page, { reason: "mutation" });
      toFrame({ type: "eh:remove", id });
      state.activeGeometry.delete(id);
      if (state.activeSavedCommentId === id) state.activeSavedCommentId = null;
      render();
      return true;
    } catch (err) {
      if (mutationIsCurrent(startEpoch, state.pageEpoch, state.page?.comments, id)) {
        if (state.commentUi.confirmation?.commentId === id) state.commentUi.confirmation.status = "idle";
        toast(err.message);
        render();
      }
      return false;
    }
  })().finally(() => {
    if (deleteFlights.get(id) === flight) deleteFlights.delete(id);
  });
  deleteFlights.set(id, flight);
  return flight;
}

function cancelDeleteConfirmation() {
  const confirmation = state.commentUi.confirmation;
  if (!confirmation || confirmation.status === "deleting") return false;
  const triggerId = controlId(confirmation.commentId, confirmation.surface, "more");
  clearOwned(state.commentUi, "confirmation");
  requestControlFocus(triggerId);
  render();
  return true;
}

function startCommentEdit(comment, surface) {
  if (!ownEdit(state.commentUi, comment, surface)) {
    focusCurrentCommentEdit();
    return false;
  }
  editFocusRequested = true;
  render();
  return true;
}

function focusCurrentCommentEdit() {
  editFocusRequested = true;
  announce("Save or cancel the current comment edit first");
  afterPaint(() => {
    const edit = state.commentUi.edit;
    editTextarea(edit?.commentId)?.focus();
  });
}

function cancelCommentEdit() {
  const edit = state.commentUi.edit;
  if (!edit || edit.status === "saving") return false;
  const surface = state.drawerOpen ? "drawer" : edit.originSurface;
  const focusId = controlId(edit.commentId, surface, "edit");
  clearOwned(state.commentUi, "edit");
  requestControlFocus(focusId);
  render();
  return true;
}

function saveCommentEdit() {
  const edit = state.commentUi.edit;
  if (!edit || edit.status === "saving") return edit ? patchFlights.get(edit.commentId) : false;
  captureEditState();
  const feedback = edit.draft.trim();
  if (!feedback) {
    edit.validation = "Comment text is required.";
    editFocusRequested = true;
    render();
    return false;
  }
  if (feedback === edit.original) {
    clearOwned(state.commentUi, "edit");
    requestControlFocus(controlId(edit.commentId, state.drawerOpen ? "drawer" : edit.originSurface, "edit"));
    render();
    return true;
  }
  if (patchFlights.has(edit.commentId)) return patchFlights.get(edit.commentId);
  edit.status = "saving";
  edit.validation = "";
  const id = edit.commentId;
  const startEpoch = state.pageEpoch;
  editFocusRequested = true;
  render();
  const flight = executeCommentPatch({ ...edit, draft: feedback }, startEpoch).finally(() => {
    if (patchFlights.get(id) === flight) patchFlights.delete(id);
  });
  patchFlights.set(id, flight);
  return flight;
}

async function executeCommentPatch(edit, startEpoch) {
  const id = edit.commentId;
  try {
    const commentIndex = state.page.comments.findIndex((item) => item.id === id);
    const previousGeometry = state.activeGeometry.get(id);
    const wasOrphaned = state.orphans.has(id);
    const remainsActive = state.activeSavedCommentId === id;
    const result = await api(`/api/page/${frameController.state.key}/comment/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ feedback: edit.draft }),
    });
    if (!mutationIsCurrent(startEpoch, state.pageEpoch, state.page?.comments, id)) return false;
    const replacement = commentIndex >= 0 ? result.page.comments[commentIndex] : null;
    if (replacement && replacement.id !== id) {
      migrateCommentUi(state.commentUi, id, replacement.id);
      if (remainsActive && previousGeometry) state.activeGeometry.set(replacement.id, previousGeometry);
      if (remainsActive) state.activeSavedCommentId = replacement.id;
      if (wasOrphaned) state.orphans.add(replacement.id);
    }
    reconcilePage(result.page, { reason: "mutation" });
    clearOwned(state.commentUi, "edit");
    if (result.delivery === "updated-pending") {
      toast("Updated the feedback waiting for your agent");
    } else if (result.delivery === "correction") {
      feedbackController.clearSent();
      toFrame({ type: "eh:remove", id });
      toFrame({ type: "eh:anchors", comments: state.page.comments });
      if (remainsActive && replacement) toFrame({ type: "eh:activate", id: replacement.id, scroll: false });
      toast("Saved as a correction — send it after the current batch is acknowledged");
    } else {
      feedbackController.clearSent();
    }
    render();
    return true;
  } catch (err) {
    if (mutationIsCurrent(startEpoch, state.pageEpoch, state.page?.comments, id)) {
      const current = state.commentUi.edit;
      if (current?.commentId === id) {
        current.status = "idle";
        current.validation = "";
        editFocusRequested = true;
      }
      toast(err.message);
      render();
    }
    return false;
  }
}

function renderSave() {
  const line = $("saveLine");
  if (saveController.state.conflict) {
    line.className = "save-line failed";
    $("saveText").textContent = "Source changed — reload latest before saving. Your page edits remain in this tab.";
    return;
  }
  if (state.page && state.page.kind === "url") {
    line.className = "save-line dynamic";
    $("saveText").textContent = "Localhost page — your direct edits go to the agent for source updates";
    return;
  }
  if (state.page && state.page.markdown) {
    line.className = "save-line dynamic";
    $("saveText").textContent = "Markdown source — edits go to the agent as feedback";
    return;
  }
  if (saveController.state.dynamic) {
    // The page's own scripts render it, so writing the live DOM back would
    // corrupt the file. Edits still reach the agent as feedback.
    line.className = "save-line dynamic";
    $("saveText").textContent = "Live page — edits go to the agent, the file is left alone";
    return;
  }
  line.className = `save-line ${saveController.state.status === "saving" ? "saving" : saveController.state.status === "failed" ? "failed" : ""}`;
  const name = state.page ? state.page.filename : "";
  if (saveController.state.status === "saving") $("saveText").textContent = `Saving to ${name}…`;
  else if (saveController.state.status === "failed") $("saveText").textContent = "Couldn't save — retry before sending";
  else $("saveText").textContent = saveController.state.savedAt ? `Saved to ${name} · ${saveController.state.savedAt}` : `Saved to ${name}`;
}

function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.append(el);
  afterDelay(() => el.remove(), 3200);
}

function setActive(id, scroll) {
  state.activeSavedCommentId = id;
  toFrame({ type: "eh:activate", id, scroll: !!scroll });
  render();
}

function dismissActiveComment(reason, { restoreFocus = false } = {}) {
  const id = state.activeSavedCommentId;
  if (!id) return false;
  state.activeSavedCommentId = null;
  state.activeGeometry.delete(id);
  toFrame({ type: "eh:deactivateComment" });
  render();
  announce("Comment card closed");
  diagnostic("saved-card-deactivated", { reason });
  if (restoreFocus) frameHost.current.focus();
  return true;
}

// ------------------------------------------------------------------ compose

async function openCompose(detail) {
  if (state.compose && state.compose.generation === detail.generation) {
    if (state.composeLifecycle === "closed") setComposeLifecycle("open", "accepted");
    $("composeText").focus();
    return true;
  }
  if (state.compose && $("composeText").value.trim()) {
    const submitted = await commitCompose();
    if (!submitted) {
      diagnostic("comment-retarget-blocked", { reason: "submit-failed" });
      return false;
    }
  } else if (state.compose) {
    cancelCompose({ restoreFocus: false, preserveRetarget: true });
  }
  dismissActiveComment("composer-open");
  state.compose = detail;
  setComposeLifecycle("open", "accepted");
  $("composeText").value = "";
  $("composeError").hidden = true;
  $("composeAddLabel").textContent = "Comment";
  render();
  afterPaint(() => {
    positionCompose();
    $("composeText").focus();
  });
  announce(`Comment dialog opened for ${detail.kind === "element" ? "element" : "selected text"}`);
  return true;
}

function cancelCompose({ restoreFocus = true, preserveRetarget = false } = {}) {
  if (!state.compose || state.composeLifecycle === "submitting") return false;
  const generation = state.compose.generation;
  const discardThroughGeneration = Math.max(
    generation,
    Number(state.compose.rejectedTargetGeneration) || generation
  );
  state.compose = null;
  setComposeLifecycle("closed", "cancel");
  setComposePlacement("hidden");
  toFrame({
    type: "eh:cancel",
    targetGeneration: generation,
    discardThroughGeneration,
    restoreFocus,
    preserveRetarget,
  });
  render();
  return true;
}

let composeSubmitPromise = null;
function commitCompose() {
  if (composeSubmitPromise) {
    diagnostic("comment-submit-suppressed", { reason: "in-flight" });
    return composeSubmitPromise;
  }
  composeSubmitPromise = executeComposeSubmit().finally(() => {
    composeSubmitPromise = null;
  });
  return composeSubmitPromise;
}

async function executeComposeSubmit() {
  const compose = state.compose;
  const feedback = $("composeText").value.trim();
  if (!compose || !feedback) return false;
  const button = $("composeAdd");
  button.disabled = true;
  setComposeLifecycle("submitting", "submit");
  diagnostic("comment-submit-executed");
  $("composeError").hidden = true;
  try {
    const result = await api(`/api/page/${frameController.state.key}/comment`, {
      method: "POST",
      body: JSON.stringify({ kind: compose.kind, quote: compose.quote, anchor: compose.unresolved ? null : compose.anchor, feedback }),
    });
    toFrame({
      type: "eh:commit",
      id: result.comment.id,
      targetGeneration: compose.generation,
      restoreFocus: true,
    });
    state.compose = null;
    setComposeLifecycle("closed", "submitted");
    setComposePlacement("hidden");
    state.page = result.page;
    feedbackController.clearSent();
    render();
    announce("Comment added");
    return true;
  } catch (err) {
    $("composeError").textContent = `${err.message}. Retry or cancel.`;
    $("composeError").hidden = false;
    $("composeAddLabel").textContent = "Retry";
    diagnostic("comment-request-failure", { status: err.status || 0 });
    announce("Comment could not be saved. Your draft is still here.");
    setComposeLifecycle("open", "submit-failed");
    $("compose").classList.remove("pass-through");
    afterPaint(() => $("composeText").focus());
    return false;
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------ review history

const currentRender = () => frameController.identity();
const captures = createCaptureRequests({ send: toFrame, current: currentRender });
const comparisonView = createComparisonView($("changeDetail"));
const historyUrl = (suffix = "") => `/api/session/${state.sessionId}/history${suffix}`;
const historyController = createHistoryController({
  request: (suffix) => api(historyUrl(suffix)), changed: renderHistory, refreshed: scheduleResultCapture,
});
const history = historyController.state;
let manualCaptureController = null;
const captureCoordinator = createCaptureCoordinator({
  ready: () => !state.ended && !frameController.loading && !frameController.state.pendingReload && !saveController.state.dirty &&
    !saveController.state.conflict && !feedbackController.sending && !history.captureBusy && !history.finalizing &&
    (state.page?.kind === "url" || !!saveController.state.baseHash),
  candidates: () => [...history.rounds].reverse().flatMap((round) => {
    const target = pendingCaptureTarget(round, frameController.state.key, frameController.state.readyAt);
    return target ? [{ id: `${roundId(round)}:${frameController.state.renderId}:${frameController.state.generation}`, round, target }] : [];
  }),
  capture: ({ round, target }, signal) => captureResult(round, target, true, signal),
});

const fullSaveBarrier = () => saveController.barrier();
const captureStablePage = (options) => saveController.captureStable(() => captures.request(options), options?.signal);

function syncFrameInteraction() {
  frameHost.current.inert = state.comparing || feedbackController.sending;
}

function roundId(round) { return round?.id || round?.roundId; }
function roundTargets(round) { return round?.targets || []; }
function selectedTarget() {
  const targets = roundTargets(history.round);
  return targets.find((target) => target.key === history.targetKey) || targets[0] || null;
}
function targetComparison(target) { return target?.comparison || {}; }
function comparisonItems() {
  const comparison = targetComparison(selectedTarget());
  const value = history.mode === "source" ? comparison.source : comparison.content;
  return value?.changes || value?.items || (history.mode === "content" ? comparison.changes || comparison.items : []) || [];
}

const refreshHistory = () => state.ended ? Promise.resolve(false) : historyController.refresh();

function renderHistory() {
  if (state.ended) return;
  syncFrameInteraction();
  const focusedMode = document.activeElement?.dataset.comparisonMode;
  const picker = $("roundPicker");
  picker.replaceChildren();
  for (const [index, round] of history.rounds.entries()) {
    const option = document.createElement("option");
    option.value = roundId(round);
    option.textContent = `Round ${round.ordinal || round.number || history.rounds.length - index} · ${round.captureStatus === "ready" ? "completed" : round.captureStatus || round.status || round.feedbackStatus || "pending"}`;
    picker.append(option);
  }
  picker.value = history.selectedId || "";
  picker.disabled = !history.rounds.length;
  const targets = roundTargets(history.round);
  const target = selectedTarget();
  if (history.round) history.targetKey = target?.key || null;
  $("historyTarget").replaceChildren();
  for (const item of targets) {
    const option = document.createElement("option");
    option.value = item.key;
    option.textContent = item.filename || item.label || item.key;
    $("historyTarget").append(option);
  }
  $("historyTarget").value = history.targetKey || "";
  $("historyTargetLabel").hidden = targets.length < 2;
  const comparison = targetComparison(target);
  const failedCapture = history.failures.get(`${roundId(history.round)}:${target?.key}`);
  const presentation = historyPresentation({ ...history, target, comparison, failure: failedCapture });
  const modes = presentation.modes;
  history.mode = modes.includes(history.preferredMode) ? history.preferredMode : modes[0] || "content";
  const displayedComparison = comparison[history.mode] || {};
  $("historyUnavailable").replaceChildren();
  for (const mode of ["content", "source"]) {
    const representation = comparison[mode];
    if (representation && representation.available === false) {
      const reason = document.createElement("p");
      reason.textContent = `${mode === "content" ? "Content" : "Source"} comparison unavailable: ${representation.reason || "This representation could not be compared."}`;
      $("historyUnavailable").append(reason);
    }
  }
  $("historyUnavailable").hidden = !$("historyUnavailable").childElementCount;
  $("historyTiming").replaceChildren();
  for (const [label, timestamp] of [
    ["Before captured", displayedComparison.beforeCapturedAt],
    ["Agent acknowledged", history.round?.acknowledgedAt],
    ["After captured", displayedComparison.afterCapturedAt],
  ]) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const value = document.createElement("dd");
    const date = timestamp == null ? null : new Date(timestamp);
    value.textContent = date && Number.isFinite(date.getTime()) ? date.toLocaleString() : "Not available";
    row.append(term, value);
    $("historyTiming").append(row);
  }
  $("historyTiming").hidden = !history.round;
  const afterAt = displayedComparison.afterCapturedAt == null ? NaN : new Date(displayedComparison.afterCapturedAt).getTime();
  const acknowledgedAt = history.round?.acknowledgedAt == null ? NaN : new Date(history.round.acknowledgedAt).getTime();
  const delay = afterAt - acknowledgedAt;
  $("historyCaptureDelay").hidden = !Number.isFinite(delay);
  $("historyCaptureDelay").textContent = delay >= 0
    ? `Result captured ${Math.round(delay / 1000)} seconds after acknowledgment—not at the acknowledgment instant. A delayed capture can include later changes.`
    : "This result snapshot predates acknowledgment. It is not proof of the page state at acknowledgment.";
  $("historyCurrentStatus").hidden = !target?.resultRevisionId && !displayedComparison.afterCapturedAt;
  $("historyCurrentStatus").textContent = comparisonFreshness(displayedComparison, target?.key, {
    key: frameController.state.key, kind: state.page?.kind, ready: !frameController.loading && !!frameController.state.readyAt,
    pendingReload: frameController.state.pendingReload, dirty: saveController.state.dirty || saveController.state.conflict,
    sourceHash: frameController.state.sourceHash || saveController.state.baseHash,
    sessionId: state.sessionId, generation: frameController.state.generation,
  });
  const viewComparison = history.mode === "content" ? displayedComparison.viewComparison : null;
  $("historyViewCoverage").hidden = !viewComparison?.message;
  $("historyViewCoverage").textContent = viewComparison?.message || "";
  $("historyViewCoverage").dataset.status = viewComparison?.status || "";
  $("comparisonModes").replaceChildren();
  for (const mode of modes) {
    const button = makeAction(mode === "source" ? "Source" : "Content", "btn-ghost");
    button.dataset.comparisonMode = mode;
    button.setAttribute("aria-pressed", String(history.mode === mode));
    button.addEventListener("click", () => {
      history.preferredMode = mode;
      history.mode = mode;
      history.index = 0;
      renderHistory();
      $("comparisonModes").querySelector(`[data-comparison-mode="${mode}"]`)?.focus({ preventScroll: true });
    });
    $("comparisonModes").append(button);
  }
  if (focusedMode) $("comparisonModes").querySelector(`[data-comparison-mode="${focusedMode}"]`)?.focus({ preventScroll: true });
  if ($("historyStatus").textContent !== presentation.message) $("historyStatus").textContent = presentation.message;
  $("historyStatus").dataset.state = presentation.state;
  const detail = history.error?.message || failedCapture || target?.capture?.error;
  $("historyError").hidden = !detail;
  $("historyError").textContent = detail || "";
  const captureAllowed = target && !target.resultRevisionId && target.capture?.status !== "unavailable" && history.round?.feedbackStatus === "acknowledged";
  $("captureResult").hidden = !captureAllowed;
  $("captureResult").disabled = history.captureBusy || history.finalizing || target?.key !== frameController.state.key || frameController.loading;
  $("captureResult").textContent = history.captureBusy ? "Capturing result…" : "Capture result";
  const canFinalize = target && !target.resultRevisionId && history.round?.feedbackStatus === "acknowledged" &&
    ["pending", "failed"].includes(target.capture?.status || target.captureStatus || "pending");
  $("finishCapture").hidden = !canFinalize;
  $("finishCaptureHelp").hidden = !canFinalize;
  $("finishCapture").disabled = history.finalizing || history.captureBusy;
  $("finishCapture").setAttribute("aria-describedby", "finishCaptureHelp");
  $("finishCapture").textContent = history.finalizing ? "Finishing…" : "Finish with available snapshots";
  const items = comparisonItems();
  const limitations = [...new Set([
    ...(comparison.content?.limitations || []),
    ...(comparison.source?.limitations || []),
  ])];
  $("historyLimitations").hidden = limitations.length === 0;
  $("historyLimitationsList").replaceChildren();
  for (const limitation of limitations) {
    const line = document.createElement("li");
    line.textContent = String(limitation).replaceAll("-", " ").replaceAll("_", " ");
    $("historyLimitationsList").append(line);
  }
  const counts = displayedComparison.counts;
  $("historyCounts").textContent = modes.length && counts
    ? `${counts.added} Added · ${counts.modified} Modified · ${counts.removed} Removed`
    : "";
  $("historyCounts").hidden = !counts;
  history.index = Math.max(0, Math.min(history.index, items.length - 1));
  $("changeDetail").hidden = !modes.length;
  const comparisonHeader = $("historyPanel").querySelector(".comparison-header");
  if (comparisonHeader) comparisonHeader.hidden = !modes.length;
  if (modes.length) {
    comparisonView.render({ ...displayedComparison, changes: items }, {
      mode: history.mode, key: `${history.selectedId}:${history.targetKey}`,
    });
    comparisonView.select(history.index);
  }
  $("changeJump").replaceChildren();
  for (const [index, item] of items.entries()) {
    const option = document.createElement("option");
    option.value = index;
    option.textContent = `${index + 1}. ${changeKind(item)} · ${tidyMiddle(item.label || excerpt(item.after) || excerpt(item.before) || "Structure", 65)}`;
    $("changeJump").append(option);
  }
  $("changeJump").value = String(history.index);
  $("changeNavigation").hidden = items.length < 2;
  $("previousChange").disabled = history.index === 0;
  $("nextChange").disabled = history.index >= items.length - 1;
  $("changePosition").textContent = `${items.length ? history.index + 1 : 0} of ${items.length}`;
}

async function captureResult(round, target, automatic = false, signal) {
  if (history.captureBusy || !round || target?.key !== frameController.state.key) return;
  const manualController = automatic ? null : new AbortController();
  if (manualController) {
    manualCaptureController = manualController;
    signal = manualController.signal;
  }
  const identity = currentRender();
  history.captureBusy = true;
  renderHistory();
  let phase = "saving";
  try {
    await fullSaveBarrier();
    if (signal?.aborted || state.ended || !sameRender(identity, currentRender())) throw captureError("CAPTURE_CANCELLED", "Capture cancelled");
    phase = "snapshot";
    const captured = await captureStablePage({ signal });
    phase = "publishing";
    const result = await api(historyUrl(`/${roundId(round)}/capture`), {
      method: "POST",
      signal,
      body: JSON.stringify({
        sessionId: state.sessionId, roundId: roundId(round), key: captured.key,
        renderId: captured.renderId, generation: captured.generation,
        semantic: captured.semantic, expectedSourceHash: captured.sourceHash || saveController.state.baseHash || frameController.state.sourceHash,
        semanticCapturedAt: captured.semanticCapturedAt, view: captured.view,
        manual: !automatic,
      }),
    });
    requireCaptureSuccess(result, target.key);
    if (signal?.aborted || state.ended || !sameRender(identity, currentRender())) return;
    history.failures.delete(`${roundId(round)}:${target.key}`);
    await refreshHistory();
  } catch (err) {
    if (signal?.aborted || state.ended || !sameRender(identity, currentRender()) || err.code === "CAPTURE_CANCELLED") return;
    history.failures.set(`${roundId(round)}:${target.key}`, err.message);
    if (phase === "snapshot" && sameRender(identity, currentRender()) && !frameController.loading) {
      await api(historyUrl(`/${roundId(round)}/capture`), {
        method: "POST",
        signal,
        body: JSON.stringify({
          key: identity.key, renderId: identity.renderId, generation: identity.generation,
          manual: !automatic, error: String(err.message).slice(0, 500),
        }),
      }).catch((reportError) => {
        if (!state.ended) diagnostic("capture-failure-report-failed", { message: reportError.message });
      });
    }
    $("historyError").hidden = false;
    $("historyError").textContent = `${err.message} Use Capture result to retry; existing captures are unchanged.`;
    if (automatic) throw err;
  } finally {
    if (manualCaptureController === manualController) manualCaptureController = null;
    history.captureBusy = false;
    renderHistory();
    scheduleResultCapture();
  }
}

function scheduleResultCapture() {
  captureCoordinator.tick();
}

function setHistoryView(comparing) {
  captureEditState();
  state.comparing = comparing;
  closeModeMenu("history-switch");
  document.body.classList.toggle("comparing", comparing);
  syncFrameInteraction();
  frameHost.current.setAttribute("aria-hidden", String(comparing));
  $("historyPanel").hidden = !comparing;
  $("latestVersion").setAttribute("aria-pressed", String(!comparing));
  $("seeChanges").setAttribute("aria-pressed", String(comparing));
  if (!comparing && frameController.state.pendingReload) $("reloadNotice").hidden = false;
  if (comparing) {
    closeDrawer();
    void refreshHistory();
  }
  render();
}
listen($("latestVersion"), "click", () => setHistoryView(false));
listen($("seeChanges"), "click", () => setHistoryView(true));
listen($("roundPicker"), "change", () => void historyController.selectRound($("roundPicker").value));
listen($("historyTarget"), "change", () => void historyController.selectTarget($("historyTarget").value));
function jumpToChange(index) {
  history.index = index;
  renderHistory();
  comparisonView.select(history.index, { scroll: true });
}
listen($("previousChange"), "click", () => jumpToChange(history.index - 1));
listen($("nextChange"), "click", () => jumpToChange(history.index + 1));
listen($("changeJump"), "change", (event) => jumpToChange(Number(event.target.value)));
listen($("captureResult"), "click", () => void captureResult(history.round, selectedTarget()));
listen($("finishCapture"), "click", async () => {
  const target = selectedTarget();
  const round = history.round;
  if (!target || !round || history.finalizing || history.captureBusy) return;
  history.finalizing = true;
  renderHistory();
  try {
    await api(historyUrl(`/${roundId(round)}/capture`), {
      method: "POST",
      body: JSON.stringify({ key: target.key, manual: true, finalUnavailable: true }),
    });
    history.failures.delete(`${roundId(round)}:${target.key}`);
    await refreshHistory();
    announce("Finished with available snapshots. Missing Content remains unavailable.");
  } catch (err) {
    $("historyError").hidden = false;
    $("historyError").textContent = `${err.message} The capture is still open; you can retry.`;
  } finally {
    history.finalizing = false;
    renderHistory();
  }
});

// -------------------------------------------------------------------- saving

const saveNow = (html) => saveController.save(html);

// ------------------------------------------------------------ frame messages

function targetPayload(msg) {
  const viewport = {
    width: Number(msg.viewport?.width),
    height: Number(msg.viewport?.height),
  };
  const generation = Number(msg.targetGeneration);
  const rawRelation = String(msg.relation || "");
  if (!["visible", "above", "below", "unavailable"].includes(rawRelation)) return null;
  const relation = sanitizeRelation(rawRelation);
  const clip = sanitizeClipRect(msg.clip, viewport);
  const rects = sanitizeClientRects(msg.rects, viewport);
  if (!Number.isSafeInteger(generation) || generation < 1 || !clip) return null;
  if (relation === "visible" && !rects.length) return null;
  return {
    kind: msg.kind === "element" ? "element" : "selection",
    quote: String(msg.quote || ""),
    anchor: msg.anchor || null,
    rects,
    generation,
    relation,
    clip,
    horizontal: Number.isFinite(msg.horizontal) ? Number(msg.horizontal) : null,
  };
}

listen(window, "message", async (event) => {
  if (!frameController.accepts(event)) return;
  const msg = event.data;

  switch (msg.type) {
    case "eh:ready": {
      const readyIdentity = currentRender();
      const readyState = await frameController.ready();
      if (!readyState || !sameRender(readyIdentity, currentRender())) return;
      state.page = { ...state.page, ...readyState };
      toFrame({ type: "eh:anchors", comments: state.page ? state.page.comments : [] });
      if (frameController.state.reloading) {
        toFrame({ type: "eh:restoreScroll", x: state.scroll.x, y: state.scroll.y });
        frameController.restoredScroll();
      }
      const configuration = reviewConfiguration(state.page, state.reviewMode);
      state.savePolicy = configuration.savePolicy;
      void frameController.configure(configuration.mode, configuration.savePolicy, false);
      render();
      if (state.page?.kind !== "url") {
        const rawIdentity = currentRender();
        void api(`/api/page/${frameController.state.key}/raw`).then((raw) => {
          if (!sameRender(rawIdentity, currentRender()) || frameController.state.pendingReload) return;
          if (frameController.state.sourceHash && frameController.state.sourceHash !== raw.hash) {
            saveController.markConflict();
            holdReload();
            return;
          }
          saveController.baseline(raw.hash || null);
          if (configuration.savePolicy === "writable") toFrame({ type: "eh:raw", html: raw.html });
          scheduleResultCapture();
        }).catch((error) => {
          if (sameRender(rawIdentity, currentRender()) && !state.ended) {
            toast(`Source could not be loaded: ${error.message}. Reload before saving.`);
          }
        });
      }
      void refreshHistory();
      break;
    }
    case "eh:configurationApplied":
      if (!frameController.configured(msg.mode, msg.savePolicy)) break;
      scheduleResultCapture();
      announce(`${state.reviewMode === "edit" ? "Edit" : "View"} mode active`);
      break;
    case "eh:target": {
      const detail = targetPayload(msg);
      if (!detail) return;
      if (state.target && detail.generation < state.target.generation) return;
      state.target = detail;
      break;
    }
    case "eh:openComment": {
      const requestedGeneration = Number(msg.targetGeneration);
      const detail = targetPayload(msg);
      let accepted = false;
      if (detail && (!state.target || detail.generation >= state.target.generation)) {
        accepted = await openCompose(detail);
      }
      if (!accepted && state.compose) {
        state.compose.rejectedTargetGeneration = Math.max(
          Number(state.compose.rejectedTargetGeneration) || 0,
          requestedGeneration
        );
      }
      toFrame({
        type: "eh:commentOpenResult",
        accepted,
        requestedGeneration,
        targetGeneration: state.compose?.generation || null,
      });
      break;
    }
    case "eh:targetGeometry":
      if (state.compose && msg.targetGeneration !== state.compose.generation) {
        diagnostic("geometry-rejected", { reason: "stale" });
        break;
      }
      if (state.compose) {
        const geometry = targetPayload({ ...msg, kind: state.compose.kind });
        if (!geometry) {
          diagnostic("geometry-rejected", { reason: "invalid" });
          break;
        }
        state.compose.rects = geometry.rects;
        state.compose.relation = geometry.relation;
        state.compose.clip = geometry.clip;
        state.compose.horizontal = geometry.horizontal ?? state.compose.horizontal;
        positionCompose();
      }
      break;
    case "eh:commentGeometry": {
      if (!msg.id) break;
      const id = String(msg.id);
      if (!state.page?.comments?.some((comment) => comment.id === id)) {
        state.activeGeometry.delete(id);
        break;
      }
      const rects = sanitizeClientRects(msg.rects, {
        width: Number(msg.viewport?.width),
        height: Number(msg.viewport?.height),
      });
      state.activeGeometry.set(id, {
        rects,
        visible: msg.visible !== false && rects.length > 0,
      });
      if (state.activeSavedCommentId === id) {
        positionAlignedCard();
        restoreTransientFocus(false);
      }
      break;
    }
    case "eh:revealTargetResult":
      if (!state.compose || msg.targetGeneration !== state.compose.generation) break;
      announce(msg.success ? "Selection revealed" : "Selection is no longer available");
      diagnostic(msg.success ? "reveal-target-succeeded" : "reveal-target-failed");
      break;
    case "eh:interaction":
      closeModeMenu("frame-interaction");
      closeCommentMenu();
      break;
    case "eh:dismiss":
      if (!$("composeText").value.trim()) cancelCompose();
      break;
    case "eh:activate":
      setActive(msg.id, false);
      break;
    case "eh:anchorStatus":
      state.orphans = new Set(msg.orphaned || []);
      render();
      break;
    case "eh:notInView":
      toast("That comment is not visible in this view");
      break;
    case "eh:formBlocked":
      toast(String(msg.reason || "This form cannot be submitted from View mode"));
      break;
    case "eh:edit":
      saveController.markEdit();
      void persistEdit(frameController.state.key, {
        label: msg.label,
        kind: msg.kind,
        before: msg.before,
        after: msg.after,
        before_html: msg.before_html,
        after_html: msg.after_html,
        moved_after: msg.moved_after,
        moved_before: msg.moved_before,
        staged_assets: msg.staged_assets,
      });
      break;
    case "eh:asset": {
      const identity = currentRender();
      const query = new URLSearchParams({
        type: msg.assetType || "", sessionId: state.sessionId,
        renderId: identity.renderId, generation: String(identity.generation),
        savePolicy: frameController.state.execution?.savePolicy || "feedback-only",
      });
      try {
        const data = await api(`/api/page/${identity.key}/asset?${query}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: msg.bytes,
        });
        if (!sameRender(identity, currentRender())) break;
        toFrame({ type: "eh:assetSaved", id: msg.id, src: data.src, stagedId: data.stagedId });
      } catch (err) {
        if (!sameRender(identity, currentRender())) break;
        toast(err.message);
        toFrame({ type: "eh:assetFailed", id: msg.id });
      }
      break;
    }
    case "eh:saving":
      saveController.markSaving();
      renderSave();
      break;
    case "eh:html":
      await saveNow(msg.html);
      break;
    case "eh:clean":
      saveController.observeClean();
      break;
    case "eh:snapshot":
      captures.receive(msg);
      break;
    case "eh:viewChanged": {
      // Only a deduplicated identity-change signal can reopen this render's
      // automatic attempt. Snapshot and ordinary mutation messages cannot.
      captureCoordinator.reset();
      manualCaptureController?.abort();
      scheduleResultCapture();
      break;
    }
    case "eh:dynamic":
      saveController.markDynamic();
      renderSave();
      break;
    case "eh:flushed":
      frameController.flushed(msg.requestId);
      break;
    case "eh:scroll":
      state.scroll = { x: msg.x, y: msg.y };
      break;
    case "eh:external": {
      // This side is what actually calls window.open, so it re-checks the
      // scheme rather than trusting the frame: a javascript: or data: URL
      // arriving here would run on this origin, next to the token.
      const external = externalHref(msg.href, location.href);
      if (external) window.open(external, "_blank", "noopener");
      break;
    }
    case "eh:navigate":
      try {
        await reviewController.navigate({ href: msg.href });
      } catch (err) {
        toast(err.message);
      }
      break;
    default:
      break;
  }
});

// --------------------------------------------------------------- UI wiring

let composeComposing = false;

listen($("composeAdd"), "click", commitCompose);
listen($("composeCancel"), "click", cancelCompose);
listen($("composeClose"), "click", cancelCompose);
listen($("composeReveal"), "click", () => {
  if (!state.compose) return;
  diagnostic("reveal-target-requested");
  toFrame({ type: "eh:revealTarget", targetGeneration: state.compose.generation });
});

listen($("compose"), "mousedown", (event) => {
  if (event.target.closest("button")) return;
  if (event.target !== $("composeText")) $("composeText").focus();
});

listen($("composeText"), "compositionstart", () => {
  composeComposing = true;
});
listen($("composeText"), "compositionend", () => {
  composeComposing = false;
});
listen($("composeText"), "keydown", (event) => {
  if (event.key === "Enter") {
    event.stopPropagation();
    if (composeComposing || event.isComposing || event.shiftKey) return;
    event.preventDefault();
    void commitCompose();
  }
  if (event.key === "Escape") {
    event.stopPropagation();
    event.preventDefault();
    cancelCompose();
  }
});

listen($("modeButton"), "click", () => {
  if ($("modeMenu").hidden) openModeMenu();
  else closeModeMenu("trigger", { restoreFocus: true });
});
listen($("modeMenu"), "click", (event) => {
  const item = event.target.closest("[data-mode]");
  if (item) void setReviewMode(item.dataset.mode);
});
listen($("modeMenu"), "keydown", (event) => {
  const items = [...$("modeMenu").querySelectorAll("[data-mode]")];
  const current = items.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    items[(current + delta + items.length) % items.length].focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeModeMenu("escape", { restoreFocus: true });
  }
});
listen($("commentsButton"), "click", openDrawer);
listen($("drawerClose"), "click", closeDrawer);
listen($("drawerBackdrop"), "click", closeDrawer);

const dismissModeMenuOutside = (event) => {
  if (!state.modeMenuOpen || event.target.closest(".mode-control")) return;
  closeModeMenu(event.type === "focusin" ? "parent-focus" : "parent-pointer");
};
listen(document, "pointerdown", dismissModeMenuOutside, true);
listen(document, "focusin", dismissModeMenuOutside, true);

function closeCommentMenu({ restoreFocus = false } = {}) {
  const menu = state.commentUi.menu;
  if (!menu) return false;
  clearOwned(state.commentUi, "menu");
  toFrame({ type: "eh:modeMenuState", open: false });
  if (restoreFocus) requestControlFocus(menu.triggerId);
  render();
  return true;
}

const dismissCommentMenuOutside = (event) => {
  const menu = state.commentUi.menu;
  if (!menu) return;
  const menuElement = document.getElementById(controlId(menu.commentId, menu.surface, "menu"));
  const trigger = document.getElementById(menu.triggerId);
  if (menuElement?.contains(event.target) || trigger?.contains(event.target)) return;
  closeCommentMenu();
};
listen(document, "pointerdown", dismissCommentMenuOutside, true);
listen(document, "focusin", dismissCommentMenuOutside, true);

const sendFeedback = () => feedbackController.send();
listen($("send"), "click", () => void sendFeedback());

listen($("revert"), "click", async () => {
  const count = state.page.edits.length;
  if (!window.confirm(`Discard all ${count} of your edits?`)) return;
  try { await saveController.revert(); }
  catch (err) { toast(err.message); }
});

/** The session is over: freeze the page and say so. Feedback is already safe. */
function showEnded() {
  if (document.querySelector(".ended")) return;
  state.ended = true;
  captureCoordinator.stop();
  manualCaptureController?.abort();
  captures.cancel("Review ended");
  historyController.cancel();
  reviewController.dispose();
  const overlay = document.createElement("div");
  overlay.className = "ended";
  const title = document.createElement("h2");
  title.textContent = "Review ended";
  const line = document.createElement("p");
  line.textContent = "Unsent feedback is saved and ships next time you review this page. You can close this tab.";
  overlay.append(title, line);
  document.body.append(overlay);
}

listen($("endReview"), "click", async () => {
  const page = state.page;
  const otherTotal = (state.others || []).reduce((sum, o) => sum + o.count, 0);
  const unsent = page ? (page.comments || []).length + (page.edits || []).length + otherTotal : 0;
  const message = unsent
    ? `End this review? ${unsent} unsent ${unsent === 1 ? "item" : "items"} will be kept for next time.`
    : "End this review? The waiting agent will be told to stop polling.";
  if (!window.confirm(message)) return;
  try {
    // Ship anything still sitting in the SDK's debounce windows first.
    await flushFrame();
    await api(`/api/session/${state.sessionId}/end`, { method: "POST" });
    showEnded();
  } catch (err) {
    toast(err.message);
  }
});

listen($("handoffCopy"), "click", async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText($("handoffCmd").textContent);
    button.textContent = "Copied";
    afterDelay(() => {
      button.textContent = "Copy prompt";
    }, 1600);
  } catch {
    toast("Couldn't copy — select the prompt and copy it manually");
  }
});

listen($("note"), "input", (event) => {
  const el = event.target;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight + 2, window.innerHeight * 0.4)}px`;
  render(); // keep the send button in step with note-only feedback
});

listen($("theme"), "click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  applyTheme(dark);
  try {
    localStorage.setItem("doc-review:theme", dark ? "dark" : "light");
  } catch {}
});

function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const button = $("theme");
  button.title = dark ? "Switch chrome to light" : "Switch chrome to dark";
  button.setAttribute("aria-label", button.title);
  replaceIcon(button, dark ? "sun" : "moon");
}

listen(document, "keydown", (event) => {
  const meta = event.metaKey || event.ctrlKey;
  // ⌘S is reassurance only: flush pending keystrokes, never a state change.
  if (meta && event.key.toLowerCase() === "s") {
    event.preventDefault();
    toFrame({ type: "eh:flush" });
    renderSave();
    return;
  }
  if (event.key === "Tab" && state.commentUi.menu) {
    closeCommentMenu();
    return;
  }
  if (event.key !== "Escape") return;
  const recoveryMenu = event.target.closest?.("#reviewDetails");
  if (recoveryMenu) {
    recoveryMenu.open = false;
    recoveryMenu.querySelector("summary")?.focus({ preventScroll: true });
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  let handled = false;
  if (state.commentUi.confirmation) handled = cancelDeleteConfirmation();
  else if (state.commentUi.menu) handled = closeCommentMenu({ restoreFocus: true });
  else if (state.commentUi.edit) handled = cancelCommentEdit();
  else if (state.compose) handled = cancelCompose();
  else if (state.modeMenuOpen) handled = closeModeMenu("escape", { restoreFocus: true });
  else if (state.drawerOpen) {
    closeDrawer();
    handled = true;
  } else if (state.activeSavedCommentId) handled = dismissActiveComment("escape", { restoreFocus: true });
  if (handled) {
    event.preventDefault();
    event.stopPropagation();
  }
});

// ------------------------------------------------------------------ events

function holdReload() {
  frameController.holdReload();
  saveController.hold();
  $("reloadNotice").hidden = false;
  $("reloadMessage").textContent = saveController.state.dirty || saveController.state.conflict
    ? "The source changed. This page has unsaved edits; reload discards those page edits, but keeps open comment drafts. Stale edits will not overwrite the new source."
    : "The source changed. Reload keeps your comment drafts as unresolved excerpts so they cannot attach to the wrong content.";
  captureCoordinator.reset();
  manualCaptureController?.abort();
  captures.cancel();
  renderExecution();
  if (state.comparing) renderHistory();
}

async function reloadLatest({ explicit = false } = {}) {
  if (!explicit && (draftCount(state) || saveController.state.dirty || saveController.state.conflict || feedbackController.sending)) {
    holdReload();
    return;
  }
  const key = frameController.state.key;
  advancePageEpoch("reload");
  captureEditState();
  if (state.compose) {
    state.compose.unresolved = true;
    state.compose.relation = "unavailable";
    state.compose.rects = [];
    state.compose.generation = -1;
  }
  const generation = beginFrameTransition();
  frameController.resetRetries();
  frameController.startReload();
  saveController.reset();
  $("reloadNotice").hidden = true;
  try {
    const page = await api(pageUrl(key, state.sessionId), undefined, decodePage);
    if (frameController.state.key !== key || frameController.state.generation !== generation) return;
    state.executionPreference = page.executionPreference || null;
    // Keep parent-owned drafts rather than replacing their text on a source update.
    replacePage(state, page);
    saveController.reset();
    render();
    if (state.compose) {
      $("compose").hidden = false;
      $("compose").classList.add("sheet");
      $("composeError").hidden = false;
      $("composeError").textContent = "The source changed. This draft keeps its original excerpt; cancel it to select a new target.";
    }
    await registerFrame(key, generation);
  } catch (err) {
    if (frameController.state.key === key && frameController.state.generation === generation) failFrame(err.message);
  }
}
listen($("safeReload"), "click", () => void reloadLatest({ explicit: true }));
listen($("keepCurrent"), "click", () => { $("reloadNotice").hidden = true; announce("Keeping the current page. Return to Latest version to reload when ready."); });
listen(window, "beforeunload", (event) => {
  if (!saveController.state.dirty && !draftCount(state, $("note").value) && !saveController.queued(frameController.state.key)) return;
  event.preventDefault();
  event.returnValue = "";
});
listen(window, "pagehide", (event) => {
  if (event.persisted) return;
  state.ended = true;
  captureCoordinator.stop();
  manualCaptureController?.abort();
  captures.cancel("Review closed");
  historyController.cancel();
  reviewController.dispose();
});

const connect = () => reviewController.connect();

// -------------------------------------------------------------------- start

(async function start() {
  installStaticIcons();
  try {
    applyTheme(localStorage.getItem("doc-review:theme") === "dark");
  } catch {}

  const bootstrap = await api(`/api/session/${state.sessionId}/page`);
  if (bootstrap && bootstrap.page) state.pollCommand = bootstrap.page.pollCommand;
  if (bootstrap && Number.isSafeInteger(bootstrap.generation)) frameController.seedGeneration(bootstrap.generation);
  const key = bootstrap ? bootstrap.key : new URLSearchParams(location.search).get("key");
  await loadPage(key);
  connect();
  void refreshHistory();
})().catch((error) => {
  failFrame(`Review could not start: ${error.message}`);
});

listen(window, "resize", () => {
  positionCompose();
  if (state.activeSavedCommentId) positionAlignedCard();
});
if (window.visualViewport) {
  listen(window.visualViewport, "resize", positionCompose);
  listen(window.visualViewport, "scroll", positionCompose);
}

reviewController.own(frameHost.onFocus(() => {
  closeCommentMenu();
  if (state.compose) $("compose").classList.add("pass-through");
}));
listen($("compose"), "focusin", () => $("compose").classList.remove("pass-through"));
