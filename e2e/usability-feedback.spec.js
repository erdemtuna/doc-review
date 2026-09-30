import fs from "node:fs";
import { test, expect, openReview, waitForSdk, writeFile, seedThread, feedback, sendPending, handled,
  renderedContrast, mutate, conversation } from "./helpers.js";
import { threadAction } from "./conversation-actions.js";

const source = '<!doctype html><body><p id="copy" tabindex="0">An exact passage for review.</p></body>';
async function layout(page) {
  return page.locator(".conversation-panel").evaluate(panel =>
    [".conversation-panel-header", ".conversation-inventory", ".conversation-footer"].map(selector => {
      const { x, y, width, height } = panel.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height };
    }));
}

for (const theme of ["light", "dark"]) for (const [width, height] of [[1280, 800], [390, 480], [320, 400]]) {
  test(`lifecycle notifications, right-aligned delivery and independent filters ${theme} ${width}x${height}`, async ({ page, review }, info) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(theme => localStorage.setItem("doc-review:theme", theme), theme);
    const ref = await openReview(page, review, writeFile(review, `feedback-${theme}-${width}.html`, source));
    await waitForSdk(page);
    const { threadId } = await seedThread(review, ref, "A handled discussion.", {
      kind: "element", anchor: { selector: "#copy", label: "Exact passage" },
    });
    await feedback(page);
    const card = page.locator(`[data-thread="${threadId}"]`);
    const toast = page.locator(".conversation-toast");
    await expect(toast).toHaveCount(0);
    const delivery = card.locator(".conversation-delivery");
    for (const label of ["Not sent", "Sent", "Received"]) {
      await expect(delivery).toHaveAccessibleName(label);
      await expect(async () => {
        const bounds = await delivery.boundingBox();
        const row = await card.locator(".conversation-meta").first().boundingBox();
        expect(Math.abs(bounds.x + bounds.width - row.x - row.width)).toBeLessThanOrEqual(1);
        expect(bounds.y).toBeGreaterThanOrEqual(row.y);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(row.y + row.height);
      }).toPass({ timeout: 5000 });
      if (label === "Not sent") {
        await sendPending(review, ref);
        await expect(toast).toHaveText("Waiting for agent.");
        await toast.getByRole("button", { name: "Dismiss notification" }).click();
      } else if (label === "Sent") {
        await conversation(review, ref, "poll");
      }
    }
    await expect(toast).toHaveCount(0);
    await handled(review, ref);
    await expect(toast).toContainText("Agent response received. Ready to review.");
    await expect(card.locator(".conversation-response")).toBeVisible();
    await toast.hover();
    const notified = await layout(page);
    await expect(async () => {
      const bounds = await toast.boundingBox(), toolbar = await page.locator(".shell-toolbar").boundingBox();
      expect(bounds.x).toBe(16);
      expect(Math.abs(bounds.y - toolbar.y - toolbar.height - 8)).toBeLessThanOrEqual(1);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 16);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
      const dismiss = await toast.getByRole("button", { name: "Dismiss notification" }).boundingBox();
      expect(Math.abs(dismiss.y + dismiss.height / 2 - bounds.y - bounds.height / 2)).toBeLessThanOrEqual(1);
      expect(await toast.evaluate(node => !!node.closest(".conversation-panel"))).toBe(false);
      expect(await renderedContrast(toast)).toBeGreaterThanOrEqual(4.5);
    }).toPass({ timeout: 5000 });
    await page.keyboard.press("F8");
    await expect(page.locator(".conversation-toast-viewport")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(toast).toBeFocused();
    expect(await renderedContrast(toast, "outlineColor")).toBeGreaterThanOrEqual(3);
    await page.screenshot({ path: info.outputPath(`lifecycle-notification-${theme}-${width}.png`), animations: "disabled" });
    await toast.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(toast).toHaveCount(0);
    expect(await layout(page)).toEqual(notified);
    fs.writeFileSync(info.outputPath("layout.json"), JSON.stringify({ notified, dismissed: await layout(page) }, null, 2));
    const filters = page.getByRole("group", { name: "Conversation filters" });
    const open = filters.getByRole("button", { name: /^Open/ });
    const resolved = filters.getByRole("button", { name: /^Resolved/ });
    await expect(open).toHaveAttribute("aria-pressed", "true");
    await expect(resolved).toHaveAttribute("aria-pressed", "false");
    await expect(filters).not.toHaveClass(/segmented-control/);
    await expect(filters.locator("svg")).toHaveCount(0);
    await expect(async () => {
      const one = await open.boundingBox(), two = await resolved.boundingBox();
      expect(two.x - one.x - one.width).toBeGreaterThanOrEqual(8);
      const mode = await page.locator("#modeButton").boundingBox();
      const options = await page.getByRole("button", { name: "Review options" }).boundingBox();
      expect(options.x).toBeGreaterThanOrEqual(mode.x + mode.width);
      expect(Math.abs(options.y - mode.y)).toBeLessThanOrEqual(1);
      expect(options.x + options.width).toBeLessThanOrEqual(width);
    }).toPass({ timeout: 5000 });
    expect(await page.locator(".shell-tools button").evaluateAll(nodes => nodes.map(n => n.getAttribute("aria-label"))))
      .toEqual(["Feedback", "Page mode: View", "Review options"]);
    await resolved.click();
    await expect(open).toHaveAttribute("aria-pressed", "true");
    await expect(resolved).toHaveAttribute("aria-pressed", "true");
    await open.click(); await resolved.click();
    await expect(open).toHaveAttribute("aria-pressed", "false");
    await expect(resolved).toHaveAttribute("aria-pressed", "false");
    await expect(card).toBeHidden();
    await open.click(); await resolved.click();
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Resolve conversation", exact: true }).click();
    await expect(card).toHaveAttribute("data-status", "resolved");
    await expect(toast).toHaveCount(0);
    await expect(page.getByRole("status", { name: "Submission details" })).toHaveCount(0);
    await (await threadAction(page, card, "Reopen conversation")).click();
    await expect(card).toHaveAttribute("data-status", "open");
    await expect(toast).toHaveCount(0);
    await (await threadAction(page, card, "Focus")).click();
    await expect(page.getByRole("button", { name: "Back to Feedback", exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`focus-return-${theme}-${width}.png`), animations: "disabled" });
    await card.getByRole("button", { name: "Resolve conversation", exact: true }).click();
    await expect(card).toHaveAttribute("data-status", "resolved");
    await expect(toast).toHaveCount(0);
    await (await threadAction(page, card, "Reopen conversation")).click();
    await expect(card).toHaveAttribute("data-status", "open");
    await expect(toast).toHaveCount(0);
    await (await threadAction(page, card, "Beside target")).click();
    await expect(page.getByRole("button", { name: "Open in Feedback", exact: true })).toBeInViewport({ ratio: 1 });
    await expect(delivery).toHaveAccessibleName("Received");
    await page.screenshot({ path: info.outputPath(`delivery-transfer-${theme}-${width}.png`), animations: "disabled" });
  });
}

