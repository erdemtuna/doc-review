import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createConversationController } from "../../src/conversation-controller";
import { createControllerStore } from "../../src/controller-store";
import type { ConversationShell } from "../../src/conversation-shell";
import type { ReviewStatus } from "../../src/contracts/page";
import { ConversationApp } from "@/components/conversation";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function fixture() {
  if (typeof ResizeObserver === "undefined") vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const review: ReviewStatus["review"] = { reviewId: "review", entryKey: "page", version: 1, state: "open", createdAt: 1, endedAt: null };
  const status: ReviewStatus = { review, pendingMessageCount: 0, pendingEditCount: 0, work: null, blockers: [] };
  const thread = { threadId: "thread", reviewId: "review", pageKey: "page", version: 1, sequence: 1,
    target: { kind: "element", anchor: { selector: "p", label: "Paragraph" } }, status: "open", createdAt: 1, updatedAt: 1 };
  const message = { messageId: "message", reviewId: "review", threadId: "thread", version: 1, sequence: 2, createdAt: 1,
    updatedAt: 1, body: "Saved discussion", author: "reviewer", intent: "discuss", submissionId: "submission" };
  const owner = createConversationController({
    reviewId: "review", entryKey: "page", barrier: async () => {}, baseline: async () => {}, navigate: async () => {}, jump() {}, revert: async () => {},
    request: async (_path, options) => {
      const input = JSON.parse(String(options?.body));
      if (input.operation === "status") return status;
      if (input.operation !== "list") throw new Error("Unexpected mutation");
      const items = input.scope.collection === "threads" ? [{
        thread, sequence: 1, messageCount: 1, pendingMessageCount: 0, latestExchange: { sequence: 2, reviewer: message, response: null },
      }] : [];
      return { items, nextCursor: null, totalCount: items.length, highWater: 2 };
    },
  });
  await owner.refresh(); owner.commands.open();
  let chromeState: ReturnType<ConversationShell["getSnapshot"]> = {
    pageKey: "page", pageName: "Fixture", pollCommand: "doc-review poll --review review --entry page", mode: "view" as const, theme: "light" as const, loading: false,
    sourceError: "", captureError: "", captureFailures: [], connectionError: "", reloadPending: false, blocked: false, canRevert: false, policy: "writable" as const, comparison: null, comparisonOpen: false,
    themeSync: { desired: { theme: "light" as const, themeRevision: 1 }, status: "applied" as const, appliedRevision: 1, message: null },
    executionPreference: "auto" as const, supportsRecovery: true,
    contentTop: 80, adjacent: null, anchorNotice: "", anchorThread: null, composer: null, composerNotice: "", canComposeBeside: false, composerRelation: "unavailable",
    viewport: { left: 0, top: 0, width: 1280, height: 800 },
    anchorViews: { thread: { canJump: true, offscreen: false, reason: "" } }, anchorPeers: { thread: ["thread"] },
    save: { status: "idle" as const, savedAt: "", baseHash: "hash", conflict: false, dirty: false, dynamic: false },
  };
  const chrome = createControllerStore(() => chromeState);
  const updateChrome = (patch: Partial<typeof chromeState>) => { chromeState = { ...chromeState, ...patch }; chrome.publish(); };
  const shell: ConversationShell = {
    owner, getSnapshot: chrome.getSnapshot, subscribe: chrome.subscribe, dispose() { owner.dispose(); chrome.dispose(); },
    commands: { measureComposer() {}, composeBeside: owner.commands.compose, revealSelection() {}, adjacent: owner.commands.adjacent, mode: async () => {}, theme() {}, retryTheme: async () => {}, execution: async () => {}, reconnect: async () => {}, reload: async () => {}, showChanges: async () => {}, comparison: async () => {}, recapture: async () => {}, closeComparison() {} },
  };
  render(<StrictMode><ConversationApp shell={shell} /></StrictMode>);
  return { owner, shell, status, updateChrome };
}
it("short reply composition groups the same independent overall note without losing permission, selection or IME", async () => {
  const { owner, shell, updateChrome } = await fixture();
  const toggle = screen.getByRole("button", { name: /Overall note \(optional\)/ });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  const note = screen.getByRole("textbox", { name: "Overall note" });
  fireEvent.change(note, { target: { value: "Retained overall note", selectionStart: 2, selectionEnd: 8 } });
  act(() => { owner.commands.update("note", { intent: "request-change" }); owner.commands.reply("thread"); });
  const reply = screen.getByRole("textbox", { name: "Reply" });
  fireEvent.change(reply, { target: { value: "My reply", selectionStart: 1, selectionEnd: 4 } });
  fireEvent.compositionStart(reply);
  act(() => updateChrome({ viewport: { left: 0, top: 0, width: 320, height: 400 } }));
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(document.getElementById("draft-note")).toBe(note);
  expect(screen.getByRole("textbox", { name: "Reply" })).toBe(reply);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fireEvent.click(toggle);
  expect(screen.getByRole("textbox", { name: "Overall note" })).toBe(note);
  expect(note).toHaveValue("Retained overall note");
  expect(owner.getSnapshot().note.intent).toBe("request-change");
  expect(owner.getSnapshot().threads[0].draft?.intent).toBe("discuss");
  act(() => updateChrome({ viewport: { left: 0, top: 0, width: 1440, height: 900 } }));
  expect(screen.getByRole("textbox", { name: "Overall note" })).toBe(note);
  expect(screen.getByRole("textbox", { name: "Reply" })).toBe(reply);
  expect(owner.getSnapshot().threads[0].draft?.composing).toBe(true);
  expect(owner.getSnapshot().threads[0].draft?.selectionStart).toBe(1);
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  fireEvent.focus(note);
  act(() => updateChrome({ viewport: { left: 0, top: 0, width: 320, height: 400 } }));
  expect(screen.getByRole("textbox", { name: "Overall note" })).toBe(note);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  shell.dispose();
});
it("new composition uses one editor and unchecked permission across contextual/Feedback hosts without opening the overlay", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const { owner, shell, updateChrome } = await fixture();
  act(() => {
    updateChrome({ composer: { kind: "attached", left: 500, top: 120, width: 340, height: 310 },
      canComposeBeside: true, composerRelation: "visible" });
    owner.commands.begin("page", { kind: "element", anchor: { selector: "p", label: "Paragraph" } }, true);
  });
  const editor = screen.getByRole("textbox", { name: "New message" });
  expect(screen.getByRole("complementary", { name: "Add comment" })).toBeVisible();
  expect(document.querySelector(".conversation-backdrop")).not.toBeVisible();
  expect(document.querySelector("#commentsButton")).toHaveAttribute("aria-expanded", "false");
  const permission = screen.getByRole("checkbox", { name: "Request a change" });
  expect(permission).toHaveAttribute("data-slot", "checkbox"); expect(permission).not.toBeChecked();
  fireEvent.change(editor, { target: { value: "Exact draft", selectionStart: 1, selectionEnd: 4 } });
  fireEvent.compositionStart(editor);
  fireEvent.click(screen.getByRole("button", { name: "Feedback" }));
  expect(screen.getByRole("textbox", { name: "New message" })).toBe(editor);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(screen.getByRole("complementary", { name: "Feedback" })).toBeVisible();
  act(() => owner.commands.compose());
  expect(screen.getByRole("textbox", { name: "New message" })).toBe(editor);
  expect(owner.getSnapshot().newMessage?.draft.selectionStart).toBe(1);
  fireEvent.compositionEnd(editor);
  fireEvent.click(screen.getByRole("button", { name: "Close comment" }));
  expect(editor).toBeInTheDocument();
  expect(screen.getByRole("alertdialog")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole("textbox", { name: "New message" })).toBe(editor);
  fireEvent.keyDown(editor, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(editor).not.toBeInTheDocument();
  shell.dispose();
});
it("only new-composer host or inventory-size changes reveal clipped input without stealing focus or overriding a chosen scroll", async () => {
  let resized = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(node: Element) {
      if (node.classList.contains("conversation-inventory")) resized = () => this.callback([], this as unknown as ResizeObserver);
    }
    disconnect() {}
  });
  const { owner, shell, updateChrome } = await fixture();
  const inventory = document.querySelector<HTMLElement>(".conversation-inventory")!;
  let height = 0;
  Object.defineProperty(inventory, "clientWidth", { configurable: true, get: () => 380 });
  Object.defineProperty(inventory, "clientHeight", { configurable: true, get: () => height });
  vi.spyOn(inventory, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 100, 380, height));
  act(() => owner.commands.begin("page", { kind: "element", anchor: { selector: "p" } }));
  const editor = screen.getByRole("textbox", { name: "New message" });
  vi.spyOn(editor, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 300 - inventory.scrollTop, 340, 40));
  const theme = document.getElementById("theme")!;
  theme.focus();
  height = 100; act(resized);
  expect(inventory.scrollTop).toBe(200);
  expect(theme).toHaveFocus();
  inventory.scrollTop = 0; fireEvent.scroll(inventory);
  act(() => {
    updateChrome({ theme: "dark" });
    owner.commands.update("new", { text: "Retain reading position", composing: true });
    resized();
  });
  expect(inventory.scrollTop).toBe(0);
  expect(theme).toHaveFocus();
  height = 80; act(resized);
  expect(inventory.scrollTop).toBe(200);
  expect(screen.getByRole("textbox", { name: "New message" })).toBe(editor);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(theme).toHaveFocus();
  shell.dispose();
});
it("one mounted editor retains caret and composition across Focus, collapse and filter changes", async () => {
  const { owner, shell } = await fixture();
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  const editor = screen.getByRole("textbox", { name: "Reply" });
  fireEvent.change(editor, { target: { value: "Keep this exact draft", selectionStart: 3, selectionEnd: 8 } });
  fireEvent.compositionStart(editor);
  fireEvent.click(screen.getByRole("button", { name: "Focus" }));
  expect(screen.getByRole("textbox", { name: "Reply" })).toBe(editor);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Back to Feedback" }));
  fireEvent.click(screen.getByRole("button", { name: /Paragraph/, expanded: true }));
  expect(editor).toBeInTheDocument(); expect(editor).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Paragraph/, expanded: false }));
  fireEvent.compositionEnd(editor);
  expect(editor).toHaveValue("Keep this exact draft");
  expect(owner.getSnapshot().threads[0].draft?.selectionStart).toBe(3);
  shell.dispose();
});
it("adjacent conversations omit the redundant target control and retain named menu collapse", async () => {
  const { owner, shell, updateChrome } = await fixture();
  act(() => {
    updateChrome({ adjacent: { left: 800, top: 80, width: 380, height: 600 } });
    owner.commands.adjacent("thread");
  });
  expect(document.querySelector(".conversation-thread-title")).toBeNull();
  const menu = screen.getByRole("button", { name: "Conversation actions" });
  fireEvent.pointerDown(menu, { button: 0, ctrlKey: false, pointerType: "mouse" });
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "Collapse conversation" })).toBeVisible());
  fireEvent.click(screen.getByRole("menuitem", { name: "Collapse conversation" }));
  expect(document.querySelector(".conversation-thread-content")).not.toBeVisible();
  expect(owner.getSnapshot().threads[0].expanded).toBe(false);
  shell.dispose();
});
it("cards extend the former inventory surface and keep both filters visibly selected by default", async () => {
  const { shell } = await fixture();
  const card = screen.getByRole("article");
  expect(card).toHaveClass("inventory-card");
  expect(screen.getByRole("button", { name: /Paragraph/, expanded: true })).toBeVisible();
  const open = screen.getByRole("button", { name: "Open (1)" });
  const resolved = screen.getByRole("button", { name: "Resolved (0)" });
  for (const filter of [open, resolved]) {
    expect(filter).toHaveAttribute("aria-pressed", "true");
    expect(filter).toHaveAttribute("data-variant", "secondary");
  }
  fireEvent.click(open);
  expect(card).not.toBeVisible();
  expect(open).toHaveAttribute("data-variant", "ghost");
  expect(resolved).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(open);
  expect(card).toBeVisible();
  expect(screen.getByText("Saved discussion")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  expect(screen.getByRole("button", { name: "Conversation actions" })).toHaveAttribute("aria-haspopup", "menu");
  expect(card.querySelector("time")).toHaveAttribute("dateTime", new Date(1).toISOString());
  expect(card.querySelector("time")).toHaveAccessibleName(new Date(1).toLocaleString());
  shell.dispose();
});
it("discussion messages omit default pills, replies default to no change permission, and saved messages have no permission checkbox", async () => {
  const { owner, shell } = await fixture();
  expect(screen.queryByText("Discussion", { exact: true })).toBeNull();
  expect(owner.getSnapshot().threads[0].exchanges[0].reviewer.intent).toBe("discuss");
  expect(screen.getAllByLabelText("Request a change")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  const boxes = screen.getAllByLabelText("Request a change");
  expect(boxes).toHaveLength(2); expect(boxes[0]).not.toBeChecked();
  fireEvent.click(boxes[0]);
  expect(owner.getSnapshot().threads[0].draft?.intent).toBe("request-change");
  fireEvent.click(screen.getByRole("button", { name: "Close reply" }));
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  expect(owner.getSnapshot().threads[0].draft?.intent).toBe("discuss");
  shell.dispose();
});

it("Feedback counts saved pending items separately from attention and note-only selection with a styled independent permission", async () => {
  const { owner, shell } = await fixture();
  fireEvent.click(screen.getByRole("button", { name: /Overall note \(optional\)/ }));
  expect(document.querySelector("#toolbarCount")).toHaveTextContent("0");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  const note = screen.getByRole("textbox", { name: "Overall note" });
  fireEvent.change(note, { target: { value: "Only the note" } });
  const send = screen.getByRole("button", { name: "Send" });
  expect(send).toHaveTextContent("Send (1)");
  expect(send).toHaveAccessibleDescription("0 saved messages · 0 pending edits · 1 overall note selected");
  expect(send).toBeEnabled();
  expect(document.querySelector("#toolbarCount")).toHaveTextContent("0");
  const permission = screen.getByRole("checkbox", { name: "Request a change" });
  expect(permission).toHaveAttribute("data-slot", "checkbox"); expect(permission).not.toBeChecked();
  fireEvent.click(permission);
  expect(owner.getSnapshot().note.intent).toBe("request-change");
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  expect(owner.getSnapshot().threads[0].draft?.intent).toBe("discuss");
  act(() => owner.commands.connected(false));
  expect(document.querySelector("#toolbarCount")).toHaveTextContent("…");
  expect(send).toBeDisabled();
  expect(send).toHaveAccessibleDescription(/unavailable/i);
  shell.dispose();
});

it("only the Feedback overlay makes the authored stage inert, never the adjacent host or toolbar", async () => {
  const stage = document.createElement("div"); stage.className = "stage"; document.body.append(stage);
  try {
    const { owner, shell } = await fixture();
    expect(stage.inert).toBe(true);
    expect(document.querySelector(".conversation-backdrop")).toBeVisible();
    expect(screen.getByRole("button", { name: "Switch review tools to dark" })).toBeEnabled();
    act(() => owner.commands.adjacent("thread"));
    expect(stage.inert).toBe(false);
    expect(document.querySelector(".conversation-backdrop")).not.toBeVisible();
    act(() => owner.commands.focus(null));
    expect(stage.inert).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(stage.inert).toBe(false);
    expect(screen.getByRole("button", { name: "Feedback" })).toHaveFocus();
    shell.dispose();
  } finally { stage.remove(); }
});

it("adjacent, Focus and Feedback keep the same composing editor and closing never resolves it", async () => {
  const { owner, shell } = await fixture();
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  const editor = screen.getByRole("textbox", { name: "Reply" });
  fireEvent.change(editor, { target: { value: "Unfinished composition", selectionStart: 2, selectionEnd: 7 } });
  fireEvent.compositionStart(editor);
  act(() => { owner.commands.filter("open"); owner.commands.adjacent("thread"); });
  expect(screen.getByRole("complementary", { name: "Feedback" })).toHaveAttribute("data-host", "adjacent");
  expect(screen.getByRole("textbox", { name: "Reply" })).toBe(editor);
  fireEvent.click(screen.getByRole("button", { name: "Focus" }));
  expect(screen.getByRole("textbox", { name: "Reply" })).toBe(editor);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Back to Feedback" }));
  expect(editor).toBeVisible();
  expect(owner.getSnapshot().filters.open).toBe(true);
  act(() => { owner.commands.filter("open"); owner.commands.adjacent("thread"); owner.commands.fallback(); });
  expect(editor).toBeVisible();
  act(() => owner.commands.adjacent("thread"));
  fireEvent.click(screen.getByRole("button", { name: "Close conversation" }));
  expect(editor).toBeInTheDocument();
  expect(owner.getSnapshot().threads[0].draft).toMatchObject({ text: "Unfinished composition", composing: true, selectionStart: 2, selectionEnd: 7 });
  expect(owner.getSnapshot().threads[0].thread.status).toBe("open");
  expect(owner.getSnapshot().confirmation).toBeNull();
  shell.dispose();
});
it("shared End confirmation identifies consequences and does not claim draft durability", async () => {
  const { shell } = await fixture();
  fireEvent.click(screen.getByRole("button", { name: "End review" }));
  expect(screen.getByRole("alertdialog")).toHaveTextContent("for every tab");
  expect(screen.getByRole("alertdialog")).toHaveTextContent("Accepted source work continues");
  expect(screen.getByRole("alertdialog")).toHaveTextContent("drafts are not durable");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  shell.dispose();
});

it.each(["new", "reply", "edit"] as const)("%s composer restores Enter, Shift+Enter and Escape without intercepting IME", async (mode) => {
  const { owner, shell } = await fixture();
  act(() => {
    if (mode === "new") owner.commands.begin("page", { kind: "element", anchor: { selector: "p" } });
    else if (mode === "reply") owner.commands.reply("thread");
    else owner.commands.edit({ ...owner.getSnapshot().threads[0].latestExchange!.reviewer, submissionId: null });
  });
  const editor = screen.getByRole("textbox", { name: mode === "new" ? "New message" : mode === "reply" ? "Reply" : "Edit message" });
  fireEvent.change(editor, { target: { value: "Exact draft" } });
  const save = vi.spyOn(owner.commands, "saveDraft").mockResolvedValue(undefined);
  fireEvent.compositionStart(editor);
  expect(fireEvent.keyDown(editor, { key: "Enter" })).toBe(true);
  expect(fireEvent.keyDown(editor, { key: "Escape" })).toBe(true);
  expect(editor).toBeInTheDocument();
  fireEvent.compositionEnd(editor);
  expect(fireEvent.keyDown(editor, { key: "Enter", isComposing: true })).toBe(true);
  expect(fireEvent.keyDown(editor, { key: "Escape", keyCode: 229 })).toBe(true);
  expect(fireEvent.keyDown(editor, { key: "Enter", shiftKey: true })).toBe(true);
  expect(save).not.toHaveBeenCalled();
  expect(fireEvent.keyDown(editor, { key: "Enter" })).toBe(false);
  expect(save).toHaveBeenCalledExactlyOnceWith(mode === "new" ? "new" : "thread");
  expect(fireEvent.keyDown(editor, { key: "Escape" })).toBe(false);
  expect(editor).toBeInTheDocument();
  expect(screen.getByRole("alertdialog")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(editor).not.toBeInTheDocument();
  shell.dispose();
});

it("overall note keys remain multiline and never save, send or cancel the note", async () => {
  const { owner, shell } = await fixture();
  fireEvent.click(screen.getByRole("button", { name: /Overall note \(optional\)/ }));
  const save = vi.spyOn(owner.commands, "saveDraft"), send = vi.spyOn(owner.commands, "send");
  const note = screen.getByRole("textbox", { name: "Overall note" });
  fireEvent.change(note, { target: { value: "Submission only\nSecond line" } });
  for (const event of [{ key: "Enter" }, { key: "Enter", shiftKey: true }, { key: "Escape" }]) {
    expect(fireEvent.keyDown(note, event)).toBe(true);
  }
  expect(note).toHaveValue("Submission only\nSecond line");
  expect(save).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  shell.dispose();
});

it.each(["new", "reply", "edit"] as const)("%s has one Save row, protective X, and Keep editing restores the caret", async (mode) => {
  const { owner, shell } = await fixture();
  act(() => {
    if (mode === "new") owner.commands.begin("page", { kind: "element", anchor: { selector: "h2", label: "Heading" } });
    else if (mode === "reply") owner.commands.reply("thread");
    else owner.commands.edit({ ...owner.getSnapshot().threads[0].latestExchange!.reviewer, submissionId: null });
  });
  const id = mode === "new" ? "new" : "thread";
  const editor = document.getElementById(`draft-${id}`) as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: "Keep this text", selectionStart: 2, selectionEnd: 8 } });
  const save = screen.getByRole("button", { name: "Save" });
  expect(save).toHaveAccessibleDescription(/Save does not send/);
  expect(save.parentElement).toHaveClass("conversation-composer-actions");
  expect(save.parentElement?.querySelector('[data-slot="checkbox"]')).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: mode === "new" ? "Close comment" : `Close ${mode}` }));
  expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  await waitFor(() => expect(editor).toHaveFocus());
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 8]);
  fireEvent.compositionStart(editor);
  expect(screen.getByRole("button", { name: mode === "new" ? "Close comment" : `Close ${mode}` })).toBeDisabled();
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  fireEvent.compositionEnd(editor);
  shell.dispose();
});

