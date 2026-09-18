import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Composer, AlignedComment } from "../../src/ui/components/contextual";
import { createComposerDraft, createContextualController, type ContextualContext } from "../../src/contextual-controller.js";
import { createCommentsController, type CommentsContext } from "../../src/comments-controller.js";
import { createCommentUi, ownEdit } from "../../src/chrome-session.js";

afterEach(cleanup);
function fixture() {
  const state: ContextualContext = { open: true, disabled: false, submitting: false, kind: "text", quote: "Chosen excerpt", placement: "attached", draft: createComposerDraft() };
  const submit = vi.fn(), cancel = vi.fn(), reveal = vi.fn();
  const runtime = createContextualController({ read: () => state, submit, cancel, reveal, focus: vi.fn(), measure: vi.fn() });
  return { state, runtime, submit, cancel, reveal };
}
it("preserves composer field, text and caret on geometry and failure updates", () => {
  const { state, runtime } = fixture();
  render(<StrictMode><Composer runtime={runtime} /></StrictMode>);
  const field = screen.getByLabelText<HTMLTextAreaElement>("Comment");
  fireEvent.change(field, { target: { value: "Keep this text", selectionStart: 2, selectionEnd: 6 } });
  field.setSelectionRange(2, 6);
  fireEvent.select(field);
  act(() => { state.placement = "edge-top"; state.draft.error = "Unavailable. Retry."; state.draft.retry = true; runtime.publish(); });
  expect(screen.getByLabelText("Comment")).toBe(field);
  expect(field.value).toBe("Keep this text");
  expect([field.selectionStart, field.selectionEnd]).toEqual([2, 6]);
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe("Unavailable. Retry.");
});
it("remounts from the session-owned text and selection without resetting it", () => {
  const { state, runtime } = fixture();
  state.draft = { ...createComposerDraft(), text: "Existing draft", selectionStart: 3, selectionEnd: 8 };
  runtime.publish();
  const mounted = render(<Composer runtime={runtime} />);
  mounted.unmount();
  render(<StrictMode><Composer runtime={runtime} /></StrictMode>);
  const field = screen.getByLabelText<HTMLTextAreaElement>("Comment");
  expect(field.value).toBe("Existing draft");
  expect([field.selectionStart, field.selectionEnd]).toEqual([3, 8]);
});
it("owns Enter, Shift+Enter, Escape and IME without duplicate handlers", () => {
  const { runtime, submit, cancel } = fixture();
  render(<Composer runtime={runtime} />);
  const field = screen.getByLabelText("Comment");
  fireEvent.compositionStart(field);
  fireEvent.keyDown(field, { key: "Enter", isComposing: true });
  fireEvent.keyDown(field, { key: "Escape", isComposing: true });
  expect(submit).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  fireEvent.compositionEnd(field);
  fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: "Enter" });
  fireEvent.keyDown(field, { key: "Escape" });
  expect(submit).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
});
it("keeps pending draft read-only with disabled cancel and exposes reveal command", () => {
  const { state, runtime, reveal, cancel } = fixture();
  state.placement = "edge-bottom";
  state.submitting = true;
  runtime.publish();
  render(<Composer runtime={runtime} />);
  expect(screen.getByLabelText<HTMLTextAreaElement>("Comment").readOnly).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: /^Cancel$/ }).disabled).toBe(true);
  fireEvent.keyDown(screen.getByLabelText("Comment"), { key: "Escape" });
  expect(cancel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Back to selection" }));
  expect(reveal).toHaveBeenCalledTimes(1);
});
it("aligned card uses the single comment owner and preserves textarea identity", () => {
  const comment = { id: "saved", kind: "element" as const, quote: "Excerpt", feedback: "Original", createdAt: Date.now(), anchor: null };
  const state: CommentsContext = { open: false, ended: false, comparing: false, hasPage: true, error: null, composeOpen: false, comments: [comment], others: [], activeId: comment.id, orphans: new Set(), ui: createCommentUi() };
  const edit = vi.fn((id, surface) => { ownEdit(state.ui, comment, surface); runtime.publish(); });
  const runtime = createCommentsController({ read: () => state, close: vi.fn(), activate: vi.fn(), edit, save: vi.fn(), cancelEdit: vi.fn(), confirm: vi.fn(), cancelDelete: vi.fn(), remove: vi.fn(), navigate: vi.fn() });
  render(<StrictMode><AlignedComment runtime={runtime} measure={vi.fn()} /></StrictMode>);
  fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
  expect(edit).toHaveBeenCalledWith("saved", "aligned");
  const field = screen.getByLabelText<HTMLTextAreaElement>("Edit comment text");
  fireEvent.change(field, { target: { value: "Revised draft" } });
  act(() => { state.orphans = new Set(["saved"]); runtime.publish(); });
  expect(screen.getByLabelText("Edit comment text")).toBe(field);
  expect(state.ui.edit?.draft).toBe("Revised draft");
});
