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
import { createDocumentTrustControls } from "./document-trust-client.js";
import { alignedCardPosition, placeContextualSurface, visibleViewport } from "./positioning.js";
import { normalizeReviewMode, reviewConfiguration } from "./review-mode.js";
import { createCaptureRequests, sameRender, draftCount, excerpt, changeKind, pendingCaptureTarget, defaultHistoryRound, comparisonFreshness } from "./history-client.js";

const $ = (id) => document.getElementById(id);
let frame = $("frame");
let previousFrame = null;
let replacementTimer = null;

const state = {
  sessionId: document.body.dataset.session,
  token: document.body.dataset.token,
  key: null,
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
  save: "idle",
  savedAt: "",
  sent: false,
  orphans: new Set(),
  pollCommand: "",
  editsExpanded: false,
  others: [],
  scroll: { x: 0, y: 0 },
  reloading: false,
  dynamic: false,
  framePolicy: null,
  renderGeneration: 0,
  renderId: null,
  frameCapability: null,
  frameLoading: true,
  frameFailure: null,
  pendingInitialLoad: false,
  readyGeneration: null,
  frameReadyTimer: null,
  frameReadyRetries: 0,
  configurationGeneration: null,
  saveConflict: false,
  comparing: false,
  sending: false,
  domDirty: false,
  pendingReload: false,
  renderSourceHash: null,
  frameReadyAt: 0,
  cleanObservation: null,
  renderTrust: null,
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
  requestAnimationFrame(() => {
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
  requestAnimationFrame(() => {
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
  if (!state.commentUi.edit) requestAnimationFrame(() => $("commentsSection").focus());
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

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", "x-doc-review-token": state.token, ...(options && options.headers) },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const error = new Error(detail.error || `Request failed (${res.status})`);
    error.status = res.status;
    error.code = detail.code;
    error.targets = detail.targets || [];
    throw error;
  }
  return res.json();
}

const documentTrustControls = createDocumentTrustControls({
  api,
  sessionId: state.sessionId,
  container: $("documentTrustControls"),
  onChanged(page) {
    if (!page || page.key !== state.key) return;
    state.page = {
      ...state.page,
      trust: page.trust,
      trustMode: page.trustMode,
      trustedInteractive: page.trustedInteractive === true,
      feedbackOnly: page.feedbackOnly === true,
      ...state.renderTrust,
    };
    state.savePolicy = reviewConfiguration(state.page, state.reviewMode).savePolicy;
    render();
  },
  onError(error) { toast(error.message || String(error)); },
});
let refreshedTrustPage = null;

const toolbar = document.querySelector(".toolbar");
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--toolbar-h", `${toolbar.getBoundingClientRect().height}px`);
}).observe(toolbar);

function renderDocumentTrust() {
  const visibleFrame = previousFrame || frame;
  documentTrustControls.setRenderState({
    trustedInteractive: visibleFrame.hasAttribute("data-trusted-interactive")
      ? visibleFrame.dataset.trustedInteractive === "true" : undefined,
    pendingReload: state.pendingReload || !!previousFrame,
    loading: state.frameLoading,
    notice: state.renderTrust?.trustNotice,
    error: state.frameFailure,
  });
}

const editPipelines = new Map();
const editBacklogs = new Map();
const editErrors = new Map();
let editMutationSequence = 0;

function editIdentity(payload) {
  return `${String(payload.label || "")}\u0000${String(payload.kind || "")}`;
}

function editBacklog(key) {
  let backlog = editBacklogs.get(key);
  if (!backlog) {
    backlog = new Map();
    editBacklogs.set(key, backlog);
  }
  return backlog;
}

function persistEdit(key, payload) {
  if (!payload.renderId && key === state.key && state.renderId) {
    payload = {
      ...payload,
      sessionId: state.sessionId, renderId: state.renderId, generation: state.renderGeneration,
    };
  }
  const identity = editIdentity(payload);
  const backlog = editBacklog(key);
  backlog.set(identity, payload);
  const previous = editPipelines.get(key) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      try {
        const result = await api(`/api/page/${key}/edit`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (backlog.get(identity) === payload) backlog.delete(identity);
        editErrors.delete(key);
        if (state.key === key) {
          state.page = result.page;
          state.sent = false;
          render();
        }
        return true;
      } catch (err) {
        editErrors.set(key, err);
        if (state.key === key) {
          toast(`${err.message}. Your edit is still queued locally.`);
          announce("An edit could not be saved. Retry before leaving the page or sending feedback.");
        }
        return false;
      }
    });
  editPipelines.set(key, current);
  void current.finally(() => {
    if (editPipelines.get(key) === current) editPipelines.delete(key);
    applyCleanObservation();
  });
  return current;
}

async function settleEditPersistence(key) {
  const inFlight = editPipelines.get(key);
  if (inFlight) await inFlight;
  const backlog = editBacklogs.get(key);
  if (backlog?.size) {
    const retry = [...backlog.values()];
    editErrors.delete(key);
    for (const payload of retry) persistEdit(key, payload);
    const retried = editPipelines.get(key);
    if (retried) await retried;
  }
  if (editBacklogs.get(key)?.size) {
    throw editErrors.get(key) || new Error("An edit could not be saved");
  }
}

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
  if (syncAnchors && !state.frameLoading) {
    toFrame({ type: "eh:anchors", comments: page.comments || [] });
  }
  if (reason === "acknowledgement") {
    const removed = [...previousIds].filter((id) => !commentIds.has(id));
    if (removed.length) {
      announce(`${removed.length === 1 ? "Comment" : "Comments"} delivered and removed`);
      if (removedTransient.size) requestAnimationFrame(() => (state.drawerOpen ? $("commentsSection") : frame).focus());
    }
  }
  diagnostic("page-reconciled", { reason, epoch: state.pageEpoch });
}

// Keep the reviewed app on a different loopback origin from the review shell.
// This gives route-aware frameworks a real origin without exposing the parent UI.
const ARTIFACT_HOST = location.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
const ARTIFACT_ORIGIN = `${location.protocol}//${ARTIFACT_HOST}:${location.port}`;
const FRAME_READY_TIMEOUT_MS = 5000;

