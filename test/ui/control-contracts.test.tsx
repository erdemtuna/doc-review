import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ControlHint } from "@/components/ui/control-hint";
import { DisclosureTrigger } from "@/components/ui/disclosure-trigger";
import { ReceiptRecovery } from "@/components/recovery-notice";
import { confirmationPresentation } from "@/components/conversation-confirmation";

it.each(["default", "outline", "secondary", "ghost", "destructive", "destructive-ghost"] as const)("keeps the %s command on the shared native Button", variant => {
  render(<Button variant={variant} size="sm" disabled>Command</Button>);
  expect(screen.getByRole("button")).toHaveAttribute("data-variant", variant);
  expect(screen.getByRole("button")).toHaveAttribute("data-size", "sm");
  expect(screen.getByRole("button")).toBeDisabled();
});

it("shares keyboard hints without converting informational meaning into a command", async () => {
  const user = userEvent.setup();
  render(<><ControlHint hint="Explicit edit permission"><span role="img" aria-label="Change requested" tabIndex={0}>!</span></ControlHint>
    <IconButton aria-label="Locate">+</IconButton></>);
  await user.tab();
  expect(await screen.findByRole("tooltip", { name: "Explicit edit permission" })).toBeVisible();
  expect(screen.getByRole("img", { name: "Change requested" })).not.toHaveAttribute("title");
  await user.keyboard("{Escape}{Tab}");
  expect(await screen.findByRole("tooltip", { name: "Locate" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Locate" })).not.toHaveAttribute("title");
});

it("binary disclosures express expanded state without owning or remounting content", () => {
  const { rerender } = render(<><DisclosureTrigger expanded controls="draft">Note</DisclosureTrigger><textarea id="draft" defaultValue="Retained" /></>);
  const editor = screen.getByRole("textbox");
  rerender(<><DisclosureTrigger expanded={false} controls="draft">Note</DisclosureTrigger><textarea id="draft" hidden defaultValue="Retained" /></>);
  expect(screen.getByRole("button", { name: "Note" })).toHaveAttribute("aria-expanded", "false");
  expect(document.querySelector("#draft")).toBe(editor);
});

it("makes receipt lookup primary, same-request retry secondary, and locks both during reconciliation", async () => {
  const check = vi.fn(), retry = vi.fn(), user = userEvent.setup();
  const props = { uncertain: { operation: "send", message: "Check the original receipt.", requestId: "request-1" },
    error: "Connection lost", onCheck: check, onRetry: retry, onRefresh: vi.fn() };
  const { rerender } = render(<ReceiptRecovery {...props} busy={false} />);
  expect(screen.getByRole("alert")).toHaveTextContent("send: acceptance unknown");
  expect(screen.getByRole("alert")).toHaveTextContent("Connection lost");
  expect(screen.getByRole("alert")).toHaveTextContent("Check the original receipt.");
  const lookup = screen.getByRole("button", { name: "Check receipt" });
  const replay = screen.getByRole("button", { name: "Retry same request" });
  const refresh = screen.getByRole("button", { name: "Refresh review" });
  expect(lookup).toHaveAttribute("data-variant", "default");
  expect(replay).toHaveAttribute("data-variant", "secondary");
  expect(refresh).toHaveAttribute("data-variant", "outline");
  await user.click(lookup); await user.click(replay);
  expect(check).toHaveBeenCalledOnce(); expect(retry).toHaveBeenCalledOnce();
  rerender(<ReceiptRecovery {...props} busy />);
  expect(lookup).toBeDisabled(); expect(replay).toBeDisabled(); expect(refresh).toBeDisabled();
});

it("covers every authoritative confirmation with an action-specific title, verb and intent", () => {
  for (const [action, verb] of [["end", "End review"], ["abandon", "Abandon submission"], ["delete", "Delete thread"], ["revert", "Revert edits"]] as const) {
    expect(confirmationPresentation(action, false)).toMatchObject({ verb, variant: "destructive" });
    expect(confirmationPresentation(action, false).title).not.toMatch(/Confirm/);
  }
  expect(confirmationPresentation("resolve", false)).toEqual({ title: "Resolve conversation?", verb: "Resolve", variant: "outline" });
  expect(confirmationPresentation("resolve", true)).toEqual({ title: "Reopen conversation?", verb: "Reopen", variant: "outline" });
});
