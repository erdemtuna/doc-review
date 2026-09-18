import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ownConfirmation, ownEdit, clearOwned } from "../../src/chrome-session.js";
import { createCommentsController, type CommentsContext } from "../../src/comments-controller.js";
import { CommentsInventory } from "@/components/comments";
import type { FeedbackComment } from "../../src/contracts/feedback.js";

afterEach(cleanup);

function fixture() {
  const comments: FeedbackComment[] = [
    {
      id: "c1",
      kind: "selection",
      quote: "quoted text 1",
      feedback: "feedback 1",
      createdAt: 1000,
      updatedAt: 1000,
    },
    {
      id: "c2",
      kind: "selection",
      quote: "quoted text 2",
      feedback: "feedback 2",
      createdAt: 900,
      updatedAt: 900,
    },
  ];

  const context: CommentsContext = {
    open: true,
    ended: false,
    comparing: false,
    hasPage: true,
    error: null,
    composeOpen: false,
    comments,
    others: [],
    activeId: null,
    orphans: new Set(),
    ui: {
      edit: null,
      confirmation: null,
    },
  };

  const remove = vi.fn();
  const runtime = createCommentsController({
    read: () => context,
    close: vi.fn(),
    activate: vi.fn(),
    edit: vi.fn(),
    save: vi.fn(),
    cancelEdit: vi.fn(),
    confirm: (id, surface) => { ownConfirmation(context.ui, id, surface); runtime.publish(); },
    cancelDelete: () => { clearOwned(context.ui, "confirmation"); runtime.publish(); },
    remove,
    navigate: vi.fn(),
  });

  runtime.publish();
  return { context, runtime, remove };
}

it("renders inventory with comment count", () => {
  const { runtime } = fixture();
  render(<CommentsInventory runtime={runtime} />);

  expect(screen.getByRole("heading", { name: "Comments" })).toBeInTheDocument();
  expect(screen.getByText("2")).toBeInTheDocument();
});

it("displays comment cards with feedback", () => {
  const { runtime } = fixture();
  render(<CommentsInventory runtime={runtime} />);

  expect(screen.getByText("feedback 1")).toBeInTheDocument();
  expect(screen.getByText("feedback 2")).toBeInTheDocument();
});

it("displays comment quotes", () => {
  const { runtime } = fixture();
  render(<CommentsInventory runtime={runtime} />);

  expect(screen.getByText(/quoted text 1/)).toBeInTheDocument();
  expect(screen.getByText(/quoted text 2/)).toBeInTheDocument();
});

it("renders action buttons for comments", () => {
  const { runtime } = fixture();
  render(<CommentsInventory runtime={runtime} />);

  const jumpButtons = screen.getAllByRole("button", { name: "Jump to" });
  expect(jumpButtons.length).toBe(2);

  const editButtons = screen.getAllByLabelText("Edit comment");
  expect(editButtons.length).toBe(2);
});

it("renders directly accessible icon actions without a More menu", () => {
  const { runtime } = fixture();
  render(<CommentsInventory runtime={runtime} />);

  for (const name of ["Jump to", "Edit comment", "Delete comment"]) {
    const buttons = screen.getAllByRole("button", { name });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toHaveAttribute("title", name);
      expect(button.textContent).toBe("");
      expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
  }
  expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  expect(screen.queryByRole("menu")).toBeNull();
});

it("direct Delete still requires confirmation and Cancel sends no request", () => {
  const { runtime, remove } = fixture();
  render(<CommentsInventory runtime={runtime} />);
  fireEvent.click(screen.getAllByRole("button", { name: "Delete comment" })[0]!);
  expect(screen.getByText("Delete this comment?")).toBeVisible();
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "Delete comment" })[0]!);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(remove).toHaveBeenCalledExactlyOnceWith("c1");
});

it("disables other card actions during a confirmed deletion", () => {
  const { context, runtime } = fixture();
  render(<CommentsInventory runtime={runtime} />);
  act(() => {
    ownConfirmation(context.ui, "c1", "drawer");
    if (context.ui.confirmation) context.ui.confirmation.status = "deleting";
    runtime.publish();
  });
  expect(screen.getByRole("button", { name: "Delete comment" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Edit comment" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
});

it("renders with StrictMode", () => {
  const { runtime } = fixture();
  render(
    <StrictMode>
      <CommentsInventory runtime={runtime} />
    </StrictMode>
  );
  expect(screen.getByRole("heading", { name: "Comments" })).toBeInTheDocument();
});

it("keeps cards mounted while collapsed, with other pages and failures still visible", () => {
  const { context, runtime } = fixture();
  render(<CommentsInventory runtime={runtime} />);
  const card = screen.getByText("feedback 1");
  fireEvent.click(screen.getByRole("button", { name: "Comments" }));
  expect(card).not.toBeVisible();
  expect(card).toBeInTheDocument();
  act(() => {
    context.others = [{ key: "other", filename: "elsewhere.html", count: 3 }];
    context.hasPage = false;
    context.error = "Could not load feedback";
    runtime.publish();
  });
  expect(screen.getByRole("button", { name: /elsewhere.html/ })).toBeVisible();
  expect(screen.getByRole("alert")).toBeVisible();
  expect(screen.getByRole("button", { name: "Comments" })).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(screen.getByRole("button", { name: "Comments" }));
  expect(screen.getByText("feedback 1")).toBe(card);
});

it("reveals an owned comment editor and guards collapse without recreating the input", () => {
  const { context, runtime } = fixture();
  render(<CommentsInventory runtime={runtime} />);
  const trigger = screen.getByRole("button", { name: "Comments" });
  fireEvent.click(trigger);
  act(() => {
    ownEdit(context.ui, context.comments[0]!, "drawer");
    runtime.publish();
  });
  const input = screen.getByRole("textbox", { name: "Edit comment text" });
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(trigger).toHaveAttribute("aria-disabled", "true");
  fireEvent.change(input, { target: { value: "Keep the draft", selectionStart: 3, selectionEnd: 6 } });
  fireEvent.click(trigger);
  expect(input).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Edit comment text" })).toBe(input);
  expect(input).toHaveValue("Keep the draft");
  act(() => { clearOwned(context.ui, "edit"); runtime.publish(); });
  expect(trigger).toHaveAttribute("aria-disabled", "false");
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});