// URL reviews keep a real origin. File reviews use an opaque sandbox origin,
// so postMessage requires "*" while the source-window check remains exact.
const toFrame = (message) => {
  if (state.frameLoading || !state.frameCapability || !frame.contentWindow) return;
  frame.contentWindow.postMessage(
    {
      ...message,
      capability: state.frameCapability,
      generation: state.renderGeneration,
      pageKey: state.key,
    },
    state.framePolicy?.targetOrigin || ARTIFACT_ORIGIN
  );
};

function suspendFrame() {
  captures.cancel();
  for (const request of flushRequests.values()) request.settle(false);
  clearTimeout(state.frameReadyTimer);
  state.frameReadyTimer = null;
  state.frameCapability = null;
  state.renderId = null;
  state.frameLoading = true;
  state.readyGeneration = null;
  state.configurationGeneration = null;
  state.renderTrust = null;
  frame.removeAttribute("data-sdk-ready");
}

function beginFrameTransition() {
  state.frameFailure = null;
  if (state.compose) {
    state.compose.unresolved = true;
    state.compose.relation = "unavailable";
    state.compose.rects = [];
    state.compose.generation = -1;
  }
  state.target = null;
  state.activeGeometry.clear();
  state.baseHash = null;
  state.renderSourceHash = null;
  state.frameReadyAt = 0;
  state.renderGeneration += 1;
  suspendFrame();
  return state.renderGeneration;
}

async function registerFrame(key, generation) {
  const registered = await api(`/api/session/${state.sessionId}/render`, {
    method: "POST",
    body: JSON.stringify({ key, generation }),
  });
  if (state.key !== key || state.renderGeneration !== generation) return false;
  state.renderId = registered.renderId;
  state.renderSourceHash = registered.sourceHash || null;
  state.frameCapability = registered.capability;
  state.frameLoading = true;
  state.pendingInitialLoad = true;
  if (state.reloading && frame.hasAttribute("src")) {
    const next = frame.cloneNode(false);
    next.src = `${ARTIFACT_ORIGIN}${registered.path}`;
    next.removeAttribute("data-sdk-ready");
    next.removeAttribute("data-trusted-interactive");
    if (previousFrame) frame.remove();
    else {
      previousFrame = frame;
      previousFrame.id = "previousFrame";
      previousFrame.inert = true;
      previousFrame.setAttribute("aria-hidden", "true");
      previousFrame.tabIndex = -1;
    }
    frame = next;
    frame.dataset.replacing = "true";
    attachFrameEvents(frame);
    previousFrame.after(frame);
  }
  if (frame.src !== `${ARTIFACT_ORIGIN}${registered.path}`) frame.src = `${ARTIFACT_ORIGIN}${registered.path}`;
  renderDocumentTrust();
  state.frameReadyTimer = setTimeout(() => {
    if (state.key !== key || state.renderGeneration !== generation || !state.frameLoading) return;
    if (state.frameReadyRetries < 1) {
      state.frameReadyRetries += 1;
      rotateCurrentFrame();
      return;
    }
    failFrame("The reviewed page did not finish loading. Fix the source or local server, then reload.");
  }, FRAME_READY_TIMEOUT_MS);
  return true;
}

function finishFrameReplacement() {
  clearTimeout(replacementTimer);
  replacementTimer = null;
  previousFrame?.remove();
  previousFrame = null;
  delete frame.dataset.replacing;
  renderDocumentTrust();
}

function failFrame(message) {
  suspendFrame();
  state.frameFailure = message;
  state.pendingReload = true;
  finishFrameReplacement();
  $("reloadNotice").hidden = false;
  $("reloadMessage").textContent = `${message} Reload keeps your comment drafts.`;
  toast(message);
}

function rotateCurrentFrame() {
  if (!state.key) return;
  const key = state.key;
  const generation = beginFrameTransition();
  void registerFrame(key, generation).catch((err) => {
    if (state.key !== key || state.renderGeneration !== generation) return;
    failFrame(err.message);
  });
}

/**
 * Ask the SDK to ship anything still sitting in its debounce windows, and
 * wait until it has. Navigating away without this drops the last moments of
 * typing. The timeout covers a torn-down or never-booted frame.
 */
const flushRequests = new Map();
let flushSequence = 0;
let configurationWaiter = null;
async function flushFrame({ strict = false } = {}) {
  const key = state.key;
  if (!state.frameLoading && state.frameCapability) {
    await new Promise((resolve, reject) => {
      const requestId = `flush-${++flushSequence}`;
      const settle = (confirmed = true) => {
        if (!flushRequests.has(requestId)) return;
        flushRequests.delete(requestId);
        clearTimeout(timer);
        if (!confirmed && strict) reject(new Error("The page did not finish saving. Wait for it to load, then retry."));
        else resolve();
      };
      const timer = setTimeout(() => settle(false), strict ? 6000 : 400);
      flushRequests.set(requestId, { settle, strict });
      toFrame({ type: "eh:flush", requestId });
    });
  } else if (strict) throw new Error("The page is not ready. Wait for it to load, then retry.");
  if (key) await settleEditPersistence(key);
}

