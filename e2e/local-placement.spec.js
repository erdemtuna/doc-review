import fs from "node:fs";
import { test, expect, openReview, writeFile, waitForSdk, listed, seedThread } from "./helpers.js";
import { threadAction } from "./conversation-actions.js";

const sizes = [[1366, 800], [1024, 768], [900, 700], [720, 760], [1100, 550]];
const html = `<!doctype html><html><head><style>
body { margin: 32px; font: 18px/1.5 system-ui; } #copy { margin: 24px 0; }
</style></head><body><p id="copy" tabindex="0">A carefully selected passage needs an explanation, not a rewritten document.</p>
<button id="live" onclick="this.textContent='Still interactive'">Authored interaction</button><div style="height:1800px"></div></body></html>`;

async function clearTarget(page, frame, panel) {
  await expect.poll(async () => {
    if (await panel.evaluate(node => getComputedStyle(node).opacity) !== "1") return false;
    const bounds = await panel.boundingBox(), target = await frame.locator("#copy").boundingBox();
    return (bounds.x >= target.x + target.width || bounds.x + bounds.width <= target.x ||
      bounds.y >= target.y + target.height || bounds.y + bounds.height <= target.y) &&
      bounds.y + bounds.height <= await page.evaluate(() => visualViewport.offsetTop + visualViewport.height);
  }).toBe(true);
  const bounds = await panel.boundingBox(), iframe = await page.locator("#frame").boundingBox();
  const target = await frame.locator("#copy").boundingBox();
  expect(bounds.x >= target.x + target.width || bounds.x + bounds.width <= target.x ||
    bounds.y >= target.y + target.height || bounds.y + bounds.height <= target.y).toBe(true);
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(await page.evaluate(() => visualViewport.offsetTop + visualViewport.height));
  expect(await page.locator(".stage").evaluate(node => node.inert)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  return { panel: bounds, frame: iframe, target };
}
async function hit(button) {
  await expect.poll(() => button.evaluate(node => {
    const box = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
}

for (const [width, height] of sizes) for (const theme of ["light", "dark"]) {
  test(`target-safe local composition and short thread ${width}x${height} ${theme}`, async ({ page, review }, info) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(theme => localStorage.setItem("doc-review:theme", theme), theme);
    const ref = await openReview(page, review, writeFile(review, `local-${width}-${theme}.html`, html));
    const frame = await waitForSdk(page), before = await page.locator("#frame").boundingBox();
    await frame.locator("#copy").focus();
    await frame.locator("#copy").press("Control+Alt+m");
    const panel = page.locator(".conversation-panel"), input = page.locator("#draft-new");
    await expect(panel).toHaveAttribute("data-host", "compose");
    await expect(input).toBeFocused();
    await input.fill("Keep the source; explain this passage.");
    await input.press("Escape");
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Keep the source; explain this passage.");
    if (width === 1366 && theme === "light") {
      await input.evaluate(node => { window.localNewEditor = node; node.setSelectionRange(4, 9);
        node.dispatchEvent(new Event("select", { bubbles: true }));
        node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
      await page.setViewportSize({ width: 720, height: 760 });
      await clearTarget(page, frame, panel);
      await expect(input).toBeFocused();
      expect(await input.evaluate(node => [node === window.localNewEditor, node.selectionStart, node.selectionEnd])).toEqual([true, 4, 9]);
      await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      await page.setViewportSize({ width, height });
      await clearTarget(page, frame, panel);
      await expect(input).toBeFocused();
      await input.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    }
    const composer = await clearTarget(page, frame, panel);
    expect(composer.frame).toEqual(before);
    await hit(panel.getByRole("button", { name: "Save", exact: true }));
    await hit(panel.getByRole("checkbox", { name: "Request a change" }));
    await page.screenshot({ path: info.outputPath(`compose-${theme}-${width}.png`), caret: "initial" });
    await input.press("Enter");
    await expect(input).toHaveCount(0);
    const thread = (await listed(review, ref, "threads")).items[0].thread;
    await expect(frame.locator(".block-badge")).toBeVisible();
    await frame.locator(".block-badge").click();
    await expect(panel).toHaveAttribute("data-host", "adjacent");
    await expect(panel.getByRole("button", { name: "Reply", exact: true })).toBeVisible();
    await expect.poll(async () => (await panel.boundingBox()).height).toBeLessThan(300);
    const short = await clearTarget(page, frame, panel);
    expect(short.frame).toEqual(before);
    await hit(panel.getByRole("button", { name: "Reply", exact: true }));
    await page.screenshot({ path: info.outputPath(`short-${theme}-${width}.png`), caret: "initial" });
    await panel.getByRole("button", { name: "Reply", exact: true }).click();
    const reply = panel.getByRole("textbox", { name: "Reply", exact: true });
    await reply.fill("A retained local reply");
    await reply.evaluate(node => { window.localReply = node; node.setSelectionRange(2, 8); node.dispatchEvent(new Event("select", { bubbles: true })); });
    await page.locator("#theme").click();
    await expect(page.locator("#theme")).toBeFocused();
    expect(await reply.evaluate(node => [node === window.localReply, node.selectionStart, node.selectionEnd])).toEqual([true, 2, 8]);
    await clearTarget(page, frame, panel);
    await hit(panel.getByRole("button", { name: "Save", exact: true }));
    await (await threadAction(page, page.locator(`[data-thread="${thread.threadId}"]`), "Back to Feedback")).click();
    await expect(panel).toHaveAttribute("data-host", "feedback");
    expect(Math.round((await panel.boundingBox()).width)).toBe(Math.min(380, width));
    expect(await page.locator(".stage").evaluate(node => node.inert)).toBe(true);
    expect(await reply.evaluate(node => node === window.localReply)).toBe(true);
    await expect(reply).toHaveValue("A retained local reply");
    fs.writeFileSync(info.outputPath("geometry.json"), JSON.stringify({ width, height, theme, composer, short }, null, 2));
  });
}

test("long local transcript, browser zoom and resize keep controls and deliberate reading without focus theft", async ({ page, review }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1366, height: 800 });
  const ref = await openReview(page, review, writeFile(review, "long-local.html", html));
  const frame = await waitForSdk(page);
  const { threadId } = await seedThread(review, ref, "Long discussion. ".repeat(250),
    { kind: "element", anchor: { selector: "#copy", label: "Selected passage" } });
  await frame.locator(".block-badge").click();
  const panel = page.locator(".conversation-panel"), card = page.locator(`[data-thread="${threadId}"]`);
  await expect(panel).toHaveAttribute("data-host", "adjacent");
  const transcript = card.locator(".conversation-transcript");
  await hit(card.getByRole("button", { name: "Reply", exact: true }));
  await card.getByRole("button", { name: "Reply", exact: true }).click();
  const editor = card.getByRole("textbox", { name: "Reply", exact: true });
  await editor.fill("Retain a long-thread draft");
  await editor.evaluate(node => { window.longEditor = node; node.setSelectionRange(3, 9); node.dispatchEvent(new Event("select", { bubbles: true }));
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
  await transcript.evaluate(node => { node.scrollTop = 160; });
  await expect.poll(() => transcript.evaluate(node => node.scrollTop)).toBe(160);
  await page.locator("#theme").click();
  await expect.poll(() => transcript.evaluate(node => node.scrollTop)).toBe(160);
  const samples = [];
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await expect(panel).toHaveAttribute("data-host", "adjacent");
    await expect(editor).toBeVisible();
    await expect(page.locator("#theme")).toBeFocused();
    expect(await editor.evaluate(node => [node === window.longEditor, node.selectionStart, node.selectionEnd])).toEqual([true, 3, 9]);
    await expect(card.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await hit(card.getByRole("checkbox", { name: "Request a change" }));
    samples.push(await clearTarget(page, frame, panel));
    await page.screenshot({ path: info.outputPath(`long-${width}.png`), caret: "initial" });
  }
  await editor.focus();
  await page.setViewportSize({ width: 720, height: 760 });
  await expect(editor).toBeFocused();
  expect(await editor.evaluate(node => [node === window.longEditor, node.selectionStart, node.selectionEnd])).toEqual([true, 3, 9]);
  await page.setViewportSize({ width: 1366, height: 800 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.25 });
  await expect.poll(() => page.evaluate(() => visualViewport.scale)).toBe(1.25);
  await clearTarget(page, frame, panel);
  await hit(card.getByRole("checkbox", { name: "Request a change" }));
  await card.getByRole("checkbox", { name: "Request a change" }).check();
  await expect(card.getByRole("checkbox", { name: "Request a change" })).toBeChecked();
  await page.screenshot({ path: info.outputPath("zoom-125.png"), caret: "initial" });
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await editor.focus();
  await frame.locator("#copy").evaluate(node => { node.style.cssText = "position:fixed;inset:0;margin:0;width:100%;height:100%"; });
  await expect(panel).toHaveAttribute("data-host", "focus");
  await expect(page.getByText(/not enough room beside, above or below/)).toBeVisible();
  await expect(frame.locator('.block-marker[data-active="true"], mark.eh-active')).toHaveCount(0);
  await expect(editor).toBeFocused();
  expect(await editor.evaluate(node => [node === window.longEditor, node.selectionStart, node.selectionEnd])).toEqual([true, 3, 9]);
  await expect(card.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await hit(card.getByRole("checkbox", { name: "Request a change" }));
  await page.screenshot({ path: info.outputPath("measured-fallback.png"), caret: "initial" });
  await editor.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await hit(card.getByRole("button", { name: "Save", exact: true }));
  await card.getByRole("button", { name: "Save", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(editor).toHaveCount(0);
  fs.writeFileSync(info.outputPath("long-geometry.json"), JSON.stringify(samples, null, 2));
});
