import type { ConversationController } from "../../conversation-controller";
import type { ConversationShell } from "../../conversation-shell";

type Snapshot = ReturnType<ConversationController["getSnapshot"]>;
type SendState = Pick<Snapshot, "review" | "uncertain" | "connected" | "busy" | "loading" | "sendBlocked" | "status" | "selection" | "note">;
type LifecycleState = Pick<Snapshot, "review" | "status" | "connected" | "uncertain" | "loading" | "inventory">;
type SaveState = ReturnType<ConversationShell["getSnapshot"]>["save"];

const sendReasons = {
  loading: { compact: "Loading review", description: "The review is still loading. Feedback cannot be sent yet." },
  ended: { compact: "Review ended", description: "This review has ended. Feedback is read-only." },
  uncertain: { compact: "Check receipt", description: "A request's acceptance is unconfirmed. Check its receipt before sending feedback." },
  disconnected: { compact: "Connection lost", description: "Connection lost. Reconnect to verify what is ready to send." },
  preparing: { compact: "Preparing feedback", description: "Preparing feedback. Wait for the current operation to finish." },
  checking: { compact: "Checking feedback", description: "Checking what is ready to send. Wait for the review to finish loading." },
  waiting: { compact: "Waiting for agent", description: "Waiting for agent. You can keep adding comments, but can't send another batch yet." },
  overlap: { compact: "Another review is waiting for agent", description: "Another review is waiting for agent on this page. Send is unavailable until that work is handled." },
  unverified: { compact: "Couldn't verify feedback", description: "Couldn't check what's ready to send. Refresh the review." },
  composing: { compact: "Finish composing", description: "Finish composing the note before sending." },
  empty: { compact: "Nothing ready to send", description: "Nothing ready to send yet. Save a comment or edit, or write a note." },
} satisfies Record<string, { compact: string; description: string }>;

export type SendReason = keyof typeof sendReasons;
export type SendAvailability =
  | { disabled: false; reason: null }
  | { disabled: true; reason: { kind: SendReason; compact: string; description: string } };

export function sendAvailability(state: SendState, documentLoading: boolean): SendAvailability {
  const blocked = (kind: SendReason): SendAvailability => ({ disabled: true, reason: { kind, ...sendReasons[kind] } });
  if (!state.review) return blocked("loading");
  if (state.review.state === "ended") return blocked("ended");
  if (state.uncertain) return blocked("uncertain");
  if (!state.connected) return blocked("disconnected");
  if (state.busy) return blocked("preparing");
  if (documentLoading || state.loading) return blocked("checking");
  if (state.sendBlocked) return blocked(state.status?.work ? "waiting" : "overlap");
  if (!state.selection) return blocked("unverified");
  if (state.note.composing) return blocked("composing");
  if (!state.selection.total) return blocked("empty");
  return { disabled: false, reason: null };
}

export function selectionDescription(selection: Snapshot["selection"], availability: SendAvailability): string {
  if (!selection?.total) return "";
  const items = [
    selection.messages ? `${selection.messages} comment${selection.messages === 1 ? "" : "s"}` : "",
    selection.edits ? `${selection.edits} edit${selection.edits === 1 ? "" : "s"}` : "",
    selection.note ? "1 note" : "",
  ].filter(Boolean).join(" · ");
  return `${availability.disabled ? "Selected" : "Ready to send"}: ${items}`;
}

export function lifecyclePresentation(state: LifecycleState, save: Pick<SaveState, "status">) {
  const ended = state.review?.state === "ended";
  const work = state.status?.work;
  const workDetails = !work ? "" : work.state === "queued"
    ? "Your feedback is waiting for the agent."
    : "The agent has your feedback. Waiting for a response.";
  const label = !state.review ? "Loading review" : ended ? "Review ended" : work ? "Waiting for agent" : "Reviewing";
  const variant: "quiet" | "secondary" | "warning" | "outline" = !state.review ? "quiet" : ended ? "secondary" : work ? "warning" : "outline";
  const description = [
    !state.review ? "Loading the shared review." : ended
      ? `This review has ended. Unsent messages and edits remain available to read.${work ? " Work already sent to the agent can still finish." : ""}`
      : work ? workDetails : "Review the page, add feedback, or switch to Edit. Saved feedback stays here until you choose Send to agent.",
    ended && workDetails,
    save.status === "saved" ? "Changes saved." : save.status === "saving" ? "Saving changes." : null,
  ].filter(Boolean).join(" ");
  return {
    label, variant, description, waiting: !!state.review && !ended && !!work,
    animate: !!state.review && !ended && !!work && state.connected && !state.uncertain && !state.loading && state.inventory !== null,
  };
}
