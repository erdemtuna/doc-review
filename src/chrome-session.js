export function pageUrl(key, sessionId) {
  return `/api/page/${key}?session=${encodeURIComponent(sessionId)}`;
}

export function replacePage(state, page) {
  state.page = page;
  state.others = page.others || [];
}

/** New and newly revised feedback belongs where the reviewer can see it. */
export function newestComments(comments) {
  return [...(comments || [])].sort(
    (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
  );
}

export function modePresentation(mode) {
  return mode === "edit"
    ? { label: "Edit", icon: "pencil", description: "Direct editing on" }
    : { label: "View", icon: "eye", description: "Editing off, comments enabled" };
}

export function createCommentUi() {
  return { menu: null, confirmation: null, edit: null };
}

export function ownMenu(ui, commentId, surface, triggerId) {
  if (ui.edit) return false;
  ui.menu = { commentId, surface, triggerId };
  ui.confirmation = null;
  return true;
}

export function ownConfirmation(ui, commentId, surface) {
  if (ui.edit) return false;
  ui.menu = null;
  ui.confirmation = { commentId, surface, status: "idle" };
  return true;
}

export function ownEdit(ui, comment, surface) {
  if (ui.edit) return ui.edit.commentId === comment.id;
  ui.menu = null;
  ui.confirmation = null;
  ui.edit = {
    commentId: comment.id,
    draft: comment.feedback,
    original: comment.feedback,
    originSurface: surface,
    status: "idle",
    selectionStart: comment.feedback.length,
    selectionEnd: comment.feedback.length,
    composing: false,
    validation: "",
  };
  return true;
}

export function clearOwned(ui, kind) {
  ui[kind] = null;
  return ui;
}

export function migrateCommentUi(ui, fromId, toId) {
  for (const key of ["menu", "confirmation", "edit"]) {
    if (ui[key]?.commentId === fromId) ui[key].commentId = toId;
  }
  return ui;
}

export function reconcileCommentUi(ui, comments) {
  const ids = new Set((comments || []).map((comment) => comment.id));
  const removed = new Set();
  for (const key of ["menu", "confirmation", "edit"]) {
    if (ui[key] && !ids.has(ui[key].commentId)) {
      removed.add(ui[key].commentId);
      ui[key] = null;
    }
  }
  return removed;
}

export function mutationIsCurrent(startEpoch, currentEpoch, comments, commentId) {
  return startEpoch === currentEpoch && (comments || []).some((comment) => comment.id === commentId);
}