test("visible Focus return preserves the exact composing editor, caret and independent filters", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "focus-return.html", source));
  await waitForSdk(page);
  const { threadId } = await seedThread(review, ref, "A saved comment.");
  await feedback(page);
  const card = page.locator(`[data-thread="${threadId}"]`);
  await card.getByRole("button", { name: "Reply", exact: true }).click();
  const editor = card.getByRole("textbox", { name: "Reply", exact: true });
  await editor.fill("Keep this exact composing reply.");
  await editor.evaluate(node => { window.retainedEditor = node; node.setSelectionRange(2, 9); });
  await (await threadAction(page, card, "Focus")).click();
  await editor.focus();
  await editor.dispatchEvent("compositionstart", { data: "途中" });
  const back = page.getByRole("button", { name: "Back to Feedback", exact: true });
  await expect(back).toBeInViewport({ ratio: 1 });
  await back.click();
  await expect(page.locator(".conversation-panel")).toHaveAttribute("data-host", "feedback");
  expect(await editor.evaluate(node => [node === window.retainedEditor, node.selectionStart, node.selectionEnd]))
    .toEqual([true, 2, 9]);
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("Keep this exact composing reply.");
  await expect(card.getByRole("button", { name: "Add reply", exact: true })).toBeDisabled();
  await editor.dispatchEvent("compositionend", { data: "途中" });
  await expect(card.getByRole("button", { name: "Add reply", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Open (1)", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Resolved (0)", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(back).toHaveCount(0);
  await (await threadAction(page, card, "Focus")).click();
  await back.focus(); await back.press("Enter");
  await expect(card.getByRole("button", { name: "Conversation actions", exact: true })).toBeFocused();
  expect(await editor.evaluate(node => [node === window.retainedEditor, node.selectionStart, node.selectionEnd]))
    .toEqual([true, 2, 9]);
});

test("Sent and Received keep honest keyboard hints and layered Escape", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "delivery-hints.html", source));
  await waitForSdk(page);
  const { threadId } = await seedThread(review, ref, "A submitted message.");
  await sendPending(review, ref);
  await expect(page.locator(".conversation-toast")).toHaveText("Waiting for agent.");
  await page.locator(".conversation-toast").getByRole("button", { name: "Dismiss notification" }).click();
  const card = page.locator(`[data-thread="${threadId}"]`);
  for (const [label, hint] of [
    ["Sent", "not confirmation of agent pickup or a read receipt"],
    ["Received", "not a read receipt or proof the agent is currently working"],
  ]) {
    await feedback(page);
    const icon = card.getByRole("img", { name: label, exact: true });
    await expect(icon).toBeVisible();
    await expect(card.locator(".conversation-response")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Edit message", exact: true })).toHaveCount(0);
    await icon.focus();
    await expect(icon).toHaveAccessibleName(label);
    await expect(icon).not.toHaveAttribute("title");
    await expect(icon).not.toHaveAttribute("aria-pressed");
    await expect(page.getByRole("tooltip")).toContainText(hint);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(icon).toBeFocused();
    await expect(page.locator(".conversation-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".conversation-panel")).toBeHidden();
    await expect(page.locator("#commentsButton")).toBeFocused();
    if (label === "Sent") await conversation(review, ref, "poll");
  }
});

test("lifecycle notifications expire while reading the iframe; ended information persists and reload is quiet", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "notice-expiry.html", source));
  let frame = await waitForSdk(page);
  const { threadId } = await seedThread(review, ref, "A handled comment.");
  await sendPending(review, ref);
  await expect(page.locator(".conversation-toast")).toHaveText("Waiting for agent.");
  await page.locator(".conversation-toast").getByRole("button", { name: "Dismiss notification" }).click();
  await page.reload(); frame = await waitForSdk(page);
  await expect(page.getByRole("status", { name: "Waiting for agent", exact: true })).toBeVisible();
  await expect(page.locator(".conversation-toast")).toHaveCount(0);
  await handled(review, ref); await feedback(page);
  const card = page.locator(`[data-thread="${threadId}"]`);
  await expect(card.locator(".conversation-response")).toBeVisible();
  await expect(page.locator(".conversation-toast")).toHaveText("Agent response received. Ready to review.");
  await frame.locator("#copy").focus();
  await expect(frame.locator("#copy")).toBeFocused();
  await expect(page.locator(".conversation-toast")).toHaveCount(0, { timeout: 7000 });
  await expect(frame.locator("#copy")).toBeFocused();
  await mutate(review, ref, "end", { confirmUnsentReadOnly: true });
  await expect(page.getByText("Review ended", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Submission details" })).toContainText("read-only");
  await expect(page.locator(".conversation-toast")).toHaveText("Review ended.");
  await expect(page.locator(".conversation-toast")).toHaveCount(0, { timeout: 7000 });
  await expect(page.getByRole("status", { name: "Submission details" })).toContainText("read-only");
  await page.reload(); await waitForSdk(page);
  await expect(page.getByText("Review ended", { exact: true })).toBeVisible();
  await expect(page.locator(".conversation-toast")).toHaveCount(0);
});
