import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConversationNotification } from "@/components/conversation-notification";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture() {
  const props = { notification: { id: "accepted-1", message: "Conversation resolved.", undoThreadId: "thread" },
    onDismiss: vi.fn(), onUndo: vi.fn(), busy: false };
  const view = render(<><input aria-label="Unrelated editor" /><ConversationNotification {...props} /></>);
  const update = () => view.rerender(<><input aria-label="Unrelated editor" /><ConversationNotification {...props} /></>);
  return { props, update, toast: () => document.querySelector(".conversation-toast")! };
}

it("announces without stealing focus and expires after exactly five seconds", () => {
  const { props, toast } = fixture();
  const editor = screen.getByRole("textbox");
  editor.focus();
  expect(toast()).toHaveTextContent("Conversation resolved.");
  expect(toast().closest(".conversation-panel")).toBeNull();
  expect(editor).toHaveFocus();
  act(() => vi.advanceTimersByTime(4999));
  expect(props.onDismiss).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(props.onDismiss).toHaveBeenCalledExactlyOnceWith("accepted-1");
  expect(editor).toHaveFocus();
});

it("pauses expiration while hovered and resumes only the remaining time", () => {
  const { props, toast } = fixture();
  act(() => vi.advanceTimersByTime(2000));
  fireEvent.pointerMove(toast(), { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(12000));
  expect(props.onDismiss).not.toHaveBeenCalled();
  fireEvent.pointerLeave(document.querySelector(".conversation-toast-viewport")!.parentElement!, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(2999));
  expect(props.onDismiss).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(props.onDismiss).toHaveBeenCalledExactlyOnceWith("accepted-1");
});

it("pauses during keyboard interaction and Undo waits for authoritative acceptance", () => {
  const { props, update } = fixture();
  act(() => screen.getByRole("button", { name: "Undo resolve" }).focus());
  act(() => vi.advanceTimersByTime(12000));
  expect(props.onDismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Undo resolve" }));
  expect(props.onUndo).toHaveBeenCalledTimes(1);
  expect(props.onDismiss).not.toHaveBeenCalled();
  props.busy = true; update();
  act(() => vi.advanceTimersByTime(12000));
  expect(props.onDismiss).not.toHaveBeenCalled();
  props.busy = false; update();
  expect(screen.getByRole("button", { name: "Undo resolve" })).toBeEnabled();
  expect(props.onDismiss).not.toHaveBeenCalled();
});

it("gives repeated accepted events their own timeout and dismisses by exact identity", () => {
  const { props, update } = fixture();
  act(() => vi.advanceTimersByTime(4000));
  props.notification = { ...props.notification, id: "accepted-2" }; update();
  act(() => vi.advanceTimersByTime(1000));
  expect(props.onDismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  expect(props.onDismiss).toHaveBeenCalledExactlyOnceWith("accepted-2");
});

it("does not prevent an editor's Escape and supports keyboard notification dismissal", () => {
  const { props, toast } = fixture();
  const editor = screen.getByRole("textbox");
  editor.focus();
  expect(fireEvent.keyDown(editor, { key: "Escape" })).toBe(true);
  expect(editor).toHaveFocus();
  props.onDismiss.mockClear();
  act(() => (toast() as HTMLElement).focus());
  fireEvent.keyDown(toast(), { key: "Escape" });
  expect(props.onDismiss).toHaveBeenCalledExactlyOnceWith("accepted-1");
});
