import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createFeedbackPanelController, createNoteDraft, type FeedbackPanelContext } from "../../src/feedback-panel-controller";
import { FeedbackEdits, FeedbackFooter, FeedbackConfirmation } from "@/components/feedback";

afterEach(cleanup);
function fixture() {
  const context: FeedbackPanelContext = {
    note: createNoteDraft(), ended: false, available: true, identity: "p-r-1", source: "hash",
    edits: [], total: 0, drafts: 0, agent: "idle", prompt: "Run poll",
    filename: "file.html", kind: "file", markdown: false,
    save: { status: "idle", savedAt: "", conflict: false, dirty: false, dynamic: false, baseHash: "hash" },
    delivery: { phase: "idle", sending: false, sent: false },
  };
  const end = vi.fn();
  const runtime = createFeedbackPanelController({
    read: () => context, send: vi.fn(), flush: async () => {}, revert: vi.fn(), end,
    copy: vi.fn(), failed: vi.fn(),
  });
  render(<StrictMode><FeedbackEdits runtime={runtime}/><FeedbackFooter runtime={runtime}/><FeedbackConfirmation runtime={runtime}/></StrictMode>);
  return { runtime, context, end };
}
it("keeps the session note and textarea node across unrelated publications", () => {
  const { context, runtime } = fixture();
  const note = screen.getByLabelText("Overall note");
  fireEvent.change(note, { target: { value: "Keep note", selectionStart: 3, selectionEnd: 5 } });
  expect(context.note.text).toBe("Keep note");
  act(() => { context.agent = "working"; runtime.publish(); });
  expect(screen.getByLabelText("Overall note")).toBe(note);
  expect(note).toHaveValue("Keep note");
  expect(screen.getByRole("button", { name: "Feedback delivered" })).toBeDisabled();
});
it("shows conflicts and nonblocking capture notices without introducing another send gate", () => {
  const { context, runtime } = fixture();
  act(() => {
    context.save = { ...context.save, conflict: true };
    context.delivery = { phase: "delivered", notice: "Feedback sent. Content comparison may be incomplete.", sending: false, sent: true };
    context.total = 1;
    runtime.publish();
  });
  expect(screen.getByText(/Source changed — reload latest/)).toBeVisible();
  expect(screen.getByText("Feedback sent. Content comparison may be incomplete.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Recapture and send" })).toBeNull();
});
it("Cancel is safe and the confirmation does not submit automatically", async () => {
  const { runtime, end } = fixture();
  fireEvent.click(screen.getByRole("button", { name: "End review" }));
  expect(screen.getByRole("alertdialog")).toBeVisible();
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(end).not.toHaveBeenCalled();
  expect(runtime.getSnapshot().dialog).toBeNull();
});

it("keeps save problems visible with Edits collapsed and preserves the note and edit list", () => {
  const { context, runtime } = fixture();
  act(() => {
    context.edits = [{ label: "Headline", kind: "edited" }];
    context.total = 1;
    runtime.publish();
  });
  const note = screen.getByLabelText("Overall note");
  fireEvent.change(note, { target: { value: "Still here" } });
  const edit = screen.getByText("Headline");
  fireEvent.click(screen.getByRole("button", { name: "Edits" }));
  expect(edit).not.toBeVisible();
  expect(edit).toBeInTheDocument();
  act(() => { context.save = { ...context.save, status: "failed" }; runtime.publish(); });
  expect(screen.getByRole("alert")).toHaveTextContent("Couldn't save");
  expect(screen.getByRole("alert")).toBeVisible();
  expect(screen.getByRole("button", { name: "Edits" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByLabelText("Overall note")).toBe(note);
  expect(note).toHaveValue("Still here");
  fireEvent.click(screen.getByRole("button", { name: "Edits" }));
  expect(screen.getByText("Headline")).toBe(edit);
  expect(edit).toBeVisible();
});

it("places End then Send after the note and collapses the empty supporting region", () => {
  fixture();
  const note = screen.getByLabelText("Overall note");
  const end = screen.getByRole("button", { name: "End review" });
  const send = screen.getByRole("button", { name: "Nothing to send yet" });
  expect(note.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(end.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(document.querySelector(".feedback-secondary")).toHaveAttribute("hidden");
});
