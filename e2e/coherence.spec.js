import fs from "node:fs";
import { test, expect, openReview, waitForSdk, writeFile, seedThread, feedback, sendPending, handled, reviewSelection, mutate } from "./helpers.js";
import { threadAction } from "./conversation-actions.js";

  for (const host of ["feedback", "history", "focus", "adjacent"]) test(`Back restores ${host} locally across failed and late comparison reads`, async ({ page, review }, info) => {
    const ref = await openReview(page, review, writeFile(review, `return-${host}.html`, "<p id='copy'>Keep the document state</p><input aria-label='Authored input'>"));
    const frame = await waitForSdk(page);
    const { threadId } = await seedThread(review, ref, "Explain this paragraph.");
    await sendPending(review, ref, { body: "Change the paragraph.", intent: "request-change" });
    await handled(review, ref, { overallOutcome: "applied" });
    await feedback(page);
    await frame.getByRole("textbox", { name: "Authored input" }).fill("Preserved native input");
    const card = page.locator(`[data-thread="${threadId}"]`);
    await expect(card.locator(".conversation-response")).toBeVisible();
    if (host === "focus" || host === "adjacent") await (await threadAction(page, card, host === "focus" ? "Focus" : "Beside target")).click();
    await card.getByRole("button", { name: "Reply", exact: true }).click();
    const draft = card.getByRole("textbox", { name: "Reply", exact: true, includeHidden: true });
    await draft.fill("Preserve this reply");
    await draft.evaluate(node => { window.returnDraft = node; node.setSelectionRange(2, 7); node.dispatchEvent(new Event("select", { bubbles: true })); });
    let trigger = page.locator("#seeChanges");
    if (host === "feedback") trigger = page.getByRole("region", { name: "Latest submission result" }).getByRole("button", { name: "View changes" });
    if (host === "history") {
      await page.getByRole("button", { name: "History", exact: true }).click();
      await page.locator(".conversation-submission > summary").click();
      trigger = page.getByRole("region", { name: "Submission history" }).getByRole("button", { name: "View changes" });
    }
    const panel = page.locator(".conversation-panel");
    const previousHost = await panel.getAttribute("data-host");
    const inventory = page.locator(".conversation-inventory");
    const previousScroll = await inventory.evaluate(node => node.scrollTop);
    await page.route("**/api/conversation/comparison", route => route.abort("failed"));
    await trigger.click();
    const result = page.getByRole("region", { name: "Saved comparison" });
    await expect(result.locator(".changes-controls[role='alert']")).toContainText("Couldn't load the change preview.");
    await page.screenshot({ path: info.outputPath(`failed-${host}.png`) });
    await result.getByRole("button", { name: "Back to review" }).click();
    await expect(panel).toHaveAttribute("data-host", previousHost);
    await expect(trigger).toBeFocused();
    await expect.poll(() => inventory.evaluate(node => node.scrollTop)).toBe(previousScroll);
    expect(await draft.evaluate(node => [node === window.returnDraft, node.value, node.selectionStart, node.selectionEnd]))
      .toEqual([true, "Preserve this reply", 2, 7]);
    await expect(frame.getByRole("textbox")).toHaveValue("Preserved native input");
    await page.unroute("**/api/conversation/comparison");
    let release, requested = false;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/api/conversation/comparison", async route => { requested = true; await gate; await route.continue(); });
    try {
      await trigger.click();
      await expect.poll(() => requested).toBe(true);
      await expect(result).toContainText("Loading saved comparison");
      await result.getByRole("button", { name: "Back to review" }).press("Escape");
      await expect(result).toBeHidden();
      release();
      await expect(trigger).toBeFocused();
      await page.waitForTimeout(250);
      await expect(result).toBeHidden();
      await expect(panel).toHaveAttribute("data-host", previousHost);
    } finally { release(); }
  });

  test("historical replies reveal the exact older exchange even when resolved and filtered out", async ({ page, review }) => {
    const ref = await openReview(page, review, writeFile(review, "older-reply.html", "<p id='copy'>Original target</p>"));
    await waitForSdk(page);
    const { threadId } = await seedThread(review, ref, "Original question");
    for (let index = 0; index < 4; index++) {
      if (index) await mutate(review, ref, "reply", { threadId, body: `Follow-up ${index}`, intent: "discuss" });
      await sendPending(review, ref);
      await handled(review, ref);
    }
    await mutate(review, ref, "set-thread-status", { threadId, status: "resolved" });
    await feedback(page);
    const card = page.locator(`[data-thread="${threadId}"]`);
    await expect(card).not.toContainText("Original question");
    await page.getByRole("button", { name: "Resolved (1)", exact: true }).click();
    await expect(card).toBeHidden();
    await page.getByRole("button", { name: "History", exact: true }).click();
    const oldest = page.locator(".conversation-submission").last();
    await oldest.locator("summary").first().click();
    await oldest.getByRole("button", { name: "View reply" }).click();
    await expect(card).toBeVisible();
    const exchange = card.locator(".conversation-exchange").filter({ hasText: "Original question" });
    await expect(exchange).toBeFocused();
    await expect(exchange.locator(".conversation-response")).toBeVisible();
  });
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
  const latest = page.getByRole("region", { name: "Latest submission result" });
  await expect(latest).toContainText("Agent replied to 2 conversations");
  await latest.getByRole("button", { name: "View replies" }).click();
  await latest.getByRole("button", { name: "wdyt about the title", exact: true }).click();
  await expect(card).toHaveClass(/focused/);
  await expect(card.locator(".conversation-response")).toBeVisible();
  await expect(page.locator(".conversation-comparison-tools")).toHaveCount(0);
  await capture("reply-only-result");
  await page.route("**/api/**", route => route.abort("failed"));
  await page.locator("#seeChanges").click();
  const changes = page.getByRole("region", { name: "Changes", exact: true });
  await expect(changes).toContainText("No document changes reported.");
  await capture("no-change-results");
  await changes.getByRole("button", { name: "Back to review" }).click();
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/focused/);
  await page.unroute("**/api/**");
  fs.writeFileSync(info.outputPath("surface-metrics.json"), JSON.stringify(metrics, null, 2));
});

