import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConversationNotification } from "@/components/conversation-notification";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fixture() {
  const props = { notification: { id: "transition-1", message: "Waiting for agent." }, onDismiss: vi.fn() };
  const view = render(<><input aria-label="Unrelated editor" /><ConversationNotification {...props} /></>);
  const update = () => view.rerender(<><input aria-label="Unrelated editor" /><ConversationNotification {...props} /></>);
  return { props, update, toast: () => document.querySelector(".conversation-toast")! };
}

it("announces without stealing focus and expires after exactly five seconds", () => {
  const { props, toast } = fixture();
  const editor = screen.getByRole("textbox");
  editor.focus();
  expect(toast()).toHaveTextContent("Waiting for agent.");
  expect(toast().closest(".conversation-panel")).toBeNull();
  expect(editor).toHaveFocus();
  act(() => vi.advanceTimersByTime(4999));
  expect(props.onDismiss).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(props.onDismiss).toHaveBeenCalledExactlyOnceWith("transition-1");
  expect(editor).toHaveFocus();
});

it("pauses expiration while hovered and resumes only the remaining time", () => {
  const { props, toast } = fixture();
  act(() => vi.advanceTimersByTime(2000));
  fireEvent.pointerMove(toast(), { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(12000));
  expect(props.onDismiss).not.toHaveBeenCalled();
  fireEvent.pointerLeave(toast(), { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(2999));
  expect(props.onDismiss).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(props.onDismiss).toHaveBeenCalledExactlyOnceWith("transition-1");
});

it("pauses during keyboard interaction and resumes the remaining lifetime", () => {
  const { props } = fixture();
  act(() => vi.advanceTimersByTime(2000));
  act(() => screen.getByRole("button", { name: "Dismiss notification" }).focus());
  act(() => vi.advanceTimersByTime(12000));
  expect(props.onDismiss).not.toHaveBeenCalled();
  act(() => screen.getByRole("textbox").focus());
  act(() => vi.advanceTimersByTime(2999));
  expect(props.onDismiss).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(props.onDismiss).toHaveBeenCalledExactlyOnceWith("transition-1");
});

it("gives each lifecycle transition its own timeout and dismisses by exact identity", () => {
  const { props, update } = fixture();
  act(() => vi.advanceTimersByTime(4000));
  props.notification = { ...props.notification, id: "transition-2" }; update();
  act(() => vi.advanceTimersByTime(1000));
  expect(props.onDismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  expect(props.onDismiss).toHaveBeenCalledExactlyOnceWith("transition-2");
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
  expect(props.onDismiss).toHaveBeenCalledExactlyOnceWith("transition-1");
});

it("still expires when document iframe focus blurs the shell window", () => {
  const { props } = fixture();
  fireEvent(window, new Event("blur"));
  act(() => vi.advanceTimersByTime(4999));
  expect(props.onDismiss).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(props.onDismiss).toHaveBeenCalledExactlyOnceWith("transition-1");
});

it("pauses for a hidden page, rather than consuming the notice unseen", () => {
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const { props } = fixture();
  act(() => vi.advanceTimersByTime(2000));
  hidden.mockReturnValue(true);
  fireEvent(document, new Event("visibilitychange"));
  act(() => vi.advanceTimersByTime(12000));
  expect(props.onDismiss).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  fireEvent(document, new Event("visibilitychange"));
  act(() => vi.advanceTimersByTime(2999));
  expect(props.onDismiss).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(props.onDismiss).toHaveBeenCalledExactlyOnceWith("transition-1");
});
