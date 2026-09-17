/**
 * doc-review chrome. Owns the toolbar, contextual surfaces, drawer, and every
 * call to the local server.
 * It never touches the artifact DOM directly — the SDK does that, over
 * postMessage, because the artifact iframe lives on the other loopback
 * hostname: a separate origin that can never reach this page or its token.
 */
import {
  clearOwned,
  commentControlId as controlId,
  createCommentUi,
  migrateCommentUi,
  mutationIsCurrent,
  ownConfirmation,
  ownEdit,
  newestComments,
  pageUrl,
  reconcileCommentUi,
  replacePage,
} from "./chrome-session.js";
import { sanitizeClientRects, sanitizeClipRect, sanitizeRelation } from "./comment-target.js";
import { externalHref } from "./editing.js";
import { framePolicy } from "./frame-policy.js";
import { createIcon } from "./icons.js";
import { executionPresentation } from "./execution-client.js";
import { createToolbarController } from "./toolbar-controller.js";
import { createRecoveryController } from "./recovery-controller.js";
import { createCommentsController } from "./comments-controller.js";
import { createComposerDraft, createContextualController } from "./contextual-controller.js";
import { alignedCardPosition, placeContextualSurface, visibleViewport } from "./positioning.js";
import { normalizeReviewMode, reviewConfiguration } from "./review-mode.js";
import { createCaptureRequests, captureError, sameRender, draftCount, pendingCaptureTarget } from "./history-client.js";
import { createCaptureCoordinator, createHistoryController, requireCaptureSuccess } from "./history-coordinator.js";

import { createReviewApi, decodePage } from "./chrome-api.js";
import { createFrameHost } from "./frame-host.js";
import { createFrameController } from "./frame-controller.js";
import { createSaveController } from "./save-controller.js";
import { createFeedbackController } from "./feedback-controller.js";
import { createFeedbackPanelController, createNoteDraft } from "./feedback-panel-controller.js";
import { createChangesController } from "./changes-controller.js";
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
  composerDraft: createComposerDraft(),
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
  restoreModeFocus: false,
  theme: "light",
  drawerOpen: false,
  agent: "idle",
  orphans: new Set(),
  pollCommand: "",
  noteDraft: createNoteDraft(),
  others: [],
  scroll: { x: 0, y: 0 },
  comparing: false,
  executionPreference: null,
  ended: false,
  reloadVisible: false,
  reloadMessage: "",
  reloadFailed: false,
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
    // A mounted React editor already owns its live selection; delayed focus must not reset it.
    if (document.activeElement === input) return;
    input.focus();
    input.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  });
}

function moveTransientSurface(surface) {
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
}

function openModeMenu() {
  if (state.modeMenuOpen) return;
  recoveryRuntime.commands.setMenuOpen(false, { restoreFocus: false });
  state.modeMenuOpen = true;
  state.restoreModeFocus = true;
  toolbarRuntime.publish();
  toFrame({ type: "eh:modeMenuState", open: true });
}

function closeModeMenu(reason = "dismissed", { restoreFocus = false } = {}) {
  if (!state.modeMenuOpen) return false;
  state.modeMenuOpen = false;
  state.restoreModeFocus = restoreFocus;
  toolbarRuntime.publish();
  toFrame({ type: "eh:modeMenuState", open: false });
  diagnostic("mode-menu-close", { reason });
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
  contextualRuntime.publish();
  diagnostic("composer-lifecycle-transition", { from, to: next, reason });
}

