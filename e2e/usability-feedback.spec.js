import fs from "node:fs";
import { test, expect, openReview, waitForSdk, writeFile, seedThread, feedback, sendPending, handled,
  renderedContrast, mutate } from "./helpers.js";
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
  test(`independent filters, far-right utilities and out-of-flow notifications ${theme} ${width}x${height}`, async ({ page, review }, info) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(theme => localStorage.setItem("doc-review:theme", theme), theme);
    const ref = await openReview(page, review, writeFile(review, `feedback-${theme}-${width}.html`, source));
    await waitForSdk(page);
    const { threadId } = await seedThread(review, ref, "A handled discussion.", {
      kind: "element", anchor: { selector: "#copy", label: "Exact passage" },
    });
    await sendPending(review, ref); await handled(review, ref); await feedback(page);
    const card = page.locator(`[data-thread="${threadId}"]`);
    await expect(card.locator(".conversation-response")).toBeVisible();
    const filters = page.getByRole("group", { name: "Conversation filters" });
    const open = filters.getByRole("button", { name: /^Open/ });
    const resolved = filters.getByRole("button", { name: /^Resolved/ });
    await expect(open).toHaveAttribute("aria-pressed", "true");
    await expect(resolved).toHaveAttribute("aria-pressed", "false");
    await expect(filters).not.toHaveClass(/segmented-control/);
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
    const before = await layout(page);
    await card.getByRole("button", { name: "Resolve conversation", exact: true }).click();
    const toast = page.locator(".conversation-toast");
    await expect(toast).toContainText("Conversation resolved.");
    await toast.hover();
    await expect(page.getByRole("status", { name: "Submission details" })).toHaveCount(0);
    await expect(async () => {
      expect(await layout(page)).toEqual(before);
      expect(await toast.evaluate(node => !!node.closest(".conversation-panel"))).toBe(false);
      const bounds = await toast.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
      if (width <= 390) {
        const footer = await page.locator(".conversation-footer").boundingBox();
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(footer.y - 8);
      }
      expect(await renderedContrast(toast)).toBeGreaterThanOrEqual(4.5);
    }).toPass({ timeout: 5000 });
    await expect(toast.getByRole("button", { name: "Undo resolve" })).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("F8");
    await expect(page.locator(".conversation-toast-viewport")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(toast).toBeFocused();
    expect(await renderedContrast(toast, "outlineColor")).toBeGreaterThanOrEqual(3);
    await page.screenshot({ path: info.outputPath(`feedback-notification-${theme}-${width}.png`), animations: "disabled" });
    await toast.getByRole("button", { name: "Undo resolve" }).click();
    await expect(toast).toContainText("Conversation reopened.");
    await expect(card).toHaveAttribute("data-status", "open");
    await toast.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(toast).toHaveCount(0);
    expect(await layout(page)).toEqual(before);
    fs.writeFileSync(info.outputPath("layout.json"), JSON.stringify({ before, after: await layout(page) }, null, 2));
    await (await threadAction(page, card, "Focus")).click();
    await expect(page.getByRole("button", { name: "Back to Feedback", exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`focus-return-${theme}-${width}.png`), animations: "disabled" });
    await card.getByRole("button", { name: "Resolve conversation", exact: true }).click();
    await toast.getByRole("button", { name: "Undo resolve", exact: true }).click();
    await expect(toast).toContainText("Conversation reopened.");
    await expect(async () => {
      const row = await card.locator(".conversation-reply").boundingBox();
      const bounds = await toast.boundingBox();
      expect(bounds.x >= row.x + row.width || bounds.x + bounds.width <= row.x ||
        bounds.y + bounds.height <= row.y - 8 || bounds.y >= row.y + row.height + 8,
      JSON.stringify({ notification: bounds, actions: row })).toBe(true);
    }).toPass({ timeout: 5000 });
    await card.getByRole("button", { name: "Resolve conversation", exact: true }).click();
    await expect(toast).toContainText("Conversation resolved.");
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

test("a notification expires while persistent ended-review information remains", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "notice-expiry.html", source));
  await waitForSdk(page);
  const { threadId } = await seedThread(review, ref, "A handled comment.");
  await sendPending(review, ref); await handled(review, ref); await feedback(page);
  const card = page.locator(`[data-thread="${threadId}"]`);
  await expect(card.locator(".conversation-response")).toBeVisible();
  await card.getByRole("button", { name: "Resolve conversation", exact: true }).click();
  await expect(page.locator(".conversation-toast")).toBeVisible();
  await expect(page.locator(".conversation-toast")).toHaveCount(0, { timeout: 7000 });
  await mutate(review, ref, "end", { confirmUnsentReadOnly: true });
  await expect(page.getByText("Review ended", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Submission details" })).toContainText("read-only");
});