for (const host of ["feedback", "focus", "adjacent"]) test(`visible Resolve and version-safe Undo work in ${host}`, async ({ page, review }, info) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const ref = await openReview(page, review, writeFile(review, `resolution-${host}.html`, '<p id="copy" tabindex="0">A reviewed passage.</p>'));
  await waitForSdk(page);
  const { threadId } = await seedThread(review, ref, "Explain this passage.", {
    kind: "element", anchor: { selector: "#copy", label: "Purpose · p 2" },
  });
  await sendPending(review, ref); await handled(review, ref);
  await feedback(page);
  const card = page.locator(`[data-thread="${threadId}"]`);
  await expect(card.locator(".conversation-response")).toBeVisible();
  await expect(card.locator(".conversation-source")).toContainText('Paragraph 2 near "Purpose"');
  if (host !== "feedback") await (await threadAction(page, card, host === "focus" ? "Focus" : "Beside target")).click();
  await card.getByRole("button", { name: "Reply", exact: true }).click();
  const draft = card.getByRole("textbox", { name: "Reply", exact: true });
  await draft.fill("Preserve my exact unsent reply.");
  await card.getByRole("checkbox", { name: "Request a change" }).check();
  await card.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(card.getByRole("status")).toContainText("draft");
  await expect(draft).toHaveValue("Preserve my exact unsent reply.");
  await expect(card.getByRole("checkbox", { name: "Request a change" })).toBeChecked();
  await card.getByRole("button", { name: "Keep reviewing" }).click();
  await card.getByRole("button", { name: "Close reply" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard", exact: true }).click();
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
    await card.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
    const undo = page.getByRole("button", { name: "Undo resolve", exact: true });
    await expect(undo).toBeVisible();
    await undo.scrollIntoViewIfNeeded();
    await expect(undo).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`resolved-${host}-${theme}.png`), caret: "initial" });
    await undo.click();
    await expect(card.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
    await expect(undo).toHaveCount(0);
  }
  await card.getByRole("button", { name: "Resolve", exact: true }).click();
  await mutate(review, ref, "set-thread-status", { threadId, status: "open" });
  await expect(card.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo resolve", exact: true })).toHaveCount(0);
  await mutate(review, ref, "end", { confirmUnsentReadOnly: true });
  await expect(card.getByRole("button", { name: "Resolve", exact: true })).toBeDisabled();
});

test("transient connection recovery preserves authored runtime and drafts without reloading", async ({ page, context, review }) => {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) { super(...args); window.reviewEvents = this; }
    };
  });
  await openReview(page, review, writeFile(review, "reconnect-preservation.html", "<p id='copy'>Connection fixture</p><input aria-label='Native input'><script>window.bootIdentity = Math.random()</script>"));
  const frame = await waitForSdk(page);
  await frame.getByRole("textbox").fill("Keep exact authored input");
  const boot = await frame.locator("body").evaluate(() => window.bootIdentity);
  await feedback(page);
  await page.getByRole("button", { name: "New message", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "New message", exact: true });
  await draft.fill("Keep my unsent comment");
  await draft.evaluate(node => { window.reconnectDraft = node; node.setSelectionRange(2, 8); node.dispatchEvent(new Event("select", { bubbles: true })); });
  await context.setOffline(true);
  try {
    // Chromium's offline emulation leaves an already-open SSE socket alive.
    await page.evaluate(() => window.reviewEvents.dispatchEvent(new Event("error")));
    await expect(page.getByText("Connection lost. Showing previously loaded information.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toHaveCount(1);
    await expect(page.getByText(/Couldn't check what's ready to send/)).toHaveCount(0);
  } finally { await context.setOffline(false); }
  if (await page.getByRole("button", { name: "Reconnect", exact: true }).isVisible()) await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByText("Connection lost. Showing previously loaded information.", { exact: true })).toHaveCount(0);
  expect(await frame.locator("body").evaluate(() => window.bootIdentity)).toBe(boot);
  await expect(frame.getByRole("textbox")).toHaveValue("Keep exact authored input");
  expect(await draft.evaluate(node => [node === window.reconnectDraft, node.value, node.selectionStart, node.selectionEnd]))
    .toEqual([true, "Keep my unsent comment", 2, 8]);
});