function setComposePlacement(next) {
  if (state.composePlacement === next) return;
  const from = state.composePlacement;
  state.composePlacement = next;
  contextualRuntime.publish();
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
    state.reloadVisible = true;
    state.reloadFailed = true;
    state.reloadMessage = `${message} Reload keeps your comment drafts.`;
    recoveryRuntime.publish();
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
  note: () => state.noteDraft.text,
  clearNote(sent) {
    if (state.noteDraft.text === sent && !state.noteDraft.composing) Object.assign(state.noteDraft, createNoteDraft());
  },
  pauseCapture() {
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

export const recoveryRuntime = createRecoveryController({
  request: api,
  sessionId: state.sessionId,
  read: () => ({
    page: state.page, rendered: frameHost.visibleExecution, identity: frameController.identity(),
    comparing: state.comparing, ended: state.ended, loading: frameController.loading,
    pendingReload: frameController.state.pendingReload || !!frameHost.previous,
    frameError: frameController.state.phase.kind === "failed" ? frameController.state.phase.message : null,
    reload: {
      visible: state.reloadVisible, message: state.reloadMessage,
      error: state.reloadFailed || saveController.state.conflict,
    },
  }),
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
  failed: toast,
  menuChanged(open) {
    if (open) {
      closeModeMenu("recovery-menu");
    }
    toFrame({ type: "eh:modeMenuState", open });
  },
  reload: () => reloadLatest({ explicit: true }),
  keepCurrent() {
    state.reloadVisible = false;
    announce("Keeping the current page. Return to Review to reload when ready.");
  },
});
reviewController.own(() => recoveryRuntime.dispose());

export const toolbarRuntime = createToolbarController(() => ({
  comparing: state.comparing,
  mode: normalizeReviewMode(state.reviewMode),
  modeDisabled: state.modeApplying || state.comparing || feedbackController.sending || !frameController.state.execution,
  modeMenuOpen: state.modeMenuOpen,
  restoreModeFocus: state.restoreModeFocus,
  editDescription: executionPresentation(state.page, frameHost.visibleExecution).editDescription,
  drawerOpen: state.drawerOpen,
  commentCount: state.page?.comments?.length || 0,
  theme: state.theme === "dark" ? "dark" : "light",
  ended: state.ended,
}), {
  setComparing: setHistoryView,
  setMode: (mode) => { void setReviewMode(mode); },
  setModeMenu: (open) => {
    if (open) openModeMenu();
    else closeModeMenu("dismissed", { restoreFocus: true });
  },
  openComments: openDrawer,
  toggleTheme,
});
reviewController.own(() => toolbarRuntime.dispose());

export const commentsRuntime = createCommentsController({
  read: () => ({
    open: state.drawerOpen, ended: state.ended, comparing: state.comparing,
    hasPage: !!state.page, composeOpen: !!state.compose,
    error: frameController.state.phase.kind === "failed" ? frameController.state.phase.message : null,
    comments: state.page?.comments || [], others: state.others || [],
    activeId: state.activeSavedCommentId, orphans: state.orphans, ui: state.commentUi,
  }),
  close: closeDrawer,
  activate: setActive,
  edit: (id, surface) => startCommentEdit(commentById(id), surface),
  save: saveCommentEdit,
  cancelEdit: cancelCommentEdit,
  confirm: confirmCommentDelete,
  dismiss: () => dismissActiveComment("close", { restoreFocus: true }),
  cancelDelete: cancelDeleteConfirmation,
  remove: deleteComment,
  async navigate(key) {
    try { await reviewController.navigate({ key }); }
    catch (err) { toast(`${err.message}. Stay on this page and retry.`); }
  },
});
reviewController.own(() => commentsRuntime.dispose());

export const contextualRuntime = createContextualController({
  read: () => ({
    open: !!state.compose, disabled: state.ended || state.comparing,
    submitting: state.composeLifecycle === "submitting",
    kind: state.compose?.kind || "selection", quote: state.compose?.quote || "",
    placement: state.composePlacement, draft: state.composerDraft,
  }),
  submit: commitCompose, cancel: cancelCompose,
  reveal() {
    if (!state.compose || state.compose.unresolved) return;
    diagnostic("reveal-target-requested");
    toFrame({ type: "eh:revealTarget", targetGeneration: state.compose.generation });
  },
  focus() { $("compose").classList.remove("pass-through"); },
  measure: scheduleContextualPosition,
});
reviewController.own(() => contextualRuntime.dispose());

export const feedbackRuntime = createFeedbackPanelController({
  read: () => ({
    note: state.noteDraft, ended: state.ended,
    available: !!state.page && !frameController.loading && !state.comparing,
    identity: JSON.stringify([frameController.state.key, frameController.state.renderId, frameController.state.generation, state.pageEpoch, frameController.state.pendingReload]),
    source: frameController.state.sourceHash,
    edits: state.page?.edits || [],
    total: (state.page?.comments?.length || 0) + (state.page?.edits?.length || 0) +
      (state.others || []).reduce((sum, other) => sum + other.count, 0),
    drafts: draftCount(state), agent: state.agent,
    prompt: handoffPrompt(state.pollCommand || state.page?.pollCommand),
    filename: state.page?.filename || "", kind: state.page?.kind || "", markdown: !!state.page?.markdown,
    save: saveController.getSnapshot(), delivery: feedbackController.getSnapshot(),
  }),
  send: () => feedbackController.send(),
  async flush(action) {
    if (action === "revert") {
      // Revert owns save ordering and can discard edits that failed to persist.
      await frameController.flush(true);
    } else {
      await flushFrame({ strict: true });
      await saveController.settled();
    }
  },
  revert: () => saveController.revert(),
  async end() {
    await api(`/api/session/${state.sessionId}/end`, { method: "POST" });
    showEnded();
  },
  copy: (text) => navigator.clipboard.writeText(text),
  failed: toast,
});
reviewController.own(() => feedbackRuntime.dispose());
reviewController.own(frameController.subscribe(() => feedbackRuntime.publish()));
let contextualFrame = null;
function scheduleContextualPosition() {
  if (contextualFrame !== null || uiLifetime.signal.aborted) return;
  contextualFrame = requestAnimationFrame(() => {
    contextualFrame = null;
    if (uiLifetime.signal.aborted) return;
    positionCompose();
    positionAlignedCard();
  });
}
const contextualObserver = new ResizeObserver(scheduleContextualPosition);
for (const host of [$("compose"), $("alignedCard"), $("noticesRoot"), document.querySelector(".document-host")]) {
  contextualObserver.observe(host);
}
reviewController.own(() => {
  contextualObserver.disconnect();
  if (contextualFrame !== null) cancelAnimationFrame(contextualFrame);
  contextualFrame = null;
});

const toolbar = document.querySelector(".toolbar");
const toolbarObserver = new ResizeObserver(() => {
  document.documentElement.style.setProperty("--toolbar-h", `${toolbar.getBoundingClientRect().height}px`);
});
toolbarObserver.observe(toolbar);
reviewController.own(() => toolbarObserver.disconnect());

function renderExecution() {
  recoveryRuntime.publish();
  toolbarRuntime.publish();
  commentsRuntime.publish();
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
  closeModeMenu("selection", { restoreFocus: true });
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
  state.reloadVisible = false;
  state.reloadFailed = false;
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
  state.composerDraft = createComposerDraft();
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

// -------------------------------------------------------------------- render

function render() {
  if (state.ended) return;
  toolbarRuntime.publish();
  const page = state.page;
  if (!page) {
    commentsRuntime.publish();
    contextualRuntime.publish();
    return;
  }
  // Source updates cannot change the policy of a frame awaiting draft-safe reload.
  if (frameController.state.execution) Object.assign(page, frameController.state.execution);
  if (state.executionPreference) page.executionPreference = state.executionPreference;
  renderExecution();
  syncFrameInteraction();
  const editWasFocused = skipEditCaptureOnce ? false : captureEditState();
  skipEditCaptureOnce = false;
  commentsRuntime.publish();
  document.title = page.filename || 'doc-review';

  // Stable outer hosts are the bounded geometry adapter; React owns their controls.
  $("compose").hidden = !state.compose;
  contextualRuntime.publish();
  scheduleContextualPosition();

  feedbackRuntime.publish();
  restoreTransientFocus(editWasFocused);
}

function positionCompose() {
  if (!state.compose || state.composeLifecycle === "closed") {
    $("compose").hidden = true;
    setComposePlacement("hidden");
    return;
  }
  if (state.compose.unresolved) {
    const surface = $("compose");
    surface.hidden = false;
    surface.classList.add("sheet");
    surface.classList.remove("edge-top", "edge-bottom");
    surface.style.left = "";
    surface.style.top = "";
    surface.style.width = "";
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

function confirmCommentDelete(id, surface) {
  if (!commentById(id)) return;
  if (!ownConfirmation(state.commentUi, id, surface)) {
    focusCurrentCommentEdit();
    return;
  }
  requestControlFocus(controlId(id, surface, "confirm-delete"));
  render();
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
    width: host.offsetWidth || 300,
    height: host.offsetHeight || 180,
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

async function deleteComment(id) {
  if (deleteFlights.has(id)) return deleteFlights.get(id);
  const confirmation = state.commentUi.confirmation;
  if (!confirmation || confirmation.commentId !== id || confirmation.status === "deleting") return false;
  confirmation.status = "deleting";
  render();
  const startEpoch = state.pageEpoch;
  const index = newestComments(state.page.comments).findIndex((comment) => comment.id === id);
  const flight = (async () => {
    try {
      const result = await api(`/api/page/${frameController.state.key}/comment/${id}`, { method: "DELETE" });
      if (!mutationIsCurrent(startEpoch, state.pageEpoch, state.page?.comments, id)) return false;
      reconcilePage(result.page, { reason: "mutation" });
      toFrame({ type: "eh:remove", id });
      state.activeGeometry.delete(id);
      if (state.activeSavedCommentId === id) state.activeSavedCommentId = null;
      if (state.drawerOpen) {
        const remaining = newestComments(state.page.comments);
        const next = remaining[Math.min(index, remaining.length - 1)];
        requestControlFocus(next ? controlId(next.id, "drawer", "delete") : "commentsSection");
      }
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
  const triggerId = controlId(confirmation.commentId, confirmation.surface, "delete");
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
    if (state.drawerOpen) requestControlFocus(controlId(replacement?.id || id, "drawer", "edit"));
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
  feedbackRuntime.publish();
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
  const identity = currentRender();
  const pageKey = frameController.state.key;
  if (state.compose && state.compose.generation === detail.generation) {
    if (state.composeLifecycle === "closed") setComposeLifecycle("open", "accepted");
    $("composeText").focus();
    return true;
  }
  if (state.compose && state.composerDraft.text.trim()) {
    const submitted = await commitCompose();
    if (!submitted) {
      diagnostic("comment-retarget-blocked", { reason: "submit-failed" });
      return false;
    }
  } else if (state.compose) {
    cancelCompose({ restoreFocus: false, preserveRetarget: true });
  }
  if (state.ended || pageKey !== frameController.state.key || !sameRender(identity, currentRender())) return false;
  dismissActiveComment("composer-open");
  state.compose = detail;
  state.composerDraft = createComposerDraft();
  setComposeLifecycle("open", "accepted");
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
  state.composerDraft = createComposerDraft();
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
  const draft = state.composerDraft;
  const feedback = draft.text.trim();
  if (!compose || !feedback || draft.composing || state.ended) return false;
  const startEpoch = state.pageEpoch;
  const identity = currentRender();
  const targetGeneration = compose.generation;
  const current = () => !state.ended && state.compose === compose && state.composerDraft === draft;
  draft.error = "";
  setComposeLifecycle("submitting", "submit");
  diagnostic("comment-submit-executed");
  try {
    const result = await api(`/api/page/${identity.key}/comment`, {
      method: "POST",
      body: JSON.stringify({ kind: compose.kind, quote: compose.quote, anchor: compose.unresolved ? null : compose.anchor, feedback }),
    });
    if (!current()) return false;
    if (startEpoch !== state.pageEpoch || !sameRender(identity, currentRender())) {
      draft.error = "The page changed while this comment was saving. Your draft is preserved; check the comments before retrying.";
      draft.retry = true;
      setComposeLifecycle("open", "stale-submit");
      render();
      return false;
    }
    if (!compose.unresolved) toFrame({
      type: "eh:commit",
      id: result.comment.id,
      targetGeneration,
      restoreFocus: true,
    });
    state.compose = null;
    state.composerDraft = createComposerDraft();
    setComposeLifecycle("closed", "submitted");
    setComposePlacement("hidden");
    state.page = result.page;
    feedbackController.clearSent();
    render();
    announce("Comment added");
    return true;
  } catch (err) {
    if (!current()) return false;
    draft.error = `${err.message}. Retry or cancel.`;
    draft.retry = true;
    diagnostic("comment-request-failure", { status: err.status || 0 });
    announce("Comment could not be saved. Your draft is still here.");
    setComposeLifecycle("open", "submit-failed");
    render();
    $("compose").classList.remove("pass-through");
    afterPaint(() => $("composeText").focus());
    return false;
  }
}

// ------------------------------------------------------------ review history

const currentRender = () => frameController.identity();
const captures = createCaptureRequests({ send: toFrame, current: currentRender });
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

const refreshHistory = () => state.ended ? Promise.resolve(false) : historyController.refresh();

export const changesRuntime = createChangesController({
  read: () => ({
    history, ended: state.ended, comparing: state.comparing, sending: feedbackController.sending,
    current: {
      key: frameController.state.key, kind: state.page?.kind,
      ready: !frameController.loading && !!frameController.state.readyAt,
      pendingReload: frameController.state.pendingReload,
      dirty: saveController.state.dirty || saveController.state.conflict,
      sourceHash: frameController.state.sourceHash || saveController.state.baseHash,
      sessionId: state.sessionId, generation: frameController.state.generation,
    },
  }),
  selectRound: (id) => historyController.selectRound(id),
  selectTarget: (key) => historyController.selectTarget(key),
  selectMode(mode) {
    history.preferredMode = mode;
    history.mode = mode;
    history.index = 0;
    renderHistory();
  },
  selectIndex(index) { history.index = index; renderHistory(); },
  capture: () => captureResult(history.round, selectedTarget()),
  finish: () => finishCapture(),
  refresh: refreshHistory,
  failed: toast,
});
reviewController.own(() => changesRuntime.dispose());
reviewController.own(frameController.subscribe(() => changesRuntime.publish()));
reviewController.own(saveController.subscribe(() => changesRuntime.publish()));
reviewController.own(feedbackController.subscribe(() => changesRuntime.publish()));

function renderHistory() {
  if (state.ended) return;
  syncFrameInteraction();
  changesRuntime.publish();
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
    history.failures.set(`${roundId(round)}:${target.key}`, `${err.message} Use Capture result to retry; existing captures are unchanged.`);
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
  changesRuntime.publish();
  closeModeMenu("history-switch");
  document.body.classList.toggle("comparing", comparing);
  syncFrameInteraction();
  frameHost.current.setAttribute("aria-hidden", String(comparing));
  $("historyPanel").hidden = !comparing;
  if (!comparing && frameController.state.pendingReload) state.reloadVisible = true;
  if (comparing) {
    closeDrawer();
    void refreshHistory();
  }
  render();
}
async function finishCapture() {
  const target = selectedTarget();
  const round = history.round;
  if (!target || !round || history.finalizing || history.captureBusy) return;
  history.finalizing = true;
  renderHistory();
  try {
    const result = await api(historyUrl(`/${roundId(round)}/capture`), {
      method: "POST",
      body: JSON.stringify({ key: target.key, manual: true, finalUnavailable: true }),
    });
    requireCaptureSuccess(result, target.key);
    history.failures.delete(`${roundId(round)}:${target.key}`);
    await refreshHistory();
    announce("Finished with available snapshots. Missing Content remains unavailable.");
  } catch (err) {
    history.failures.set(`${roundId(round)}:${target.key}`, `${err.message} The capture is still open; you can retry.`);
  } finally {
    history.finalizing = false;
    renderHistory();
  }
}

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
        scheduleContextualPosition();
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
        scheduleContextualPosition();
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
      recoveryRuntime.commands.setMenuOpen(false, { restoreFocus: false });
      break;
    case "eh:dismiss":
      if (!state.composerDraft.text.trim()) cancelCompose();
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

/** The session is over: freeze the page and say so. Feedback is already safe. */
function showEnded() {
  if (document.querySelector(".ended")) return;
  state.ended = true;
  state.modeMenuOpen = false;
  toolbarRuntime.publish();
  recoveryRuntime.publish();
  commentsRuntime.publish();
  contextualRuntime.publish();
  feedbackRuntime.publish();
  changesRuntime.publish();
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

function toggleTheme() {
  const dark = document.documentElement.dataset.theme !== "dark";
  applyTheme(dark);
  try {
    localStorage.setItem("doc-review:theme", dark ? "dark" : "light");
  } catch (error) {
    diagnostic("theme-preference-save-failed", { message: error.message });
    announce("Theme changed for this review, but the preference could not be saved.");
  }
}

function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  state.theme = dark ? "dark" : "light";
  toolbarRuntime.publish();
}

listen(document, "keydown", (event) => {
  if (event.defaultPrevented || feedbackRuntime.getSnapshot().dialog) return;
  const meta = event.metaKey || event.ctrlKey;
  // ⌘S is reassurance only: flush pending keystrokes, never a state change.
  if (meta && event.key.toLowerCase() === "s") {
    event.preventDefault();
    toFrame({ type: "eh:flush" });
    renderSave();
    return;
  }
  if (event.key !== "Escape") return;
  let handled = false;
  if (state.commentUi.confirmation) handled = cancelDeleteConfirmation();
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
  state.reloadVisible = true;
  state.reloadFailed = false;
  state.reloadMessage = saveController.state.dirty || saveController.state.conflict
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
  state.reloadVisible = false;
  frameController.startReload();
  saveController.reset();
  try {
    const page = await api(pageUrl(key, state.sessionId), undefined, decodePage);
    if (frameController.state.key !== key || frameController.state.generation !== generation) return;
    state.executionPreference = page.executionPreference || null;
    // Keep parent-owned drafts rather than replacing their text on a source update.
    replacePage(state, page);
    saveController.reset();
    if (state.compose) {
      state.composerDraft.error = "The source changed. This draft keeps its original excerpt; cancel it to select a new target.";
    }
    render();
    await registerFrame(key, generation);
  } catch (err) {
    if (frameController.state.key === key && frameController.state.generation === generation) failFrame(err.message);
  }
}
listen(window, "beforeunload", (event) => {
  if (!saveController.state.dirty && !draftCount(state, state.noteDraft.text) && !saveController.queued(frameController.state.key)) return;
  event.preventDefault();
  event.returnValue = "";
});
listen(window, "pagehide", (event) => {
  if (event.persisted) return;
  state.ended = true;
  state.modeMenuOpen = false;
  toolbarRuntime.publish();
  recoveryRuntime.publish();
  commentsRuntime.publish();
  contextualRuntime.publish();
  changesRuntime.publish();
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
  } catch (error) {
    applyTheme(false);
    diagnostic("theme-preference-read-failed", { message: error.message });
  }

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

listen(window, "resize", scheduleContextualPosition);
if (window.visualViewport) {
  listen(window.visualViewport, "resize", scheduleContextualPosition);
  listen(window.visualViewport, "scroll", scheduleContextualPosition);
}

reviewController.own(frameHost.onFocus(() => {
  if (state.compose) $("compose").classList.add("pass-through");
}));
