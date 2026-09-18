import { createControllerStore } from "./controller-store.js";
import { newestComments, type CommentEdit, type CommentSurface, type CommentUi, type OtherPageSummary } from "./chrome-session.js";
import type { FeedbackComment } from "./contracts/feedback.js";

export interface CommentsContext {
  open: boolean;
  ended: boolean;
  comparing: boolean;
  hasPage: boolean;
  error: string | null;
  composeOpen: boolean;
  comments: readonly FeedbackComment[];
  others: readonly OtherPageSummary[];
  activeId: string | null;
  orphans: ReadonlySet<string>;
  ui: CommentUi;
}
interface Options {
  read(): CommentsContext;
  close(): void;
  activate(id: string, scroll: boolean): void;
  edit(id: string, surface: CommentSurface): void;
  save(): unknown;
  cancelEdit(): void;
  confirm(id: string, surface: CommentSurface): void;
  dismiss?(): void;
  cancelDelete(): void;
  remove(id: string): unknown;
  navigate(key: string): unknown;
}
type EditInput = Pick<CommentEdit, "draft" | "selectionStart" | "selectionEnd" | "composing">;

function age(timestamp: number | undefined) {
  const seconds = Math.max(0, Math.round((Date.now() - (timestamp ?? Date.now())) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export function createCommentsController(options: Options) {
  let disposed = false;
  let sectionOpen = true;
  const store = createControllerStore(() => {
    const state = options.read();
    return {
      open: state.open && !state.comparing,
      sectionOpen,
      sectionLock: state.ui.edit ? "Save or cancel the comment edit to collapse."
        : state.ui.confirmation ? "Finish or cancel the deletion to collapse." : "",
      activeId: state.activeId,
      disabled: state.ended,
      loading: !state.hasPage && !state.error && !state.ended,
      error: !state.hasPage ? state.error : null,
      showEmpty: state.hasPage && state.comments.length === 0 && !state.composeOpen,
      cards: newestComments(state.comments).map((comment) => ({
        id: comment.id, quote: comment.quote, feedback: comment.feedback,
        age: age(comment.updatedAt || comment.createdAt),
        correction: !!comment.correction, edited: !!comment.updatedAt,
        orphaned: state.orphans.has(comment.id), active: state.activeId === comment.id,
      })),
      others: state.others.map(({ key, filename, count }) => ({ key, filename, count })),
      ui: state.ui,
    };
  });
  const available = () => !disposed && !options.read().ended && !options.read().comparing;
  const has = (id: string) => available() && options.read().comments.some((comment) => comment.id === id);
  const deleting = () => options.read().ui.confirmation?.status === "deleting";
  const editable = (id: string) => has(id) && !deleting() && (!options.read().ui.edit || options.read().ui.edit?.commentId === id);
  const ownsEdit = (id: string) => has(id) && options.read().ui.edit?.commentId === id;
  const publish = () => {
    if (disposed) return;
    const state = options.read();
    if (state.ui.edit || state.ui.confirmation) sectionOpen = true;
    store.publish();
  };
  return {
    getSnapshot: store.getSnapshot, subscribe: store.subscribe, publish,
    commands: {
      setSectionOpen(open: boolean) {
        const state = options.read();
        if (!available() || (!open && (state.ui.edit || state.ui.confirmation))) return;
        sectionOpen = open;
        publish();
      },
      close() { if (available()) options.close(); },
      activate(id: string, scroll: boolean) { if (editable(id)) options.activate(id, scroll); },
      edit(id: string, surface: CommentSurface = "drawer") {
        if (editable(id)) { sectionOpen = true; options.edit(id, surface); publish(); }
      },
      dismiss() { if (available()) options.dismiss?.(); },
      updateEdit(id: string, value: EditInput) {
        if (!ownsEdit(id)) return;
        const edit = options.read().ui.edit;
        if (!edit || edit.status === "saving") return;
        Object.assign(edit, value, { validation: value.draft === edit.draft ? edit.validation : "" });
        publish();
      },
      save(id: string) { if (ownsEdit(id) && !options.read().ui.edit?.composing) return options.save(); },
      cancelEdit(id: string) { if (ownsEdit(id)) options.cancelEdit(); },
      confirm(id: string, surface: CommentSurface = "drawer") {
        if (has(id) && !options.read().ui.edit && !deleting()) {
          sectionOpen = true;
          options.confirm(id, surface);
          publish();
        }
      },
      cancelDelete(id: string) {
        if (has(id) && !deleting() && options.read().ui.confirmation?.commentId === id) options.cancelDelete();
      },
      remove(id: string) {
        if (has(id) && options.read().ui.confirmation?.commentId === id) return options.remove(id);
      },
      navigate(key: string) {
        if (available() && options.read().others.some((page) => page.key === key)) return options.navigate(key);
      },
    },
    dispose() { disposed = true; store.dispose(); },
  };
}
export type CommentsController = ReturnType<typeof createCommentsController>;
export type CommentsSnapshot = ReturnType<CommentsController["getSnapshot"]>;
