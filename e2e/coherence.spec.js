import fs from "node:fs";
import { test, expect, openReview, waitForSdk, writeFile, seedThread, feedback, sendPending, handled, reviewSelection } from "./helpers.js";
import { threadAction } from "./conversation-actions.js";

test("coherence evidence covers the reported conversation, composition and result surfaces", async ({ page, review }, info) => {
  test.setTimeout(90_000);
  const ref = await openReview(page, review, writeFile(review, "coherence.html", `<!doctype html>
    <style>body{max-width:780px;margin:56px auto;padding:0 28px;background:#f7f5ed;color:#243b38;font:19px/1.65 Georgia}h1{font-size:44px;line-height:1.2}p{margin:28px 0}</style>
    <h1>Field Notes: less noise, better decisions</h1>
    <p>A shared place for small teams to turn scattered observations into clear next steps.</p>
    <h2 id="purpose" tabindex="0">Why this exists</h2>
    <p id="copy" tabindex="0">Useful customer observations often disappear into meeting notes and chat threads. Keep the evidence beside the decision so the next reader can follow the reasoning.</p>
    <input aria-label="Document input">`));
  await waitForSdk(page);
  const title = await seedThread(review, ref, "wdyt about the title", {
    kind: "selection", anchor: { quote: "exists", prefix: "Why this ", suffix: "", selector: "#purpose" },
  });
  await seedThread(review, ref, "good 2 sentences", {
    kind: "element", anchor: { selector: "#copy", label: "Why this exists · p 2" },
  });
  await sendPending(review, ref);
  await handled(review, ref, { resultNote: "Discussed the selected heading and the two-sentence purpose paragraph. No source changes." });
  await feedback(page);
  const card = page.locator(`[data-thread="${title.threadId}"]`);
  await expect(card.locator(".conversation-response")).toBeVisible();
  const metrics = [];
  async function capture(name) {
    for (const [theme, width, height] of [["light", 1366, 800], ["dark", 720, 760]]) {
      await page.setViewportSize({ width, height });
      if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
      await page.screenshot({ path: info.outputPath(`${name}-${theme}.png`), animations: "disabled", caret: "initial" });
      metrics.push(await page.evaluate(({ name, theme }) => {
        const properties = selector => {
          const node = document.querySelector(selector);
          if (!node) return null;
          const style = getComputedStyle(node);
          return { color: style.color, background: style.backgroundColor, fontSize: style.fontSize,
            lineHeight: style.lineHeight, bounds: node.getBoundingClientRect().toJSON() };
        };
        return { name, theme, host: document.querySelector(".conversation-panel").dataset.host,
          body: properties(".conversation-body"), composer: properties(".conversation-composer"),
          toolbar: properties(".shell-toolbar") };
      }, { name, theme }));
    }
  }
  await capture("answered-sidebar");
  await reviewSelection(page);
  await page.getByRole("button", { name: /Overall note \(optional\)/ }).click();
  await capture("note");
  await page.getByRole("button", { name: /^Review selection/ }).click();
  await (await threadAction(page, card, "Beside target")).click();
  await capture("adjacent");
  await (await threadAction(page, card, "Focus")).click();
  await capture("focused");
  await card.getByRole("button", { name: "Reply", exact: true }).click();
  await card.getByRole("textbox").fill("Keep my reply draft while navigating.");
  await capture("reply");
  await card.getByRole("textbox").press("Escape");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await card.getByRole("button", { name: "Back to Feedback", exact: true }).click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await capture("history");
  await page.getByRole("button", { name: "Back to Feedback", exact: true }).click();
  await page.getByRole("region", { name: "Latest submission result" }).getByRole("button", { name: "View result" }).click();
  const comparison = page.getByRole("region", { name: "Saved comparison" });
  await expect(comparison).toBeVisible();
  await capture("reply-only-result");
  await page.route("**/api/**", route => route.abort("failed"));
  await comparison.getByRole("button", { name: "Source", exact: true }).click();
  await expect(comparison.getByRole("alert")).toBeVisible();
  await capture("unavailable-result");
  await comparison.getByRole("button", { name: "Close comparison" }).click();
  await expect(card).toBeVisible();
  await page.unroute("**/api/**");
  fs.writeFileSync(info.outputPath("surface-metrics.json"), JSON.stringify(metrics, null, 2));
});
