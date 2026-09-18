export type CommentSurface = "drawer" | "aligned";
export interface OtherPageSummary { key: string; filename: string; count: number }
export interface CommentEdit {
  commentId: string;
  draft: string;
  original: string;
  originSurface: CommentSurface;
  status: "idle" | "saving";
  selectionStart: number;
  selectionEnd: number;
  composing: boolean;
  validation: string;
}
export interface CommentUi {
  confirmation: { commentId: string; surface: CommentSurface; status: "idle" | "deleting" } | null;
  edit: CommentEdit | null;
}

export function commentControlId(commentId: string, surface: CommentSurface, action: string) {
  const id = String(commentId).replace(/[^a-zA-Z0-9_-]/g, (char) => `-${char.codePointAt(0)!.toString(16)}-`);
  return `comment-${surface}-${id}-${action}`;
}

export function pageUrl(key: string, sessionId: string) {
  return `/api/page/${key}?session=${encodeURIComponent(sessionId)}`;
}

export function replacePage<T extends { others?: OtherPageSummary[] }>(state: { page: T | null; others: OtherPageSummary[] }, page: T) {
  state.page = page;
  state.others = page.others || [];
}

/** New and newly revised feedback belongs where the reviewer can see it. */
export function newestComments<T extends { updatedAt?: number; createdAt?: number }>(comments?: readonly T[] | null): T[] {
  return [...(comments || [])].sort(
    (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
  );
}

export function modePresentation(mode = "view") {
  return mode === "edit"
    ? { label: "Edit", icon: "pencil", description: "Direct editing on" }
    : { label: "View", icon: "eye", description: "Editing off, comments enabled" };
}

export function createCommentUi(): CommentUi {
  return { confirmation: null, edit: null };
}

export function ownConfirmation(ui: CommentUi, commentId: string, surface: CommentSurface) {
  if (ui.edit || ui.confirmation?.status === "deleting") return false;
  ui.confirmation = { commentId, surface, status: "idle" };
  return true;
}

export function ownEdit(ui: CommentUi, comment: { id: string; feedback: string }, surface: CommentSurface) {
  if (ui.edit) return ui.edit.commentId === comment.id;
  if (ui.confirmation?.status === "deleting") return false;
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

export function clearOwned(ui: CommentUi, kind: keyof CommentUi) {
  ui[kind] = null;
  return ui;
}

export function migrateCommentUi(ui: CommentUi, fromId: string, toId: string) {
  for (const key of ["confirmation", "edit"] as const) {
    if (ui[key]?.commentId === fromId) ui[key].commentId = toId;
  }
  return ui;
}

export function reconcileCommentUi(ui: CommentUi, comments: readonly { id: string }[]) {
  const ids = new Set((comments || []).map((comment) => comment.id));
  const removed = new Set<string>();
  for (const key of ["confirmation", "edit"] as const) {
    if (ui[key] && !ids.has(ui[key].commentId)) {
      removed.add(ui[key].commentId);
      ui[key] = null;
    }
  }
  return removed;
}

export function mutationIsCurrent(startEpoch: number, currentEpoch: number, comments: readonly { id: string }[] | undefined, commentId: string) {
  return startEpoch === currentEpoch && (comments || []).some((comment) => comment.id === commentId);
}
