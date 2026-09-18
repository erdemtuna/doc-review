import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DisclosureSection } from "@/components/ui/disclosure-section";

afterEach(cleanup);

it("keeps hidden content mounted and exposes a keyboard-operable counted heading", async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  const props = { label: "Comments", headingId: "heading", countId: "count", contentId: "content", count: 2, onOpenChange };
  const child = <input aria-label="Draft" defaultValue="Keep this" />;
  const { rerender } = render(<DisclosureSection {...props} open>{child}</DisclosureSection>);
  const draft = screen.getByRole("textbox", { name: "Draft" });
  const trigger = screen.getByRole("button", { name: "Comments" });
  expect(trigger).toHaveAttribute("aria-controls", "content");
  expect(trigger).toHaveAccessibleDescription("2");
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  rerender(<DisclosureSection {...props} open={false}>{child}</DisclosureSection>);
  expect(draft).not.toBeVisible();
  expect(draft).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).toBeNull();
  rerender(<DisclosureSection {...props} open>{child}</DisclosureSection>);
  expect(screen.getByRole("textbox")).toBe(draft);
  expect(draft).toHaveValue("Keep this");
});

it("explains and guards a locked disclosure for pointer and keyboard input", async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  render(<DisclosureSection label="Comments" headingId="heading" countId="count"
    contentId="content" count={1} open lockReason="Save or cancel the comment edit to collapse."
    onOpenChange={onOpenChange}><input aria-label="Edit comment" /></DisclosureSection>);
  const trigger = screen.getByRole("button", { name: "Comments" });
  expect(trigger).toHaveAttribute("aria-disabled", "true");
  expect(trigger).toHaveAccessibleDescription("1 Save or cancel the comment edit to collapse.");
  await user.click(trigger);
  await user.keyboard(" ");
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox")).toBeVisible();
});
