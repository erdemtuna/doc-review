import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Gallery, initialTheme } from "@/preview/gallery";
import { Icon } from "@/components/icon";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  localStorage.clear();
  document.documentElement.dataset.theme = "light";
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("G1 component vocabulary", () => {
  it("keeps the existing theme preference contract", () => {
    expect(initialTheme()).toBe("light");
    localStorage.setItem("doc-review:theme", "system");
    expect(initialTheme()).toBe("light");
    localStorage.setItem("doc-review:theme", "dark");
    expect(initialTheme()).toBe("dark");
  });

  it("preserves the draft node, text and caret across theme changes", async () => {
    const user = userEvent.setup();
    render(<StrictMode><Gallery /></StrictMode>);
    const note = screen.getByLabelText<HTMLTextAreaElement>("Note to agent");
    await user.clear(note);
    await user.type(note, "Keep this sample draft");
    note.setSelectionRange(5, 9);
    await user.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("doc-review:theme")).toBe("dark");
    expect(screen.getByLabelText("Note to agent")).toBe(note);
    expect(note.value).toBe("Keep this sample draft");
    expect([note.selectionStart, note.selectionEnd]).toEqual([5, 9]);
  });

  it("offers the production single-choice menu and stable pressed format", async () => {
    const user = userEvent.setup();
    render(<Gallery />);
    await user.click(screen.getByRole("button", { name: /^Submission:/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Submission 1 - Handled" }));
    expect(screen.getByRole("status").textContent).toContain("Sample submission 1 selected");
    await user.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByRole("button", { name: "Source" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/Source is selected/)).toBeTruthy();
  });

  it("opens a keyboard menu and returns focus after selection", async () => {
    const user = userEvent.setup();
    render(<Gallery />);
    const trigger = screen.getByRole("button", { name: "Open sample menu" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByRole("status").textContent).toMatch(/selected|revealed/);
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps confirmation safe, non-destructive and focus-restoring", async () => {
    const user = userEvent.setup();
    render(<StrictMode><Gallery /></StrictMode>);
    const trigger = screen.getByRole("button", { name: "Try confirmation" });
    const note = screen.getByLabelText<HTMLTextAreaElement>("Note to agent");
    const before = note.value;
    await user.click(trigger);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep editing" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Discard sample edits" }));
    expect(screen.getByRole("status").textContent).toContain("Nothing was deleted");
    expect(note.value).toBe(before);
    expect(document.activeElement).toBe(trigger);
  });

  it("exposes disabled and invalid states with readable feedback", () => {
    render(<Gallery />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Nothing to send" }).disabled).toBe(true);
    expect(screen.getByLabelText("Error treatment").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("Error treatment").getAttribute("aria-describedby")).toBe("sample-error-help");
  });

  it("renders allowlisted icon geometry without injecting markup", () => {
    const { container } = render(<Icon name="eye" label="Preview" />);
    expect(screen.getByRole("img", { name: "Preview" })).toBeTruthy();
    expect(container.querySelectorAll("path, circle").length).toBe(2);
    expect(container.querySelector("script, image, use, foreignObject, [href]")).toBeNull();
  });
});