it("Feedback and Focus share only one global lifecycle headline", async () => {
  const { shell } = await fixture();
  expect(screen.getAllByText("Reviewing", { exact: true })).toHaveLength(1);
  expect(screen.getByLabelText("Submission details")).not.toHaveTextContent("Reviewing");
  fireEvent.click(screen.getByRole("button", { name: "Focus" }));
  expect(screen.getAllByText("Reviewing", { exact: true })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Back to Feedback" }));
  expect(screen.getAllByText("Reviewing", { exact: true })).toHaveLength(1);
  shell.dispose();
});

it("uses descriptive focusable status Badges in a separate center slot, including Changes and ended outstanding work", async () => {
  const { owner, shell, status, updateChrome } = await fixture();
  const assertBadge = (name: string, variant: string, details?: string) => {
    const badge = screen.getByRole("status", { name });
    expect(badge).toHaveAttribute("data-slot", "badge");
    expect(badge).toHaveAttribute("data-variant", variant);
    expect(badge).toHaveAttribute("tabindex", "0");
    expect(badge.tagName).toBe("SPAN");
    expect(badge.parentElement).toHaveClass("shell-status");
    expect(badge).not.toHaveAttribute("title");
    if (details) expect(badge).toHaveAccessibleDescription(new RegExp(details));
    expect(screen.queryByRole("status", { name: "Review recovery" })).toBeNull();
    return badge;
  };
  expect(assertBadge("Reviewing", "outline")).toHaveClass("border-border", "text-foreground");
  expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  expect(screen.getByRole("status", { name: "Reviewing" })).toHaveAccessibleDescription(/Saved feedback is not sent until you choose Send/);
  status.work = { submissionId: "submission", state: "queued", version: 1 };
  await act(() => owner.refresh());
  assertBadge("Waiting for agent", "warning", "Queued; not received");
  status.work.state = "delivered";
  await act(() => owner.refresh());
  const receipt = "Received; delivery is not evidence of an active agent";
  assertBadge("Waiting for agent", "warning", receipt);
  act(() => updateChrome({ comparisonOpen: true }));
  expect(screen.queryByRole("button", { name: "View" })).toBeNull();
  expect(assertBadge("Waiting for agent", "warning", receipt)).toBeVisible();
  status.review.state = "ended"; status.review.endedAt = 2;
  await act(() => owner.refresh());
  expect(assertBadge("Review ended", "secondary", receipt)).toBeVisible();
  expect(screen.getByRole("status", { name: "Review ended" })).toHaveAccessibleDescription(/Accepted work can still finish/);
  act(() => updateChrome({ comparisonOpen: false }));
  expect(screen.getByRole("button", { name: "View" })).toBeDisabled();
  shell.dispose();
});

it("preserves source receipt details without a row and exposes all closed-Feedback errors with recovery", async () => {
  const { owner, shell, updateChrome } = await fixture();
  const refresh = vi.spyOn(owner.commands, "refresh").mockResolvedValue(undefined);
  act(() => updateChrome({ save: { ...shell.getSnapshot().save, status: "saved" } }));
  expect(screen.getByRole("status", { name: "Reviewing" })).toHaveAccessibleDescription(/Source saved/);
  expect(screen.queryByRole("status", { name: "Review recovery" })).toBeNull();
  act(() => {
    owner.commands.open(false);
    owner.report(new Error("Mutation failed"));
    updateChrome({ sourceError: "Source changed", connectionError: "Transport failed" });
  });
  const recovery = screen.getByRole("status", { name: "Review recovery" });
  expect(recovery).toHaveTextContent("Mutation failed");
  expect(recovery).toHaveTextContent("Source: Source changed");
  expect(recovery).toHaveTextContent("Transport failed");
  fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
  expect(refresh).toHaveBeenCalledOnce();
  const reload = vi.spyOn(shell.commands, "reload").mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole("button", { name: "Reload source (discard local page edits)" }));
  expect(reload).toHaveBeenCalledOnce();
  shell.dispose();
});

it("retains contextual source retry when a replacement fetch fails before a source error is published", async () => {
  const { owner, shell, updateChrome } = await fixture();
  act(() => {
    owner.commands.open(false);
    owner.report(new Error("Replacement fetch failed"));
    updateChrome({ loading: true, sourceError: "", reloadPending: false });
  });
  const reload = vi.spyOn(shell.commands, "reload").mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole("button", { name: "Reload source (discard local page edits)" }));
  expect(reload).toHaveBeenCalledOnce();
  act(() => updateChrome({ loading: false }));
  expect(screen.queryByRole("button", { name: "Reload source (discard local page edits)" })).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent("Replacement fetch failed");
  shell.dispose();
});
