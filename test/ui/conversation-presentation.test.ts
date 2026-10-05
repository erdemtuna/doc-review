import { expect, it } from "vitest";
import { conversationDraft } from "../../src/conversation-controller";
import { lifecyclePresentation, selectionDescription, sendAvailability, type SendReason } from "@/components/conversation-presentation";

type State = Parameters<typeof sendAvailability>[0];
const review = { reviewId: "review", entryKey: "page", version: 1, state: "open" as const, createdAt: 1, endedAt: null };
const status = { review, openThreadCount: 0, attentionEditCount: 0, pendingMessageCount: 0, pendingEditCount: 0, work: null, blockers: [] };
function state(patch: Partial<State> = {}): State {
  return { review, status, connected: true, uncertain: null, busy: false, loading: false, sendBlocked: false,
    selection: { pendingCount: 1, messages: 1, edits: 0, note: false, total: 1 }, note: conversationDraft(), ...patch };
}

const cases: [SendReason, Partial<State>, boolean?][] = [
  ["loading", { review: null }],
  ["ended", { review: { ...review, state: "ended", endedAt: 2 } }],
  ["uncertain", { uncertain: { operation: "send", requestId: "request", message: "Unknown" } }],
  ["disconnected", { connected: false, selection: null }],
  ["preparing", { busy: true }],
  ["checking", { loading: true, selection: null }],
  ["checking", {}, true],
  ["waiting", { sendBlocked: true, status: { ...status, work: { submissionId: "submission", state: "queued", version: 1 } } }],
  ["overlap", { sendBlocked: true }],
  ["unverified", { selection: null }],
  ["composing", { note: { ...conversationDraft(), composing: true } }],
  ["empty", { selection: { pendingCount: 0, messages: 0, edits: 0, note: false, total: 0 } }],
];
it.each(cases)("explains %s without enabling Send", (kind, patch, documentLoading = false) => {
  const result = sendAvailability(state(patch), documentLoading);
  expect(result.disabled).toBe(true);
  expect(result.reason?.kind).toBe(kind);
  expect(result.reason?.compact).toBeTruthy();
  expect(result.reason?.description).toBeTruthy();
});

it("preserves the existing disable guards for consistent controller snapshots", () => {
  for (const [, patch, documentLoading = false] of cases) {
    const input = state(patch);
    const original = input.review?.state !== "open" || input.busy || !!input.uncertain || documentLoading ||
      input.sendBlocked || !input.selection?.total || input.note.composing;
    expect(sendAvailability(input, documentLoading).disabled).toBe(original);
  }
  expect(sendAvailability(state(), false)).toEqual({ disabled: false, reason: null });
});

it("prioritizes recovery and does not call a locked nonempty selection ready", () => {
  const waiting = state({ sendBlocked: true, status: { ...status, work: { submissionId: "submission", state: "delivered", version: 2 } },
    selection: { pendingCount: 0, messages: 0, edits: 0, note: true, total: 1 } });
  const result = sendAvailability(waiting, false);
  expect(result.reason?.compact).toBe("Waiting for agent");
  expect(selectionDescription(waiting.selection, result)).toBe("Selected: 1 note");
  expect(sendAvailability({ ...waiting, connected: false }, false).reason?.kind).toBe("disconnected");
  expect(sendAvailability({ ...waiting, busy: true }, false).reason?.kind).toBe("preparing");
  expect(selectionDescription(state().selection, sendAvailability(state(), false))).toBe("Ready to send: 1 comment");
});

it("gates motion on confirmed own-review work, preserving lifecycle and save details", () => {
  const waiting = { ...state(), inventory: { openThreads: 0, edits: 0 },
    status: { ...status, work: { submissionId: "submission", state: "queued" as const, version: 1 } } };
  expect(lifecyclePresentation(waiting, { status: "saved" })).toMatchObject({
    label: "Waiting for agent", variant: "warning", waiting: true, animate: true,
  });
  expect(lifecyclePresentation(waiting, { status: "saved" }).description).toContain("Changes saved.");
  for (const patch of [{ connected: false }, { loading: true }, { inventory: null },
    { uncertain: { operation: "send" as const, requestId: "request", message: "Unknown" } }]) {
    expect(lifecyclePresentation({ ...waiting, ...patch }, { status: "idle" })).toMatchObject({ waiting: true, animate: false });
  }
  expect(lifecyclePresentation({ ...waiting, review: { ...review, state: "ended", endedAt: 2 } }, { status: "idle" }))
    .toMatchObject({ label: "Review ended", waiting: false, animate: false });
  expect(lifecyclePresentation({ ...waiting, status }, { status: "idle" })).toMatchObject({ label: "Reviewing", animate: false });
});
