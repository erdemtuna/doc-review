import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createToolbarController, type ToolbarState } from "../../src/toolbar-controller.js";
import { Toolbar, ToolbarControls } from "@/components/toolbar";

afterEach(cleanup);

function fixture() {
  const state: ToolbarState = {
    comparing: false, mode: "view", modeDisabled: false, modeMenuOpen: false,
    restoreModeFocus: true, editDescription: "Edits save directly to this file",
    drawerOpen: false, feedbackCount: 3, theme: "light", ended: false,
  };
  const commands = {
    setComparing: vi.fn((value: boolean) => { state.comparing = value; runtime.publish(); }),
    setMode: vi.fn((value: "view" | "edit") => { state.mode = value; runtime.publish(); }),
    setModeMenu: vi.fn((value: boolean) => { state.modeMenuOpen = value; runtime.publish(); }),
    openComments: vi.fn(() => { state.drawerOpen = true; runtime.publish(); }),
    toggleTheme: vi.fn(() => { state.theme = state.theme === "light" ? "dark" : "light"; runtime.publish(); }),
  };
  const runtime = createToolbarController(() => state, commands);
  return { state, runtime, commands };
}

it("owns accessible destinations with stable controls and one command per Strict Mode click", async () => {
  const { runtime, state, commands } = fixture();
  const user = userEvent.setup();
  render(<StrictMode><Toolbar runtime={runtime} /></StrictMode>);
  const brand = screen.getByRole("img", { name: "Doc Review" });
  expect(brand).toHaveAttribute("width", "32");
  expect(brand).toHaveAttribute("height", "32");
  expect(brand).not.toHaveAttribute("tabindex");
  expect(screen.getByRole("group", { name: "Review destination" })).not.toContainElement(brand);
  const review = screen.getByRole("button", { name: "Review" });
  const changes = screen.getByRole("button", { name: "Changes" });
  expect(review).toHaveAttribute("aria-controls", "frame");
  expect(review).toHaveAttribute("aria-pressed", "true");
  expect(changes).toHaveAttribute("aria-controls", "historyPanel");
  await user.click(changes);
  expect(commands.setComparing).toHaveBeenCalledExactlyOnceWith(true);
  expect(changes).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("button", { name: "Feedback" })).toBeNull();
  await user.click(review);
  const theme = screen.getByRole("button", { name: "Switch review tools to dark" });
  await user.click(theme);
  expect(screen.getByRole("button", { name: "Switch review tools to light" })).toBe(theme);
  act(() => { state.feedbackCount = 1000; runtime.publish(); });
  expect(screen.getByTitle("1000 feedback items")).toHaveTextContent("99+");
  expect(screen.getByRole("button", { name: "Feedback" })).toHaveAccessibleDescription("1000 feedback items");
  expect(screen.getByRole("button", { name: "Review" })).toBe(review);
  expect(screen.getByRole("button", { name: "Changes" })).toBe(changes);
  await user.click(screen.getByRole("button", { name: "Feedback" }));
  expect(commands.openComments).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Feedback" })).toHaveAttribute("aria-expanded", "true");
});

it("uses a nonmodal keyboard mode menu with selected policy and focus restoration", async () => {
  const { runtime, commands } = fixture();
  const user = userEvent.setup();
  render(<Toolbar runtime={runtime} />);
  const trigger = screen.getByRole("button", { name: "View" });
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(trigger).toHaveAttribute("aria-controls", "modeMenu");
  expect(screen.getByRole("menu")).toHaveAttribute("aria-labelledby", "modeButton");
  expect(screen.getByRole("menuitemradio", { name: /^View/ })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByText("Edits save directly to this file")).toBeVisible();
  expect(document.body.style.pointerEvents).not.toBe("none");
  expect(screen.getByRole("button", { name: "Feedback" })).toBeVisible();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  await user.click(screen.getByRole("menuitemradio", { name: /^Edit/ }));
  expect(commands.setMode).toHaveBeenCalledExactlyOnceWith("edit");
  expect(screen.getByRole("button", { name: "Edit" })).toBe(trigger);
});

it("blocks unavailable and ended commands even before a stale snapshot is republished", () => {
  const { runtime, state, commands } = fixture();
  render(<Toolbar runtime={runtime} />);
  const snapshot = runtime.getSnapshot();
  expect(runtime.getSnapshot()).toBe(snapshot);
  state.modeDisabled = true;
  runtime.commands.setMode("edit");
  runtime.commands.setModeMenu(true);
  expect(commands.setMode).not.toHaveBeenCalled();
  expect(commands.setModeMenu).not.toHaveBeenCalled();
  act(() => { runtime.publish(); });
  expect(screen.getByRole("button", { name: "View" })).toBeDisabled();
  expect(snapshot.modeDisabled).toBe(false);
  state.ended = true;
  runtime.commands.setComparing(true);
  runtime.commands.openComments();
  runtime.commands.toggleTheme();
  expect(commands.setComparing).not.toHaveBeenCalled();
  expect(commands.openComments).not.toHaveBeenCalled();
  expect(commands.toggleTheme).not.toHaveBeenCalled();
});

it("extends the former controls with ended read-only navigation without mounting the legacy controller", async () => {
  const { state, commands } = fixture();
  state.ended = true;
  const user = userEvent.setup();
  render(<ToolbarControls state={state} commands={commands} readOnlyNavigation changesId="conversationChanges" />);
  expect(screen.getByRole("button", { name: "View" })).toBeDisabled();
  const changes = screen.getByRole("button", { name: "Changes" });
  expect(changes).toHaveAttribute("aria-controls", "conversationChanges");
  await user.click(changes); await user.click(screen.getByRole("button", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Feedback" }));
  await user.click(screen.getByRole("button", { name: "Switch review tools to dark" }));
  expect(commands.setComparing.mock.calls).toEqual([[true], [false]]);
  expect(commands.openComments).toHaveBeenCalledTimes(1);
  expect(commands.toggleTheme).toHaveBeenCalledTimes(1);
});

it("write exclusion disables only Edit in the open menu and accurately labels attention evidence", () => {
  const { state, commands } = fixture();
  state.modeMenuOpen = true;
  render(<ToolbarControls state={state} commands={commands} editDisabled readOnlyNavigation feedbackCountLabel="conversations with new activity" />);
  expect(screen.getByRole("menuitemradio", { name: /^Edit/ })).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("menuitemradio", { name: /^View/ })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Feedback" })).toHaveAccessibleDescription("3 conversations with new activity");
});
