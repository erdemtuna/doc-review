import fs from "node:fs";
import { test, expect, openReview, waitForSdk, writeFile, seedThread, feedback, sendPending, handled, mutate } from "./helpers.js";
import { threadAction } from "./conversation-actions.js";

test("reading fixture retains the four reported conversation states", async ({ page, review }, info) => {
  const ref = await openReview(page, review, writeFile(review, "reading.html", `<!doctype html>
<html><head><style>body{max-width:800px;margin:64px auto;padding:0 28px;font:19px/1.65 Georgia;background:#f7f5ed;color:#243b38}h1{font-size:48px}p{margin:32px 0}</style></head>
<body><h1>Field Notes: less noise, better decisions</h1>
<p id="intro" tabindex="0">A shared place for small teams to turn scattered observations into clear next steps.</p>
<h2>Why this exists</h2><p>Useful customer observations often disappear into meeting notes and chat threads.</p>
<input aria-label="Document input"><div style="height:900px"></div></body></html>`));
  await waitForSdk(page);
  const metrics = [];
  async function capture(state) {
    for (const [theme, width] of [["light", 1366], ["dark", 720]]) {
      await page.setViewportSize({ width, height: 800 });
      if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
      await expect.poll(() => page.locator(".conversation-panel").evaluate(n => n.getAnimations({ subtree: true })
        .some(animation => animation.playState === "running"))).toBe(false);
      metrics.push(await page.evaluate(({ state, theme, width }) => {
        const panel = document.querySelector(".conversation-panel"), card = panel.querySelector("[data-thread]:not([hidden])");
        const color = selector => getComputedStyle(document.querySelector(selector)).backgroundColor;
        return { state, theme, width, panel: panel.getBoundingClientRect().toJSON(),
          card: card?.getBoundingClientRect().toJSON(), stageInert: document.querySelector(".stage").inert,
          toolbarColor: color(".shell-toolbar"), inventoryColor: color(".conversation-inventory"),
          messages: [...panel.querySelectorAll(".conversation-body")].map(n => n.textContent) };
      }, { state, theme, width }));
      await page.screenshot({ path: info.outputPath(`${state}-${theme}-${width}.png`), caret: "initial" });
    }
  }
  await feedback(page);
  await capture("empty");
  const { threadId } = await seedThread(review, ref, "do you like this prose?",
    { kind: "element", anchor: { selector: "#intro", label: "Introduction" } });
  const card = page.locator(`[data-thread="${threadId}"]`);
  await expect(card).toBeVisible();
  await capture("short-sidebar");
  const pending = metrics.find(item => item.state === "short-sidebar" && item.theme === "light");
  expect(pending.inventoryColor).toBe(pending.toolbarColor);
  expect(pending.card.height).toBeLessThan(180);
  const title = await card.locator(".conversation-thread-title").boundingBox();
  const jump = await card.getByRole("button", { name: "Jump to", exact: true }).boundingBox();
  expect(Math.abs(title.y - jump.y)).toBeLessThan(8);
  await expect(card.getByRole("button", { name: "Focus", exact: true })).toHaveCount(0);
  await (await threadAction(page, card, "Focus")).click();
  await card.getByRole("button", { name: "Back to Feedback", exact: true }).click();
  await (await threadAction(page, card, "Beside target")).click();
  await expect(page.locator(".conversation-panel")).toHaveAttribute("data-host", "adjacent");
  await capture("short-in-place");
  await page.locator("#commentsButton").click();
  await feedback(page);
  await sendPending(review, ref);
  await handled(review, ref);
  await expect(card.locator(".conversation-response")).toBeVisible();
  await mutate(review, ref, "reply", { threadId, body: "what could be the alternatives?", intent: "discuss" });
  await expect(card).toContainText("what could be the alternatives?");
  await capture("followup");
  fs.writeFileSync(info.outputPath("reading-metrics.json"), JSON.stringify(metrics, null, 2));
});
