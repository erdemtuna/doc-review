import { createControllerStore } from "./controller-store.js";
import type { FeedbackEdit } from "./contracts/feedback.js";
import type { createFeedbackController } from "./feedback-controller.js";
import type { createSaveController } from "./save-controller.js";

export interface NoteDraft {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  composing: boolean;
}
export const createNoteDraft = (): NoteDraft => ({ text: "", selectionStart: 0, selectionEnd: 0, composing: false });
type Action = "end" | "revert";
export interface FeedbackPanelContext {
  note: NoteDraft;
  ended: boolean;
  available: boolean;
  identity: string;
  source: string | null;
  edits: readonly FeedbackEdit[];
  total: number;
  drafts: number;
  agent: string;
  prompt: string;
  filename: string;
  kind: string;
  markdown: boolean;
  save: ReturnType<ReturnType<typeof createSaveController>["getSnapshot"]>;
  delivery: ReturnType<ReturnType<typeof createFeedbackController>["getSnapshot"]>;
}
interface Options {
  read(): FeedbackPanelContext;
  send(): Promise<void>;
  flush(action: Action): Promise<void>;
  revert(): Promise<void>;
  end(): Promise<void>;
  copy(text: string): Promise<void>;
  failed(message: string): void;
}
interface Confirmation {
  action: Action;
  identity: string;
  source: string | null;
  fingerprint: string;
  description: string;
  pending: boolean;
  error: string;
}
function savePresentation(state: FeedbackPanelContext) {
  if (state.save.conflict) return "Source changed — reload latest before saving. Your page edits remain in this tab.";
  if (state.kind === "url") return "Localhost page — your direct edits go to the agent for source updates";
  if (state.markdown) return "Markdown source — edits go to the agent as feedback";
  if (state.save.dynamic) return "Live page — edits go to the agent, the file is left alone";
  if (state.save.status === "saving") return `Saving to ${state.filename}…`;
  if (state.save.status === "failed") return "Couldn't save — retry before sending";
  return `Saved to ${state.filename}${state.save.savedAt ? ` · ${state.save.savedAt}` : ""}`;
}

export function createFeedbackPanelController(options: Options) {
  let disposed = false;
  let expanded = false;
  let dialog: Confirmation | null = null;
  let copyStatus: "idle" | "copying" | "copied" | "failed" = "idle";
  let copyError = "";
  const fingerprint = (action: Action, state: FeedbackPanelContext) => JSON.stringify(action === "revert"
    ? state.edits : [state.total, state.drafts, state.note.text]);
  const valid = (owned: Confirmation, full = true) => {
    const state = options.read();
    return !disposed && !state.ended && state.available && !state.delivery.sending &&
      state.identity === owned.identity && (!full ||
        (state.source === owned.source && fingerprint(owned.action, state) === owned.fingerprint));
  };
  const store = createControllerStore(() => {
    const state = options.read();
    const busy = state.delivery.sending;
    const sent = state.delivery.sent || state.agent === "working" || state.agent === "stranded";
    const count = state.total;
    const hasNote = !!state.note.text.trim();
    return {
      note: state.note, ended: state.ended, disabled: state.ended || !state.available,
      edits: expanded ? state.edits : state.edits.slice(0, 5), editCount: state.edits.length, expanded,
      saveText: savePresentation(state), saveError: state.save.conflict || state.save.status === "failed",
      saveStatus: state.save.status, drafts: state.drafts, busy, delivery: state.delivery,
      sendDisabled: state.ended || !state.available || (!count && !hasNote) || busy || sent || !!dialog || state.note.composing,
      sendText: busy ? "Sending feedback…" : state.agent === "working" ? "Feedback delivered"
        : state.agent === "stranded" ? "Sent — agent is not listening"
          : state.delivery.sent ? "Sent — waiting for agent" : count ? `Send ${count} to agent`
            : hasNote ? "Send note to agent" : "Nothing to send yet",
      agent: state.agent, prompt: state.prompt, copyStatus, copyError,
      dialog: dialog ? { ...dialog, stale: !valid(dialog) } : null,
    };
  });
  const publish = () => { if (!disposed) store.publish(); };
  const available = () => !disposed && !options.read().ended && options.read().available;
  async function send() {
    const state = options.read();
    if (!available() || dialog || state.note.composing || (!state.total && !state.note.text.trim()) ||
      state.delivery.sending || state.delivery.sent || state.agent === "working" || state.agent === "stranded") return;
    await options.send();
  }
  return {
    getSnapshot: store.getSnapshot, subscribe: store.subscribe, publish,
    commands: {
      updateNote(value: NoteDraft) {
        if (!available() || dialog) return;
        Object.assign(options.read().note, value);
        publish();
      },
      expand() { if (available()) { expanded = !expanded; publish(); } },
      send,
      open(action: Action) {
        const state = options.read();
        if (!available() || dialog || state.delivery.sending || (action === "revert" && !state.edits.length)) return;
        const drafts = state.drafts + Number(!!state.note.text.trim());
        dialog = {
          action, identity: state.identity, source: state.source, fingerprint: fingerprint(action, state),
          pending: false, error: "",
          description: action === "revert" ? `Discard all ${state.edits.length} of your edits? Comments and the overall note are kept.`
            : `${state.total ? `${state.total} unsent ${state.total === 1 ? "item will" : "items will"} be kept for next time. ` : ""}${drafts ? `${drafts} open ${drafts === 1 ? "draft (including any overall note) is" : "drafts (including any overall note) are"} only in this tab and will not be sent. ` : ""}The waiting agent will be told to stop polling.`,
        };
        publish();
      },
      cancel() { if (dialog && !dialog.pending) { dialog = null; publish(); } },
      async confirm() {
        const owned = dialog;
        if (!owned || owned.pending) return;
        if (!valid(owned)) {
          owned.error = "The page or feedback changed. Cancel and review the current state before trying again.";
          publish();
          return;
        }
        owned.pending = true;
        owned.error = "";
        publish();
        try {
          // Flush the SDK debounce window before either destructive request.
          await options.flush(owned.action);
          if (!valid(owned, false)) throw new Error("The page changed while preparing this action. Cancel and try again on the current page.");
          if (owned.action === "revert") await options.revert();
          else await options.end();
          if (!disposed && dialog === owned) dialog = null;
        } catch (error) {
          if (!disposed && dialog === owned) {
            owned.error = error instanceof Error ? error.message : String(error);
            options.failed(owned.error);
          }
        } finally {
          owned.pending = false;
          publish();
        }
      },
      async copy() {
        const prompt = options.read().prompt;
        if (!available() || !prompt || copyStatus === "copying") return;
        copyStatus = "copying";
        copyError = "";
        publish();
        try {
          await options.copy(prompt);
          if (!disposed) copyStatus = "copied";
        } catch {
          if (!disposed) {
            copyStatus = "failed";
            copyError = "Couldn't copy — select the prompt and copy it manually";
            options.failed(copyError);
          }
        }
        publish();
      },
    },
    dispose() { disposed = true; dialog = null; store.dispose(); },
  };
}
export type FeedbackPanelController = ReturnType<typeof createFeedbackPanelController>;
