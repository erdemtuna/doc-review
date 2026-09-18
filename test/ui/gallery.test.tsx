import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Gallery, initialTheme } from "@/preview/gallery";
import { Icon } from "@/components/icon";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = "light";
});
afterEach(cleanup);

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
    const note = screen.getByLabelText<HTMLTextAreaElement>("Overall note");
    await user.clear(note);
    await user.type(note, "Keep this sample draft");
    note.setSelectionRange(5, 9);
    await user.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("doc-review:theme")).toBe("dark");
    expect(screen.getByLabelText("Overall note")).toBe(note);
    expect(note.value).toBe("Keep this sample draft");
    expect([note.selectionStart, note.selectionEnd]).toEqual([5, 9]);
  });

  it("offers a native selector and stable selected format", async () => {
    const user = userEvent.setup();
    render(<Gallery />);
    await user.selectOptions(screen.getByLabelText("Review round"), "1");
    expect(screen.getByRole("status").textContent).toContain("Sample round 1 selected");
    await user.click(screen.getByRole("radio", { name: "Source" }));
    expect(screen.getByRole("radio", { name: "Source" }).getAttribute("aria-checked")).toBe("true");
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
    const note = screen.getByLabelText<HTMLTextAreaElement>("Overall note");
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
