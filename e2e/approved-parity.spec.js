import fs from "node:fs";
import { test, expect, openReview, waitForSdk, writeFile, seedThread, feedback } from "./helpers.js";
import { fieldNotes, summaryFeedback, actionFeedback } from "../test/fixtures/readme-review.js";
import { approvedUiParity } from "../test/fixtures/approved-ui-parity.js";

test("approved Field Notes geometry, pending hierarchy and overlay remain stable without hover or scrolling", async ({ page, review }, info) => {
  test.setTimeout(60_000);
  const ref = await openReview(page, review, writeFile(review, "approved-field-notes.html", fieldNotes()));
  await waitForSdk(page);
  await seedThread(review, ref, summaryFeedback, { kind: "element", anchor: { selector: "#summary", label: "Summary" } });
  await seedThread(review, ref, actionFeedback, { kind: "element", anchor: { selector: "#action", label: "Call to action" } });
  await feedback(page);
  const body = page.locator(".conversation-body").filter({ hasText: actionFeedback });
  const samples = [];
  for (const size of approvedUiParity.sizes) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: size.width, height: size.height });
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
    else await page.locator("#theme").focus();
    await page.mouse.move(0, 0);
    await expect.poll(() => page.locator(".shell-toolbar").evaluate(node => node.getBoundingClientRect().height)).toBe(size.toolbar);
    await expect(page.locator("#theme")).toBeFocused();
    const geometry = await body.evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      const line = [...range.getClientRects()].find(rect => rect.width && rect.height);
      let top = 0, bottom = innerHeight;
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(ancestor).overflowY)) continue;
        const box = ancestor.getBoundingClientRect();
        top = Math.max(top, box.top + ancestor.clientTop);
        bottom = Math.min(bottom, box.top + ancestor.clientTop + ancestor.clientHeight);
      }
      return { font: parseFloat(getComputedStyle(node).fontSize), messageTop: line.top, naturalLine: line.height,
        visibleLine: Math.max(0, Math.min(line.bottom, bottom) - Math.max(line.top, top)) };
    });
    expect(geometry.font).toBe(approvedUiParity.bodyFont);
    expect(geometry.messageTop).toBe(size.messageTop);
    expect(geometry.visibleLine).toBe(geometry.naturalLine);
    expect((await page.locator(".conversation-panel").boundingBox()).width).toBe(size.panel);
    expect((await page.locator("#frame").boundingBox()).width).toBe(size.width);
    await expect(page.getByRole("button", { name: "Open (2)", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Resolved (0)", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#send")).toHaveText("Send (2)");
    await expect(page.locator("#commentsButton")).toContainText("2 saved pending feedback items");
    const hit = await page.locator("#theme").evaluate(node => {
      const box = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    });
    expect(hit).toBe(true);
    samples.push({ ...size, theme, ...geometry });
    await page.screenshot({ path: info.outputPath(`approved-${theme}-${size.width}x${size.height}.png`), animations: "disabled" });
  }
  fs.writeFileSync(info.outputPath("approved-parity.json"), JSON.stringify({ provenance: approvedUiParity, samples }, null, 2));
});
