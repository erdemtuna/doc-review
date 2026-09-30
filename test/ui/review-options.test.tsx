import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CanonicalPage } from "../../src/contracts/page-boundary";
import { ReviewOptions } from "@/components/review-options";
import { ConversationStatus } from "@/components/conversation-controls";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Options({ target, loading = false, change = vi.fn() }: {
  target: CanonicalPage["target"]; loading?: boolean; change?(theme: "light" | "dark"): void;
}) {
  const [open, setOpen] = useState(false);
  return <ReviewOptions open={open} onOpenChange={setOpen} target={target} loading={loading}
    theme="light" onThemeChange={change} />;
}

it.each(["C:\\Documents\\A long file name.html", "\\\\server\\share\\original.md", "/home/reviewer/\u015fema.html"])("copies the original file location exactly: %s", async path => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<Options target={{ kind: "file", path }} />);
  const trigger = screen.getByRole("button", { name: "Review options" });
  await user.click(trigger);
  expect(screen.getByLabelText(path)).toBeVisible();
  await user.click(screen.getByRole("menuitem", { name: "Copy full path" }));
  expect(write).toHaveBeenCalledExactlyOnceWith(path);
  expect(await screen.findByRole("status")).toHaveTextContent("Original file path copied.");
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
});

it("keeps clipboard failures visible and retryable without inventing success", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Permission denied")).mockResolvedValue();
  render(<Options target={{ kind: "file", path: "C:\\original.html" }} />);
  await user.click(screen.getByRole("button", { name: "Review options" }));
  await user.click(screen.getByRole("menuitem", { name: "Copy full path" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
  expect(screen.getByRole("alert")).toHaveTextContent("C:\\original.html");
  expect(screen.queryByText("Original file path copied.")).toBeNull();
  await user.click(screen.getByRole("menuitem", { name: "Copy full path" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Original file path copied.");
  expect(write).toHaveBeenCalledTimes(2);
});

it("does not expose a substitute file path for URL reviews and leaves theme choices available", async () => {
  const user = userEvent.setup(), change = vi.fn();
  render(<Options target={{ kind: "url", url: "http://localhost:3000/page" }} change={change} />);
  await user.click(screen.getByRole("button", { name: "Review options" }));
  expect(screen.queryByRole("menuitem", { name: /Copy/ })).toBeNull();
  expect(screen.getByText(/no original local file path/)).toBeVisible();
  expect(screen.getByRole("menuitemradio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
  await user.click(screen.getByRole("menuitemradio", { name: "Dark" }));
  expect(change).toHaveBeenCalledExactlyOnceWith("dark");
});

it("discards a stale clipboard completion after the reviewed file changes", async () => {
  const user = userEvent.setup();
  let complete!: () => void;
  const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const view = render(<Options target={{ kind: "file", path: "C:\\first.html" }} />);
  await user.click(screen.getByRole("button", { name: "Review options" }));
  await user.click(screen.getByRole("menuitem", { name: "Copy full path" }));
  expect(screen.getByRole("menuitem", { name: "Copy full path" })).toHaveAttribute("aria-disabled", "true");
  view.rerender(<Options target={{ kind: "file", path: "C:\\second.html" }} />);
  complete();
  await waitFor(() => expect(screen.queryByText("Original file path copied.")).toBeNull());
  expect(screen.getByLabelText("C:\\second.html")).toBeVisible();
  expect(write).toHaveBeenCalledExactlyOnceWith("C:\\first.html");
});

it("never repeats an in-flight copy and keeps theme usable while a document loads", async () => {
  const user = userEvent.setup();
  let complete!: () => void;
  const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const view = render(<Options target={{ kind: "file", path: "C:\\first.html" }} />);
  await user.click(screen.getByRole("button", { name: "Review options" }));
  const command = screen.getByRole("menuitem", { name: "Copy full path" });
  fireEvent.click(command); fireEvent.click(command);
  expect(write).toHaveBeenCalledExactlyOnceWith("C:\\first.html");
  view.rerender(<Options target={{ kind: "file", path: "C:\\next.html" }} loading />);
  complete();
  expect(screen.getByRole("menuitem", { name: "Copy full path" })).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("menuitemradio", { name: "Dark" })).not.toHaveAttribute("aria-disabled", "true");
  await waitFor(() => expect(screen.queryByText("Original file path copied.")).toBeNull());
  expect(screen.getByLabelText("Loading document")).toBeVisible();
});

it("returns menu focus without opening an obstructing hint, but later keyboard entry still reveals it", async () => {
  const user = userEvent.setup();
  render(<><Options target={{ kind: "file", path: "C:\\original.html" }} /><button>Next control</button></>);
  const trigger = screen.getByRole("button", { name: "Review options" });
  await user.click(trigger);
  await user.click(screen.getByRole("menuitemradio", { name: "Dark" }));
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole("tooltip")).toBeNull();
  await user.tab();
  expect(screen.getByRole("button", { name: "Next control" })).toHaveFocus();
  await user.tab({ shift: true });
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Review options");
});

it.each([
  ["not-sent", "Not sent", "Not sent until you choose Send"],
  ["request-change", "Change requested", "not a reported edit"],
  ["resolved", "Resolved", "conversation is resolved"],
  ["answered", "Answered", "does not indicate source changes"],
  ["applied", "Change reported", "not independent verification"],
  ["clarification-needed", "Needs clarification", "needs your input"],
  ["deferred", "Deferred", "not currently being processed"],
] as const)("keeps %s informational with a keyboard-visible explanation", async (kind, label, explanation) => {
  const user = userEvent.setup();
  render(<ConversationStatus kind={kind} />);
  const icon = screen.getByRole("img", { name: label });
  expect(screen.queryByRole("button")).toBeNull();
  expect(icon).not.toHaveAttribute("title");
  await user.tab();
  expect(icon).toHaveFocus();
  expect(await screen.findByRole("tooltip")).toHaveTextContent(explanation);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("tooltip")).toBeNull();
});
