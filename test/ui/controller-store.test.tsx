import { StrictMode, useSyncExternalStore } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createControllerStore } from "../../src/controller-store.js";

afterEach(cleanup);

it("keeps one external-store subscription through Strict Mode and preserves control identity", () => {
  const source = { count: 0, detail: { status: "ready" } };
  const store = createControllerStore(() => source);
  let active = 0;
  const subscribe = (listener: () => void) => {
    active++;
    const unsubscribe = store.subscribe(listener);
    return () => { active--; unsubscribe(); };
  };
  function Consumer() {
    const snapshot = useSyncExternalStore(subscribe, store.getSnapshot);
    return <div><output aria-label="Count">{snapshot.count}</output><input aria-label="Draft" defaultValue="Keep this draft" /></div>;
  }
  const { unmount } = render(<StrictMode><Consumer /></StrictMode>);
  expect(active).toBe(1);
  const original = store.getSnapshot();
  expect(store.getSnapshot()).toBe(original);
  const input = screen.getByLabelText<HTMLInputElement>("Draft");
  input.setSelectionRange(5, 9);
  act(() => { source.count++; store.publish(); });
  expect(screen.getByLabelText("Count").textContent).toBe("1");
  expect(screen.getByLabelText("Draft")).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([5, 9]);
  expect(store.getSnapshot().detail).toBe(original.detail);
  expect(original.count).toBe(0);
  expect(active).toBe(1);
  unmount();
  expect(active).toBe(0);
  store.dispose();
});