function configureFrame() {
  if (state.frameLoading || !state.frameCapability || !state.renderTrust) return Promise.resolve(false);
  Object.assign(state.page, state.renderTrust);
  const configuration = reviewConfiguration(state.page, state.reviewMode);
  state.savePolicy = configuration.savePolicy;
  return new Promise((resolve) => {
    const settle = (applied) => {
      if (configurationWaiter?.settle !== settle) return;
      configurationWaiter = null;
      resolve(applied);
    };
    configurationWaiter = { ...configuration, settle };
    toFrame({ type: "eh:configureReview", ...configuration });
    if (previousFrame) {
      clearTimeout(replacementTimer);
      const configuringFrame = frame;
      replacementTimer = setTimeout(() => {
        if (frame !== configuringFrame || !previousFrame) return;
        failFrame("The page did not confirm its review settings. Reload before continuing.");
      }, FRAME_READY_TIMEOUT_MS);
    }
    setTimeout(() => settle(false), 3000);
  });
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
      if (state.saveConflict) {
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
  const generation = beginFrameTransition();
  state.frameReadyRetries = 0;
  state.key = key;
  const page = await api(pageUrl(key, state.sessionId));
  if (state.key !== key || state.renderGeneration !== generation) return;
  reconcilePage(page, { reason: "reload", advance: false });
  state.savePolicy = reviewConfiguration(state.page, state.reviewMode).savePolicy;
  state.framePolicy = framePolicy(state.page, ARTIFACT_ORIGIN);
  frame.setAttribute("sandbox", state.framePolicy.sandbox);
  state.orphans = new Set();
  state.compose = null;
  setComposeLifecycle("closed", "page-change");
  setComposePlacement("hidden");
  state.target = null;
  state.activeSavedCommentId = null;
  state.activeGeometry.clear();
  state.commentUi = createCommentUi();
  state.sent = false;
  state.dynamic = false;
  state.baseHash = null;
  state.saveConflict = false;
  state.domDirty = false;
  clearTimeout(retryTimer);
  if (reload) {
    state.reloading = true;
    await registerFrame(key, generation);
  }
  render();
  // Coming back to a dev-server page shows the app's own copy again, without
  // the direct edits — which reads as data loss unless we say what happened.
  const edits = state.page.edits ? state.page.edits.length : 0;
  if (returning && state.page.feedbackOnly && edits > 0) {
    toast(`This page renders from your dev server — ${edits} ${edits === 1 ? "edit is" : "edits are"} queued for the agent`);
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

const clock = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// -------------------------------------------------------------------- render

function render() {
  const page = state.page;
  if (!page) return;
  // A saved file's new trust decision does not change the policy of a still
  // displayed older frame while draft-safe reload is waiting.
  if (state.renderTrust) Object.assign(page, state.renderTrust);
  if (refreshedTrustPage !== page) {
    refreshedTrustPage = page;
    void documentTrustControls.refresh(page);
  }
  renderDocumentTrust();
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
  $("modeButton").disabled = state.modeApplying || state.comparing || state.sending || !state.renderTrust;
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
    requestAnimationFrame(positionCompose);
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
          if (draftCount(state)) throw new Error("Save or cancel open comment drafts before changing pages");
          await fullSaveBarrier();
          suspendFrame();
          await api(`/api/session/${state.sessionId}/goto`, {
            method: "POST",
            body: JSON.stringify({ key: other.key }),
          });
          state.scroll = { x: 0, y: 0 };
          await loadPage(other.key);
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
  const busy = delivered || stranded || state.sent;
  send.disabled = (total === 0 && !hasNote) || busy || state.sending;
  send.textContent = state.sending ? "Saving and capturing…" : delivered
    ? "Feedback delivered"
    : stranded
      ? "Sent — agent is not listening"
      : state.sent
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
  const frameRect = frame.getBoundingClientRect();
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
    frameRect: frame.getBoundingClientRect(),
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
      const result = await api(`/api/page/${state.key}/comment/${id}`, { method: "DELETE" });
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
  requestAnimationFrame(() => {
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
    const result = await api(`/api/page/${state.key}/comment/${id}`, {
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
      state.sent = false;
      toFrame({ type: "eh:remove", id });
      toFrame({ type: "eh:anchors", comments: state.page.comments });
      if (remainsActive && replacement) toFrame({ type: "eh:activate", id: replacement.id, scroll: false });
      toast("Saved as a correction — send it after the current batch is acknowledged");
    } else {
      state.sent = false;
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
  if (state.saveConflict) {
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
  if (state.dynamic) {
    // The page's own scripts render it, so writing the live DOM back would
    // corrupt the file. Edits still reach the agent as feedback.
    line.className = "save-line dynamic";
    $("saveText").textContent = "Live page — edits go to the agent, the file is left alone";
    return;
  }
  line.className = `save-line ${state.save === "saving" ? "saving" : state.save === "failed" ? "failed" : ""}`;
  const name = state.page ? state.page.filename : "";
  if (state.save === "saving") $("saveText").textContent = `Saving to ${name}…`;
  else if (state.save === "failed") $("saveText").textContent = "Couldn't save — retry before sending";
  else $("saveText").textContent = state.savedAt ? `Saved to ${name} · ${state.savedAt}` : `Saved to ${name}`;
}

function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 3200);
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
  if (restoreFocus) frame.focus();
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
  requestAnimationFrame(() => {
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
    const result = await api(`/api/page/${state.key}/comment`, {
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
    state.sent = false;
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
    requestAnimationFrame(() => $("composeText").focus());
    return false;
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------ review history

const currentRender = () => ({
  key: state.key, renderId: state.renderId, generation: state.renderGeneration,
  loading: state.frameLoading,
});
const captures = createCaptureRequests({ send: toFrame, current: currentRender });
const history = {
  rounds: [], selectedId: null, round: null, targetKey: null, mode: "content", preferredMode: "content",
  index: 0, refresh: 0, captureBusy: false, finalizing: false, attempts: new Set(), failures: new Map(), preferCompleted: false,
  viewRetry: null,
};
const comparisonView = createComparisonView($("changeDetail"));
const historyUrl = (suffix = "") => `/api/session/${state.sessionId}/history${suffix}`;

async function fullSaveBarrier() {
  const identity = currentRender();
  await flushFrame({ strict: true });
  await activeSavePromise;
  if (state.save === "failed" && !state.saveConflict && lastSave?.key === state.key && lastSave.generation === state.renderGeneration) {
    await saveNow(lastSave.html);
  }
  await settleEditPersistence(identity.key);
  applyCleanObservation();
  if (!sameRender(identity, currentRender())) throw new Error("The page changed while saving. Retry on the latest page.");
  if (state.saveConflict) throw new Error("Resolve the save conflict: the source changed outside this review. Reload latest; your comment drafts will be kept.");
  if (state.save === "failed" || (state.savePolicy === "writable" && !state.dynamic && state.domDirty)) {
    throw new Error("Your page edits have not finished saving. They have not been sent.");
  }
  if (state.savePolicy !== "writable" || state.dynamic) state.domDirty = false;
}

async function captureStablePage() {
  const identity = currentRender();
  const captured = await captures.request();
  const capturedSaveSequence = saveSequence;
  const capturedEditSequence = editMutationSequence;
  // The SDK flushes its debounces before capture; their server writes must finish too.
  await activeSavePromise;
  await settleEditPersistence(identity.key);
  applyCleanObservation();
  if (!sameRender(identity, currentRender()) || state.saveConflict || state.save === "failed") {
    throw new Error("The page changed or could not be saved during capture. Recapture the latest version.");
  }
  if (saveSequence !== capturedSaveSequence || editMutationSequence !== capturedEditSequence) {
    throw new Error("The page changed while its captured edits were saving. Recapture the latest version.");
  }
  return captured;
}

function syncFrameInteraction() {
  frame.inert = state.comparing || state.sending || history.captureBusy;
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

async function refreshHistory() {
  const revision = ++history.refresh;
  try {
    const data = await api(historyUrl());
    if (revision !== history.refresh) return;
    history.rounds = data.rounds || [];
    if (history.preferCompleted) {
      history.selectedId = roundId(defaultHistoryRound(history.rounds));
      history.preferCompleted = false;
    }
    if (!history.rounds.some((round) => roundId(round) === history.selectedId)) history.selectedId = roundId(history.rounds[0]) || null;
    if (history.selectedId) {
      const detail = await api(historyUrl(`/${history.selectedId}`));
      if (revision !== history.refresh) return;
      history.round = detail.round || detail;
      const summary = history.rounds.find((round) => roundId(round) === history.selectedId);
      for (const target of roundTargets(history.round)) {
        const label = roundTargets(summary).find((item) => item.key === target.key);
        target.filename ||= label?.filename;
      }
      const target = selectedTarget();
      history.targetKey = target?.key || null;
      if (target) {
        const comparisons = await Promise.all(["content", "source"].map((mode) =>
          api(historyUrl(`/${history.selectedId}/compare?key=${encodeURIComponent(target.key)}&mode=${mode}`))
        ));
        if (revision !== history.refresh) return;
        target.comparison = {
          content: comparisons[0], source: comparisons[1],
          availableModes: ["content", "source"].filter((mode, index) => comparisons[index].available),
        };
      }
    } else history.round = null;
    $("historyError").hidden = true;
    renderHistory();
    scheduleResultCapture();
  } catch (err) {
    $("historyError").hidden = false;
    $("historyError").textContent = `History could not be loaded: ${err.message}`;
  }
}

function renderHistory() {
  syncFrameInteraction();
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
  history.targetKey = target?.key || null;
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
  const selectedComparison = comparison[history.mode] || {};
  const modes = comparison.availableModes || [
    ...(comparison.content || comparison.changes || comparison.items ? ["content"] : []),
    ...(comparison.source ? ["source"] : []),
  ];
  history.mode = modes.includes(history.preferredMode) ? history.preferredMode : modes[0] || "content";
  const displayedComparison = comparison[history.mode] || selectedComparison;
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
    key: state.key, kind: state.page?.kind, ready: !state.frameLoading && !!state.frameReadyAt,
    pendingReload: state.pendingReload, dirty: state.domDirty || state.saveConflict,
    sourceHash: state.renderSourceHash || state.baseHash,
    sessionId: state.sessionId, generation: state.renderGeneration,
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
  const failedCapture = history.failures.get(`${roundId(history.round)}:${target?.key}`);
  const captureStatus = target?.capture?.status || target?.captureStatus || target?.status || history.round?.captureStatus || history.round?.status;
  const status = failedCapture && !target?.resultRevisionId ? "failed"
    : target?.resultRevisionId && target.baselineUnavailable ? "partial"
      : captureStatus === "ready" ? "completed"
        : captureStatus === "pending" && history.round?.feedbackStatus === "acknowledged" ? "awaiting-result"
          : captureStatus || (target?.resultRevisionId ? "completed" : "pending");
  const descriptions = {
    pending: "Waiting for the agent's result. The baseline was captured when feedback was sent.",
    "awaiting-result": "Waiting for the result page to stabilize. Capture result if automatic capture is unavailable.",
    failed: "Capture failed. Saved feedback is safe; retry Capture result on the latest page.",
    partial: "Partial comparison — some content or pages could not be captured.",
    complete: "Before: feedback sent. After: captured result. This comparison is read-only.",
    completed: "Before: feedback sent. After: captured result. This comparison is read-only.",
    unavailable: "The result capture is unavailable. Any saved source comparison remains available.",
    cancelled: "This review round was superseded. Existing captures are preserved.",
    running: "Capturing the result. Your saved baseline will not change.",
    claimed: "A review window is capturing the result. Your saved baseline will not change.",
  };
  $("historyStatus").textContent = history.round
    ? `${status.charAt(0).toUpperCase() + status.slice(1)} · ${descriptions[status] || target?.reason || "Review the available captures below."}`
    : "No review rounds yet. Send feedback to start a comparison.";
  const captureReason = failedCapture || target?.capture?.error;
  if (captureReason && !target?.resultRevisionId) $("historyStatus").textContent += ` ${captureReason}`;
  if (target && !target.resultRevisionId && (target.sourceResultRevisionId || comparison.source?.available)) {
    $("historyStatus").textContent += status === "unavailable"
      ? " Source captured; missing Content was explicitly finalized as unavailable."
      : " Source captured; Content capture pending.";
  }
  const captureAllowed = target && !target.resultRevisionId && target.capture?.status !== "unavailable" && history.round?.feedbackStatus === "acknowledged";
  $("captureResult").hidden = !captureAllowed;
  $("captureResult").disabled = history.captureBusy || history.finalizing || target?.key !== state.key || state.frameLoading;
  $("captureResult").textContent = history.captureBusy ? "Capturing result…" : "Capture result";
  const canFinalize = target && !target.resultRevisionId && history.round?.feedbackStatus === "acknowledged" &&
    ["pending", "failed"].includes(target.capture?.status || target.captureStatus || "pending");
  $("finishCapture").hidden = !canFinalize;
  $("finishCaptureHelp").hidden = !canFinalize;
  $("finishCapture").disabled = history.finalizing || history.captureBusy;
  $("finishCapture").setAttribute("aria-describedby", "finishCaptureHelp");
  $("finishCapture").textContent = history.finalizing ? "Finishing…" : "Finish with available snapshots";
  if (captureAllowed && target.key !== state.key) $("historyStatus").textContent += " Open this page in Latest version before capturing its result.";
  if (!modes.length && target) $("historyStatus").textContent += ` ${target.baselineUnavailable || target.resultUnavailable || comparison.content?.reason || ""}`;
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
  const counts = displayedComparison.counts || { added: 0, modified: 0, removed: 0 };
  if (!displayedComparison.counts) for (const item of items) counts[changeKind(item)]++;
  $("historyCounts").textContent = modes.length
    ? `${counts.added} Added · ${counts.modified} Modified · ${counts.removed} Removed`
    : target?.resultRevisionId ? "Comparison unavailable for these captures." : "Comparison unavailable until both versions have been captured.";
  history.index = Math.max(0, Math.min(history.index, items.length - 1));
  comparisonView.render({ ...displayedComparison, changes: items, available: modes.length > 0 }, {
    mode: history.mode, key: `${history.selectedId}:${history.targetKey}`,
  });
  comparisonView.select(history.index);
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

async function captureResult(round, target, automatic = false) {
  if (history.captureBusy || !round || target?.key !== state.key) return;
  const identity = currentRender();
  const attempt = `${roundId(round)}:${state.renderId}:${state.renderGeneration}`;
  if (automatic && history.attempts.has(attempt)) return;
  history.attempts.add(attempt);
  history.captureBusy = true;
  renderHistory();
  let phase = "saving";
  try {
    await fullSaveBarrier();
    phase = "snapshot";
    const captured = await captureStablePage();
    phase = "publishing";
    await api(historyUrl(`/${roundId(round)}/capture`), {
      method: "POST",
      body: JSON.stringify({
        sessionId: state.sessionId, roundId: roundId(round), key: captured.key,
        renderId: captured.renderId, generation: captured.generation,
        semantic: captured.semantic, expectedSourceHash: state.baseHash || state.renderSourceHash,
        semanticCapturedAt: captured.semanticCapturedAt, view: captured.view,
        manual: !automatic,
      }),
    });
    history.failures.delete(`${roundId(round)}:${target.key}`);
    await refreshHistory();
  } catch (err) {
    history.failures.set(`${roundId(round)}:${target.key}`, err.message);
    if (phase === "snapshot" && sameRender(identity, currentRender()) && !state.frameLoading) {
      await api(historyUrl(`/${roundId(round)}/capture`), {
        method: "POST",
        body: JSON.stringify({
          key: identity.key, renderId: identity.renderId, generation: identity.generation,
          manual: !automatic, error: String(err.message).slice(0, 500),
        }),
      }).catch(() => {});
    }
    $("historyError").hidden = false;
    $("historyError").textContent = `${err.message} Use Capture result to retry; existing captures are unchanged.`;
  } finally {
    history.captureBusy = false;
    renderHistory();
    const viewRetry = history.viewRetry;
    history.viewRetry = null;
    if (viewRetry && sameRender(viewRetry, currentRender())) scheduleResultCapture();
  }
}

function scheduleResultCapture() {
  if (state.frameLoading || state.pendingReload || state.domDirty || state.saveConflict || state.sending || history.captureBusy || history.finalizing) return;
  if (state.page?.kind !== "url" && !state.baseHash) return;
  const round = history.rounds.find((item) => pendingCaptureTarget(item, state.key, state.frameReadyAt));
  const target = roundTargets(round).find((item) => item.key === state.key);
  // A pending round still belongs to the agent. Only an acknowledged round may capture its result.
  if (round && target) {
    void captureResult(round, target, true);
  }
}

function setHistoryView(comparing) {
  captureEditState();
  if (comparing && !state.comparing) history.preferCompleted = true;
  state.comparing = comparing;
  closeModeMenu("history-switch");
  document.body.classList.toggle("comparing", comparing);
  syncFrameInteraction();
  frame.setAttribute("aria-hidden", String(comparing));
  $("historyPanel").hidden = !comparing;
  $("latestVersion").setAttribute("aria-pressed", String(!comparing));
  $("seeChanges").setAttribute("aria-pressed", String(comparing));
  if (!comparing && state.pendingReload) $("reloadNotice").hidden = false;
  if (comparing) {
    closeDrawer();
    void refreshHistory();
  }
  render();
}
$("latestVersion").addEventListener("click", () => setHistoryView(false));
$("seeChanges").addEventListener("click", () => setHistoryView(true));
$("roundPicker").addEventListener("change", () => { history.selectedId = $("roundPicker").value; history.index = 0; void refreshHistory(); });
$("historyTarget").addEventListener("change", () => { history.targetKey = $("historyTarget").value; history.index = 0; void refreshHistory(); });
function jumpToChange(index) {
  history.index = index;
  renderHistory();
  comparisonView.select(history.index, { scroll: true });
}
$("previousChange").addEventListener("click", () => jumpToChange(history.index - 1));
$("nextChange").addEventListener("click", () => jumpToChange(history.index + 1));
$("changeJump").addEventListener("change", (event) => jumpToChange(Number(event.target.value)));
$("captureResult").addEventListener("click", () => void captureResult(history.round, selectedTarget()));
$("finishCapture").addEventListener("click", async () => {
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

let retryTimer = null;
let saveAttempts = 0;
let activeSavePromise = Promise.resolve(true);
let saveSequence = 0;
let savePending = 0;
let lastSave = null;

function applyCleanObservation() {
  const clean = state.cleanObservation;
  if (!clean || clean.key !== state.key || clean.generation !== state.renderGeneration ||
      clean.saveSequence !== saveSequence || clean.editSequence !== editMutationSequence ||
      savePending || state.save === "failed" || state.saveConflict ||
      editBacklogs.get(state.key)?.size || editPipelines.has(state.key)) return;
  state.domDirty = false;
  state.save = state.savedAt ? "saved" : "idle";
  renderSave();
}

/** A fresh serialization from the SDK always starts a fresh attempt budget. */
function saveNow(html) {
  const sequence = ++saveSequence;
  const key = state.key;
  const generation = state.renderGeneration;
  lastSave = { html, key, generation };
  savePending += 1;
  state.domDirty = true;
  saveAttempts = 0;
  activeSavePromise = activeSavePromise.catch(() => false).then(async () => {
    if (state.saveConflict || key !== state.key || generation !== state.renderGeneration) return false;
    const saved = await saveHtml(html, key, generation);
    if (saved && saveSequence === sequence) state.domDirty = false;
    return saved;
  }).finally(() => {
    savePending -= 1;
    applyCleanObservation();
  });
  return activeSavePromise;
}

async function saveHtml(html, key, generation = state.renderGeneration) {
  clearTimeout(retryTimer);
  // A retry that outlived a page switch must never write into the new page.
  if (key !== state.key || generation !== state.renderGeneration || state.saveConflict) return false;
  if (!state.baseHash) {
    // The on-disk baseline hasn't arrived yet; wait for it rather than write blind.
    saveAttempts += 1;
    if (saveAttempts <= 10) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return saveHtml(html, key, generation);
    }
    else {
      state.save = "failed";
      renderSave();
    }
    return false;
  }
  try {
    const result = await api(`/api/page/${key}/save`, {
      method: "POST",
      body: JSON.stringify({
        html, baseHash: state.baseHash, renderId: state.renderId,
        generation, sessionId: state.sessionId,
      }),
    });
    if (key !== state.key || generation !== state.renderGeneration) return false;
    state.baseHash = result.hash || null;
    state.renderSourceHash = result.hash || state.renderSourceHash;
    state.save = "saved";
    state.savedAt = clock();
    saveAttempts = 0;
    renderSave();
    return true;
  } catch (err) {
    if (key !== state.key || generation !== state.renderGeneration) return false;
    if (err.status === 409) {
      // Someone else — usually the agent — wrote the file first. Their version
      // arrives via the reload event; this save is abandoned, not retried.
      state.baseHash = null;
      state.save = "idle";
      state.saveConflict = true;
      saveAttempts = 0;
      renderSave();
      holdReload();
      announce("Save conflict. Edit mode remains active so you can reload safely.");
      diagnostic("save-conflict");
      return false;
    }
    saveAttempts += 1;
    state.save = "failed";
    if (saveAttempts < 3) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return saveHtml(html, key, generation);
    }
    else toast("Couldn't save — your edits still reach the agent as feedback");
    return false;
  }
}

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

window.addEventListener("message", async (event) => {
  if (!frame.contentWindow || event.source !== frame.contentWindow) return;
  if (!state.framePolicy || event.origin !== state.framePolicy.incomingOrigin) return;
  const msg = event.data || {};
  if (
    !state.frameCapability ||
    msg.capability !== state.frameCapability ||
    msg.generation !== state.renderGeneration ||
    msg.pageKey !== state.key
  ) return;
  if (state.frameLoading && msg.type !== "eh:ready") return;

  switch (msg.type) {
    case "eh:ready": {
      if (state.readyGeneration === state.renderGeneration) return;
      clearTimeout(state.frameReadyTimer);
      state.frameReadyTimer = null;
      state.frameReadyRetries = 0;
      state.readyGeneration = state.renderGeneration;
      state.frameReadyAt = Date.now();
      const readyCapability = state.frameCapability;
      const readyIdentity = currentRender();
      const readySaveSequence = saveSequence;
      const ready = api(`/api/session/${state.sessionId}/render/${state.renderId}/ready`, {
        method: "POST",
        body: JSON.stringify({
          capability: readyCapability,
          generation: state.renderGeneration,
          pageKey: state.key,
        }),
      }).then((result) => {
        if (!sameRender(readyIdentity, currentRender())) return null;
        if (saveSequence === readySaveSequence) state.renderSourceHash = result.sourceHash || null;
        return result;
      }).catch(() => null);
      const readyState = await ready;
      if (!sameRender(readyIdentity, currentRender())) return;
      if (!readyState) {
        failFrame("The review could not confirm this document's execution policy. Reload before editing.");
        return;
      }
      state.renderTrust = {
        trustedInteractive: readyState.trustedInteractive === true,
        feedbackOnly: readyState.feedbackOnly === true,
        trustMode: readyState.trustMode || (readyState.trustedInteractive ? "trusted-file" : "script-blocked"),
        trustNotice: readyState.trustNotice,
      };
      state.page = { ...state.page, ...state.renderTrust };
      state.frameLoading = false;
      frame.dataset.sdkReady = "true";
      frame.dataset.trustedInteractive = String(readyState.trustedInteractive === true);
      toFrame({ type: "eh:anchors", comments: state.page ? state.page.comments : [] });
      if (state.reloading) {
        toFrame({ type: "eh:restoreScroll", x: state.scroll.x, y: state.scroll.y });
        state.reloading = false;
      }
      const configuration = reviewConfiguration(state.page, state.reviewMode);
      state.savePolicy = configuration.savePolicy;
      toFrame({ type: "eh:configureReview", ...configuration });
      render();
      if (state.page?.kind !== "url") {
        // Hand the SDK the on-disk HTML so it can spot self-rendering pages.
        const rawIdentity = currentRender();
        ready.then(() => {
          if (!sameRender(rawIdentity, currentRender())) return null;
          return api(`/api/page/${state.key}/raw`);
        })
          .then((raw) => {
            if (!raw || !sameRender(rawIdentity, currentRender()) || state.pendingReload) return;
            if (state.renderSourceHash && state.renderSourceHash !== raw.hash) {
              state.saveConflict = true;
              holdReload();
              return;
            }
            state.baseHash = raw.hash || null;
            if (configuration.savePolicy === "writable") toFrame({ type: "eh:raw", html: raw.html });
            scheduleResultCapture();
          })
          .catch(() => {});
      }
      void ready.then(() => refreshHistory());
      break;
    }
    case "eh:configurationApplied":
      state.configurationGeneration = state.renderGeneration;
      if (previousFrame) {
        const configuredFrame = frame;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (frame === configuredFrame && !state.frameLoading) finishFrameReplacement();
        }));
      }
      scheduleResultCapture();
      if (
        configurationWaiter &&
        msg.mode === configurationWaiter.mode &&
        msg.savePolicy === configurationWaiter.savePolicy
      ) configurationWaiter.settle(true);
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
      editMutationSequence += 1;
      void persistEdit(state.key, {
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
    case "eh:asset":
      try {
        const saved = await fetch(`/api/page/${state.key}/asset?type=${encodeURIComponent(msg.assetType || "")}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream", "x-doc-review-token": state.token },
          body: msg.bytes,
        });
        const data = await saved.json();
        if (!saved.ok) throw new Error(data.error || "could not save the pasted image");
        toFrame({ type: "eh:assetSaved", id: msg.id, src: data.src, stagedId: data.stagedId });
      } catch (err) {
        toast(err.message);
        toFrame({ type: "eh:assetFailed", id: msg.id });
      }
      break;
    case "eh:saving":
      state.domDirty = true;
      state.save = "saving";
      renderSave();
      break;
    case "eh:html":
      await saveNow(msg.html);
      break;
    case "eh:clean":
      // SDK equality is not a server acknowledgement: prior saves may still be failing.
      state.cleanObservation = {
        key: state.key, generation: state.renderGeneration,
        saveSequence, editSequence: editMutationSequence,
      };
      applyCleanObservation();
      break;
    case "eh:snapshot":
      captures.receive(msg);
      break;
    case "eh:viewChanged": {
      const suffix = `:${state.renderId}:${state.renderGeneration}`;
      for (const attempt of history.attempts) {
        if (attempt.endsWith(suffix)) history.attempts.delete(attempt);
      }
      // Only a deduplicated identity-change signal can reopen this render's
      // automatic attempt. Snapshot and ordinary mutation messages cannot.
      if (history.captureBusy) history.viewRetry = currentRender();
      else scheduleResultCapture();
      break;
    }
    case "eh:dynamic":
      state.dynamic = true;
      renderSave();
      break;
    case "eh:flushed":
      if (typeof msg.requestId === "string") flushRequests.get(msg.requestId)?.settle(true);
      else for (const request of flushRequests.values()) {
        if (!request.strict) request.settle(true);
      }
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
        if (draftCount(state)) throw new Error("Save or cancel open comment drafts before changing pages");
        await fullSaveBarrier();
        const result = await api(`/api/session/${state.sessionId}/navigate`, {
          method: "POST",
          body: JSON.stringify({ href: msg.href }),
        });
        state.scroll = { x: 0, y: 0 };
        await loadPage(result.key);
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

$("composeAdd").addEventListener("click", commitCompose);
$("composeCancel").addEventListener("click", cancelCompose);
$("composeClose").addEventListener("click", cancelCompose);
$("composeReveal").addEventListener("click", () => {
  if (!state.compose) return;
  diagnostic("reveal-target-requested");
  toFrame({ type: "eh:revealTarget", targetGeneration: state.compose.generation });
});

$("compose").addEventListener("mousedown", (event) => {
  if (event.target.closest("button")) return;
  if (event.target !== $("composeText")) $("composeText").focus();
});

$("composeText").addEventListener("compositionstart", () => {
  composeComposing = true;
});
$("composeText").addEventListener("compositionend", () => {
  composeComposing = false;
});
$("composeText").addEventListener("keydown", (event) => {
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

$("modeButton").addEventListener("click", () => {
  if ($("modeMenu").hidden) openModeMenu();
  else closeModeMenu("trigger", { restoreFocus: true });
});
$("modeMenu").addEventListener("click", (event) => {
  const item = event.target.closest("[data-mode]");
  if (item) void setReviewMode(item.dataset.mode);
});
$("modeMenu").addEventListener("keydown", (event) => {
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
$("commentsButton").addEventListener("click", openDrawer);
$("drawerClose").addEventListener("click", closeDrawer);
$("drawerBackdrop").addEventListener("click", closeDrawer);

const dismissModeMenuOutside = (event) => {
  if (!state.modeMenuOpen || event.target.closest(".mode-control")) return;
  closeModeMenu(event.type === "focusin" ? "parent-focus" : "parent-pointer");
};
document.addEventListener("pointerdown", dismissModeMenuOutside, true);
document.addEventListener("focusin", dismissModeMenuOutside, true);

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
document.addEventListener("pointerdown", dismissCommentMenuOutside, true);
document.addEventListener("focusin", dismissCommentMenuOutside, true);

async function sendFeedback({ allowUnavailable = false } = {}) {
  if (state.sending) return;
  state.sending = true;
  $("captureWarning").hidden = true;
  render();
  try {
    if (allowUnavailable && state.frameLoading && !state.domDirty && !state.saveConflict) {
      await activeSavePromise;
      await settleEditPersistence(state.key);
    } else await fullSaveBarrier();
    let snapshot = null;
    if (!allowUnavailable) snapshot = await captureStablePage();
    await api(`/api/page/${state.key}/send`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: state.sessionId, note: $("note").value.trim(),
        history: {
          renderId: state.renderId, generation: state.renderGeneration,
          semantic: snapshot?.semantic || null,
          semanticCapturedAt: snapshot?.semanticCapturedAt, view: snapshot?.view,
          expectedSourceHash: state.baseHash || state.renderSourceHash,
          allowUnavailable,
        },
      }),
    });
    $("note").value = "";
    state.sent = true;
    history.selectedId = null;
    await refreshHistory();
  } catch (err) {
    $("captureWarning").hidden = false;
    $("captureWarningText").textContent = `${err.message} Your feedback and open drafts are still here. Recapture this page, or send with missing Content comparison explicitly accepted. Available Source snapshots may still be kept; inactive pages are not recaptured automatically.`;
    $("captureTargets").replaceChildren();
    for (const target of err.targets || []) {
      const line = document.createElement("p");
      line.textContent = `${target.filename || target.key}: ${target.reason || "Capture unavailable"}`;
      if (target.key && target.key !== state.key) {
        const button = makeAction("Open page to recapture", "btn-ghost");
        button.addEventListener("click", async () => {
          try {
            if (draftCount(state)) throw new Error("Save or cancel open comment drafts before changing pages");
            await fullSaveBarrier();
            await api(`/api/session/${state.sessionId}/goto`, { method: "POST", body: JSON.stringify({ key: target.key }) });
            await loadPage(target.key);
            $("captureWarningText").textContent = "This page is ready to recapture. Other inactive pages may still need Send without comparison.";
          } catch (error) { toast(error.message); }
        });
        line.append(button);
      }
      $("captureTargets").append(line);
    }
    $("sendWithoutComparison").disabled = state.saveConflict || state.domDirty || !!editBacklogs.get(state.key)?.size;
    toast(err.message);
  } finally {
    state.sending = false;
    render();
  }
}
$("send").addEventListener("click", () => void sendFeedback());
$("recaptureBaseline").addEventListener("click", () => void sendFeedback());
$("sendWithoutComparison").addEventListener("click", () => void sendFeedback({ allowUnavailable: true }));

$("revert").addEventListener("click", async () => {
  const count = state.page.edits.length;
  if (!window.confirm(`Discard all ${count} of your edits?`)) return;
  const identity = currentRender();
  // Stop the SDK's debounced save and our own retries first, so a queued save
  // can't land after the revert and write the edits straight back.
  toFrame({ type: "eh:abortSave" });
  clearTimeout(retryTimer);
  state.baseHash = null;
  try {
    await settleEditPersistence(identity.key).catch(() => {});
    if (!sameRender(identity, currentRender())) throw new Error("The page changed before reverting. Retry on the current page.");
    editBacklogs.delete(identity.key);
    editErrors.delete(identity.key);
    const result = await api(`/api/page/${identity.key}/revert`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: state.sessionId, renderId: identity.renderId, generation: identity.generation,
      }),
    });
    if (state.key !== identity.key) return;
    state.page = result.page;
    state.save = "idle";
    state.savedAt = "";
    render();
  } catch (err) {
    toast(err.message);
  }
});

/** The session is over: freeze the page and say so. Feedback is already safe. */
function showEnded() {
  if (document.querySelector(".ended")) return;
  if (events) events.close();
  clearTimeout(retryTimer);
  const overlay = document.createElement("div");
  overlay.className = "ended";
  const title = document.createElement("h2");
  title.textContent = "Review ended";
  const line = document.createElement("p");
  line.textContent = "Unsent feedback is saved and ships next time you review this page. You can close this tab.";
  overlay.append(title, line);
  document.body.append(overlay);
}

$("endReview").addEventListener("click", async () => {
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

$("handoffCopy").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText($("handoffCmd").textContent);
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = "Copy prompt";
    }, 1600);
  } catch {
    toast("Couldn't copy — select the prompt and copy it manually");
  }
});

$("note").addEventListener("input", (event) => {
  const el = event.target;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight + 2, window.innerHeight * 0.4)}px`;
  render(); // keep the send button in step with note-only feedback
});

$("theme").addEventListener("click", () => {
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

document.addEventListener("keydown", (event) => {
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

let events = null;

function holdReload() {
  state.pendingReload = true;
  state.baseHash = null;
  clearTimeout(retryTimer);
  toFrame({ type: "eh:abortSave" });
  if (state.domDirty) state.saveConflict = true;
  $("reloadNotice").hidden = false;
  $("reloadMessage").textContent = state.domDirty || state.saveConflict
    ? "The source changed. This page has unsaved edits; reload discards those page edits, but keeps open comment drafts. Stale edits will not overwrite the new source."
    : "The source changed. Reload keeps your comment drafts as unresolved excerpts so they cannot attach to the wrong content.";
  void documentTrustControls.refresh(state.page);
  renderDocumentTrust();
  if (state.comparing) renderHistory();
}

async function reloadLatest({ explicit = false } = {}) {
  if (!explicit && (draftCount(state) || state.domDirty || state.saveConflict || state.sending)) {
    holdReload();
    return;
  }
  const key = state.key;
  advancePageEpoch("reload");
  captureEditState();
  if (state.compose) {
    state.compose.unresolved = true;
    state.compose.relation = "unavailable";
    state.compose.rects = [];
    state.compose.generation = -1;
  }
  const generation = beginFrameTransition();
  state.frameReadyRetries = 0;
  state.reloading = true;
  state.dynamic = false;
  state.baseHash = null;
  clearTimeout(retryTimer);
  state.pendingReload = false;
  state.saveConflict = false;
  state.domDirty = false;
  $("reloadNotice").hidden = true;
  try {
    const page = await api(pageUrl(key, state.sessionId));
    if (state.key !== key || state.renderGeneration !== generation) return;
    // Keep parent-owned drafts rather than replacing their text on a source update.
    replacePage(state, page);
    state.save = "idle";
    state.savedAt = "";
    render();
    if (state.compose) {
      $("compose").hidden = false;
      $("compose").classList.add("sheet");
      $("composeError").hidden = false;
      $("composeError").textContent = "The source changed. This draft keeps its original excerpt; cancel it to select a new target.";
    }
    await registerFrame(key, generation);
  } catch (err) {
    if (state.key === key && state.renderGeneration === generation) failFrame(err.message);
  }
}
$("safeReload").addEventListener("click", () => void reloadLatest({ explicit: true }));
$("keepCurrent").addEventListener("click", () => { $("reloadNotice").hidden = true; announce("Keeping the current page. Return to Latest version to reload when ready."); });
window.addEventListener("beforeunload", (event) => {
  if (!state.domDirty && !draftCount(state, $("note").value) && !editBacklogs.get(state.key)?.size) return;
  event.preventDefault();
  event.returnValue = "";
});

function connect() {
  const source = new EventSource(`/events/${state.sessionId}`);
  events = source;
  // Another window on this session hit End review.
  source.addEventListener("ended", () => showEnded());
  source.addEventListener("reload", () => void reloadLatest());
  source.addEventListener("history", () => void refreshHistory());
  source.addEventListener("agent", (event) => {
    state.agent = JSON.parse(event.data).state;
    render();
  });
  source.addEventListener("refresh", async () => {
    const key = state.key;
    advancePageEpoch("acknowledgement");
    const page = await api(pageUrl(key, state.sessionId));
    if (state.key !== key) return;
    reconcilePage(page, { syncAnchors: true, reason: "acknowledgement", advance: false });
    state.sent = false;
    render();
  });
  source.onerror = () => {
    /* EventSource reconnects on its own. */
  };
}

// -------------------------------------------------------------------- start

(async function start() {
  installStaticIcons();
  try {
    applyTheme(localStorage.getItem("doc-review:theme") === "dark");
  } catch {}

  const bootstrap = await api(`/api/session/${state.sessionId}/page`).catch(() => null);
  if (bootstrap && bootstrap.page) state.pollCommand = bootstrap.page.pollCommand;
  if (bootstrap && Number.isSafeInteger(bootstrap.generation)) state.renderGeneration = bootstrap.generation;
  const key = bootstrap ? bootstrap.key : new URLSearchParams(location.search).get("key");
  await loadPage(key);
  connect();
  void refreshHistory();
})();

window.addEventListener("resize", () => {
  positionCompose();
  if (state.activeSavedCommentId) positionAlignedCard();
});
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", positionCompose);
  window.visualViewport.addEventListener("scroll", positionCompose);
}

function attachFrameEvents(target) {
  target.addEventListener("load", () => {
    if (target !== frame) return;
    if (!state.renderId || !state.frameCapability) return;
    if (state.pendingInitialLoad) {
      state.pendingInitialLoad = false;
      return;
    }
    rotateCurrentFrame();
  });

  target.addEventListener("focus", () => {
    if (target !== frame) return;
    closeCommentMenu();
    if (state.compose) $("compose").classList.add("pass-through");
  });
}
attachFrameEvents(frame);
$("compose").addEventListener("focusin", () => $("compose").classList.remove("pass-through"));
