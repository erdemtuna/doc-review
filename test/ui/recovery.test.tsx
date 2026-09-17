import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRecoveryController, type RecoveryContext } from "../../src/recovery-controller.js";
import { RecoveryMenu, RecoveryNotices } from "@/components/recovery";

afterEach(cleanup);

function fixture() {
  const context: RecoveryContext = {
    page: { key: "a", kind: "file", markdown: false, executionPreference: "auto" },
    rendered: { executionMode: "interactive", savePolicy: "feedback-only", executionNotice: "External modules are unsupported." },
    identity: { key: "a", renderId: "r_a", generation: 1, loading: false },
    loading: false, pendingReload: false, comparing: false, ended: false, frameError: null,
    reload: { visible: false, message: "", error: false },
  };
  const reload = vi.fn(async () => {});
  const request = vi.fn(async () => ({
    page: {
      key: "a", kind: "file", markdown: false, file: "sample.html", filename: "sample.html",
      executionMode: "static", executionPreference: "static", savePolicy: "feedback-only",
      feedbackOnly: true, canRevert: true, pollCommand: "", historySupported: true, comments: [], edits: [],
    },
  }));
  const runtime = createRecoveryController({
    sessionId: "session", read: () => context, request,
    changed: (page) => { context.page = page; }, failed: vi.fn(), menuChanged: vi.fn(),
    reload, keepCurrent: () => { context.reload.visible = false; },
  });
  return { context, runtime, request, reload };
}

it("More is a nonmodal keyboard menu with policy details and focus return", async () => {
  const { runtime, request } = fixture();
  const user = userEvent.setup();
  render(<StrictMode><RecoveryMenu runtime={runtime} /><RecoveryNotices runtime={runtime} />
    <input aria-label="Existing draft" defaultValue="Keep my draft" /></StrictMode>);
  const more = screen.getByRole("button", { name: "More" });
  more.focus();
  await user.keyboard("{Enter}");
  expect(more).toHaveAttribute("aria-controls", "recoveryMenu");
  expect(screen.getByRole("menu")).toHaveAttribute("aria-labelledby", "reviewDetails");
  expect(screen.getByText("External modules are unsupported.")).toBeVisible();
  expect(document.body.style.pointerEvents).not.toBe("none");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(more).toHaveFocus();
  expect(screen.getByLabelText("Existing draft")).toHaveValue("Keep my draft");
  await user.click(more);
  await user.click(screen.getByRole("menuitem", { name: "Reload without scripts" }));
  expect(request).toHaveBeenCalledTimes(1);
  await user.click(more);
  expect(screen.getByRole("menuitem", { name: "Use page interactions" })).toBeVisible();
});

it("prioritizes the draft-safe source notice over pending status without changing a draft", async () => {
  const { runtime, context } = fixture();
  context.pendingReload = true;
  context.reload = { visible: true, message: "Reload keeps your comment drafts as unresolved excerpts.", error: false };
  runtime.publish();
  const user = userEvent.setup();
  render(<><RecoveryNotices runtime={runtime} /><textarea aria-label="Existing draft" defaultValue="Keep this selection" /></>);
  expect(screen.getByRole("status")).toHaveTextContent("Source updated");
  expect(document.getElementById("executionStatus")).toBeNull();
  expect(screen.getByRole("button", { name: "Reload latest; keep comment drafts" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Keep this page" }));
  expect(screen.queryByRole("region", { name: "Source update" })).toBeNull();
  expect(screen.getByLabelText("Existing draft")).toHaveValue("Keep this selection");
  act(() => { context.comparing = true; runtime.publish(); });
  expect(screen.queryByRole("status")).toBeNull();
});

it("shows failed-frame recovery as an alert with an enabled retry despite the failed loading phase", () => {
  const { runtime, context } = fixture();
  context.loading = true;
  context.frameError = "The reviewed page could not confirm it is ready.";
  context.reload = { visible: true, message: "Reload keeps your comment drafts.", error: true };
  runtime.publish();
  render(<RecoveryNotices runtime={runtime} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Review needs attention");
  expect(screen.getByRole("button", { name: "Reload latest; keep comment drafts" })).toBeEnabled();
});

it("hides unavailable recovery and preserves loading status for a non-file review", () => {
  const { runtime, context } = fixture();
  context.page = { kind: "url", url: "http://localhost:3000/" };
  context.rendered = null;
  context.loading = true;
  runtime.publish();
  render(<><RecoveryMenu runtime={runtime} /><RecoveryNotices runtime={runtime} /></>);
  expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Loading page");
});
