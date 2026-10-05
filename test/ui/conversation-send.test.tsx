import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationSend } from "@/components/conversation-send";
import type { SendAvailability } from "@/components/conversation-presentation";

const waiting: SendAvailability = { disabled: true, reason: {
  kind: "waiting", compact: "Waiting for agent",
  description: "Waiting for agent. You can keep adding comments, but can't send another batch yet.",
} };

it("keeps native disablement, readable descriptions and focus through availability changes", async () => {
  const user = userEvent.setup(), onSend = vi.fn();
  const props = { count: 1, selection: "Selected: 1 note", excludedDrafts: 0, busy: false, onSend };
  const { rerender } = render(<ConversationSend {...props} availability={waiting} />);
  const send = screen.getByRole("button", { name: "Send" });
  expect(send).toBeDisabled();
  expect(send).toHaveAccessibleDescription(/Waiting for agent.*Selected: 1 note/);
  await user.tab();
  const wrapper = screen.getByRole("group", { name: "Send unavailable" });
  expect(wrapper).toHaveFocus();
  expect(await screen.findByRole("tooltip")).toHaveTextContent(waiting.reason.description);
  await user.keyboard("{Enter} ");
  expect(onSend).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(wrapper).toHaveFocus();
  rerender(<ConversationSend {...props} availability={{ disabled: false, reason: null }} selection="Ready to send: 1 note" />);
  expect(screen.getByRole("button", { name: "Send" })).toBe(send);
  expect(send).toHaveFocus();
  expect(send).toBeEnabled();
  await user.keyboard("{Enter}");
  expect(onSend).toHaveBeenCalledOnce();
});
