import fs from "node:fs";
import { createServer } from "node:http";
import { test, expect, openReview, waitForSdk, writeFile, seedThread, mutate, feedback, expectFeedbackBounds,
  setReviewTheme, renderedContrast, sendPending, handled, intercept, failure } from "./helpers.js";
import { threadAction } from "./conversation-actions.js";
import { selectChoice } from "./choice-helpers.js";

const source = '<!doctype html><body style="margin:24px"><p id="copy">An exact passage for review.</p><input aria-label="Authored input"></body>';
const panel = page => page.getByRole("complementary", { name: "Feedback" });
const nativeTest = test.extend({
  nativeMode: ["classic", { option: true }],
  page: async ({ playwright, nativeMode }, use) => {
    const browser = await playwright.chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"],
      args: [`--${nativeMode === "overlay" ? "enable" : "disable"}-features=OverlayScrollbar,FluentOverlayScrollbar`] });
    try { await use(await browser.newPage()); } finally { await browser.close(); }
  },
});
async function settled(locator) {
  await expect.poll(() => locator.evaluate(node => {
    getComputedStyle(node).color;
    return node.getAnimations({ subtree: true }).some(animation => animation.playState === "running");
  })).toBe(false);
}
async function geometry(page, card, mode, focused = false) {
  let sample;
  await expect(async () => {
    sample = await card.evaluate((node, focused) => {
      const panel = node.closest(".conversation-panel"), box = panel.getBoundingClientRect(), style = getComputedStyle(panel);
      const left = box.left + parseFloat(style.borderLeftWidth), right = box.right - parseFloat(style.borderRightWidth);
      const header = node.querySelector(":scope > header").getBoundingClientRect(), card = node.getBoundingClientRect();
      const inventory = panel.querySelector(".conversation-inventory"), transcript = node.querySelector(".conversation-transcript");
      const owner = focused ? transcript : inventory;
      const meta = node.querySelector(".conversation-meta").getBoundingClientRect();
      const rails = [
        ".conversation-panel-header .segmented-control", ".conversation-filter-buttons",
        ".conversation-inventory > .conversation-section-toggle", ".conversation-thread:not([hidden])",
        ".conversation-footer-controls > button", ".feedback-actions > button",
      ].map(selector => panel.querySelector(selector)).filter(n => n?.getClientRects().length).map(n => n.getBoundingClientRect().left - left);
      return { rails, cardInsets: [card.left - left, right - card.right], headerInsets: [header.left - left, right - header.right],
        metadataOffset: meta.width ? meta.left - header.left : null, gutter: (owner.offsetWidth - owner.clientWidth) / 2,
        overflow: owner.scrollHeight > owner.clientHeight, native: getComputedStyle(owner).scrollbarWidth,
        panelOverflow: panel.scrollWidth > panel.clientWidth, inventoryGutter: inventory.offsetWidth - inventory.clientWidth };
    }, focused);
    expect(sample.native).toBe("auto");
    if (mode === "overlay") expect(sample.gutter).toBe(0);
    else expect(sample.gutter, "measured classic native gutter").toBeGreaterThan(0);
    expect(sample.panelOverflow).toBe(false);
    expect(Math.abs(sample.cardInsets[0] - sample.cardInsets[1])).toBeLessThanOrEqual(1);
    expect(Math.abs(sample.headerInsets[0] - sample.headerInsets[1])).toBeLessThanOrEqual(1);
    if (sample.metadataOffset !== null) expect(Math.abs(sample.metadataOffset)).toBeLessThanOrEqual(1);
    if (focused) {
      expect(sample.inventoryGutter).toBe(0);
      expect(sample.overflow, "long focused transcript owns usable overflow").toBe(true);
      await expect(card.getByRole("button", { name: "Reply", exact: true })).toBeInViewport({ ratio: 1 });
      await expect(card.getByRole("button", { name: "Resolve conversation", exact: true })).toBeInViewport({ ratio: 1 });
    }
    else {
      expect(sample.rails).toHaveLength(6);
      expect(Math.max(...sample.rails) - Math.min(...sample.rails)).toBeLessThanOrEqual(1);
    }
  }).toPass({ timeout: 5000 });
  return sample;
}

for (const mode of ["classic", "overlay"]) nativeTest.describe(`native ${mode} scrollbars`, () => {
  nativeTest.use({ nativeMode: mode });
  for (const theme of ["light", "dark"]) for (const [width, height] of [[1280, 800], [390, 480], [320, 400]]) {
    nativeTest(`balanced rails, current headers and retained metadata ${theme} ${width}x${height}`, async ({ page, review }, info) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(theme => localStorage.setItem("doc-review:theme", theme), theme);
      const ref = await openReview(page, review, writeFile(review, `${mode}-${theme}-${width}.html`, source));
      await waitForSdk(page);
      const { threadId } = await seedThread(review, ref, "First saved comment");
      await feedback(page); await expectFeedbackBounds(page, { width, height });
      const card = page.locator(`[data-thread="${threadId}"]`), samples = [];
      await expect(card.locator(".conversation-thread-actions button")).toHaveCount(3);
      await expect.poll(() => card.locator(".conversation-thread-actions button").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")))).toEqual([
        "Show in document", "Conversation actions", "Collapse conversation",
      ]);
      samples.push({ host: "feedback-short", ...await geometry(page, card, mode) });
      if (width === 1280) expect(samples.at(-1).overflow).toBe(false);
      await mutate(review, ref, "reply", { threadId, body: "Long readable response. ".repeat(90), intent: "request-change" });
      await expect(card.getByRole("button", { name: "Edit message", exact: true })).toHaveCount(2);
      for (const edit of await card.getByRole("button", { name: "Edit message", exact: true }).all()) {
        expect(await edit.evaluate(node => node.previousElementSibling?.tagName)).toBe("TIME");
        expect((await edit.boundingBox()).width).toBeGreaterThanOrEqual(24);
      }
      samples.push({ host: "feedback-long", ...await geometry(page, card, mode) });
      expect(samples.at(-1).overflow).toBe(true);
      await card.getByRole("button", { name: "Collapse conversation", exact: true }).click();
      await expect(card).toHaveAttribute("data-expanded", "false");
      samples.push({ host: "feedback-collapsed", ...await geometry(page, card, mode) });
      await card.getByRole("button", { name: "Expand conversation", exact: true }).click();
      await (await threadAction(page, card, "Focus")).click();
      samples.push({ host: "focus-long", ...await geometry(page, card, mode, true) });
      await expect(panel(page).getByRole("button", { name: "Back to Feedback", exact: true })).toBeInViewport({ ratio: 1 });
      await panel(page).getByRole("button", { name: "Back to Feedback", exact: true }).click();
      await (await threadAction(page, card, "Beside target")).click();
      await expect(panel(page)).toHaveAttribute("data-host", "adjacent");
      await expect(page.getByRole("button", { name: "Back to Feedback", exact: true })).toHaveCount(0);
      await expect.poll(() => card.locator(".conversation-thread-actions button").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")))).toEqual([
        "Open in Feedback", "Conversation actions", "Close conversation",
      ]);
      samples.push({ host: "adjacent-long", ...await geometry(page, card, mode, true) });
      const open = card.getByRole("button", { name: "Open in Feedback", exact: true });
      await open.focus();
      await expect(page.getByRole("tooltip")).toHaveText("Open in Feedback");
      await open.press("Escape");
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await expect(panel(page)).toBeVisible();
      await page.screenshot({ path: info.outputPath(`refined-${mode}-${theme}-${width}.png`), animations: "disabled" });
      await open.press("Enter");
      await expect(card.getByRole("button", { name: "Show in document" })).toBeFocused();
      await expect(panel(page)).toHaveAttribute("data-host", "feedback");
      samples.push({ host: "returned", ...await geometry(page, card, mode) });
      fs.writeFileSync(info.outputPath("rails.json"), JSON.stringify(samples, null, 2));
    });
  }
});

test("annotation entry, temporary reveal, popup Close and per-message editing preserve independent filters and the exact draft", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "refinement-navigation.html", source));
  const frame = await waitForSdk(page);
  const { threadId, messageId } = await seedThread(review, ref, "First saved message", {
    kind: "selection", anchor: { quote: "An exact passage for review." },
  });
  await mutate(review, ref, "reply", { threadId, body: "Second saved message", intent: "discuss" });
  await feedback(page);
  const card = page.locator(`[data-thread="${threadId}"]`);
  await card.locator(`[data-edit-message="${messageId}"]`).click();
  const editor = card.getByRole("textbox", { name: "Edit message", exact: true });
  await editor.fill("Keep this exact edited message");
  await editor.evaluate(node => { window.refinementEditor = node; node.setSelectionRange(3, 9); node.dispatchEvent(new Event("select", { bubbles: true })); });
  await page.getByRole("button", { name: "Open (1)", exact: true }).click();
  await expect(card).toBeHidden();
  const mark = frame.locator(`mark[data-eh-mark="${threadId}"]`);
  await mark.press("Enter");
  await expect(panel(page)).toHaveAttribute("data-host", "adjacent");
  await card.getByRole("button", { name: "Close conversation", exact: true }).click();
  await expect(panel(page)).toBeHidden();
  await mark.press("Enter");
  await expect(editor).toHaveValue("Keep this exact edited message");
  await card.getByRole("button", { name: "Open in Feedback", exact: true }).click();
  await expect(panel(page)).toHaveAttribute("data-host", "feedback");
  await expect(page.getByRole("button", { name: "Open (1)", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Resolved (0)", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText(/Showing this conversation outside your current filters/)).toBeVisible();
  expect(await editor.evaluate(node => [node === window.refinementEditor, node.selectionStart, node.selectionEnd])).toEqual([true, 3, 9]);
  await page.getByRole("banner").getByRole("button", { name: "Changes", exact: true }).click();
  await page.getByRole("banner").getByRole("button", { name: "Review", exact: true }).click();
  await expect(card).toBeHidden();
  await expect(page.getByText(/Showing this conversation outside your current filters/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open (1)", exact: true })).toHaveAttribute("aria-pressed", "false");
  await mark.press("Enter");
  await card.getByRole("button", { name: "Open in Feedback", exact: true }).click();
  expect(await editor.evaluate(node => [node === window.refinementEditor, node.selectionStart, node.selectionEnd])).toEqual([true, 3, 9]);
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(card).toBeHidden();
  await mark.press("Enter");
  await frame.locator("#copy").evaluate(node => node.remove());
  await expect(panel(page)).toHaveAttribute("data-host", "feedback");
  await expect(card).toBeVisible();
  await expect(editor).toHaveValue("Keep this exact edited message");
  await page.getByRole("button", { name: "Resolved (0)", exact: true }).click();
  await expect(card).toBeHidden();
  await expect(page.getByText(/Showing this conversation outside your current filters/)).toHaveCount(0);
});

for (const theme of ["light", "dark"]) test(`settled neutral expansion, readable counts and simultaneous informational status in ${theme}`, async ({ page, review }, info) => {
  test.setTimeout(60_000);
  await page.addInitScript(theme => localStorage.setItem("doc-review:theme", theme), theme);
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) { super(...args); window.refinementEvents = this; }
    };
  });
  const ref = await openReview(page, review, writeFile(review, `refinement-paint-${theme}.html`, source));
  await waitForSdk(page);
  const trigger = page.locator("#commentsButton"), count = page.locator("#toolbarCount");
  for (const desired of [0, 1, 11, 100]) {
    if (desired) {
      for (let i = Number(await count.textContent()); i < desired; i++) {
        await seedThread(review, ref, `Saved feedback ${i}`);
      }
    }
    await expect(count).toHaveText(desired > 99 ? "99+" : String(desired));
    for (const expanded of [true, false]) {
      await trigger.click(); await page.mouse.move(0, 0);
      await expect(trigger).toHaveAttribute("aria-expanded", String(expanded));
      await expect(count).toHaveText(desired > 99 ? "99+" : String(desired));
      await settled(trigger);
      await expect(count).toHaveCSS("color", await trigger.evaluate(n => getComputedStyle(n).color));
      expect(await renderedContrast(count)).toBeGreaterThanOrEqual(4.5);
      expect(await renderedContrast(trigger)).toBeGreaterThanOrEqual(4.5);
      expect(await count.evaluate(n => getComputedStyle(n).backgroundColor)).not.toBe(await trigger.evaluate(n => getComputedStyle(n).backgroundColor));
    }
  }
  await feedback(page);
  for (const disclosure of [
    page.getByRole("button", { name: "Comments (100)", exact: true }),
    page.getByRole("button", { name: "Note to agent", exact: true }),
  ]) {
    for (let toggle = 0; toggle < 2; toggle++) {
      await disclosure.click(); await settled(disclosure);
      await expect(disclosure).toHaveCSS("color", await trigger.evaluate(node => getComputedStyle(node).color));
      expect(await renderedContrast(disclosure)).toBeGreaterThanOrEqual(4.5);
      expect(await renderedContrast(disclosure.locator("svg").first())).toBeGreaterThanOrEqual(3);
    }
  }
  const card = page.locator(".conversation-thread").first();
  await card.getByRole("button", { name: "Edit message", exact: true }).click();
  await card.getByRole("checkbox", { name: "Request a change" }).check();
  await card.getByRole("button", { name: "Update comment", exact: true }).click();
  for (const label of ["Not sent", "Change requested"]) {
    const icon = card.getByRole("img", { name: label, exact: true });
    await icon.focus();
    await expect(page.getByRole("tooltip")).toContainText(label);
    await settled(icon);
    expect(await renderedContrast(icon)).toBeGreaterThanOrEqual(3);
    await expect(icon).not.toHaveAttribute("title");
    await expect(icon).not.toHaveAttribute("aria-pressed");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
  }
  await page.keyboard.press("Escape"); await expect(panel(page)).toBeHidden();
  await expect(trigger).toBeFocused();
  await intercept(page, "status", route => failure(route, "Count temporarily unavailable", "INVALID_INPUT"));
  await page.evaluate(() => { window.refinementEvents.close(); window.refinementEvents.dispatchEvent(new Event("error")); });
  await expect(count).toHaveText("…");
  await expect(trigger).toHaveAccessibleDescription("Count unavailable: saved pending feedback items");
  await trigger.click(); await settled(trigger);
  expect(await renderedContrast(count)).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: info.outputPath(`count-unavailable-${theme}.png`), animations: "disabled" });
});

test("Review options copies the current original document, reports failure, coordinates menus and retains explicit theme state after End", async ({ page, context, review }, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const file = writeFile(review, "A long original location with spaces and \u015fema.html", source);
  const ref = await openReview(page, review, file), frame = await waitForSdk(page);
  const second = writeFile(review, "Second original file.html", source);
  const joined = await mutate(review, ref, "join-page", { target: second });
  await expect(page.locator("#reviewPage")).toBeVisible();
  const options = page.getByRole("button", { name: "Review options", exact: true });
  await options.focus(); await expect(page.getByRole("tooltip")).toHaveText("Review options");
  await page.keyboard.press("Escape"); await options.press("Enter");
  const menu = page.getByRole("menu", { name: "Review options", exact: true });
  await expect(menu.getByLabel(file)).toBeVisible();
  await menu.getByRole("menuitem", { name: "Copy full path" }).click();
  await expect(menu.getByRole("status")).toHaveText("Original file path copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(file);
  await page.keyboard.press("Escape"); await expect(options).toBeFocused();
  await selectChoice(page, "reviewPage", joined.value.pageKey);
  await waitForSdk(page);
  await options.click();
  await expect(menu.getByLabel(second)).toBeVisible();
  await page.evaluate(() => {
    window.realClipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async () => { throw new Error("Fixture clipboard permission denied"); };
  });
  await menu.getByRole("menuitem", { name: "Copy full path" }).click();
  await expect(menu.getByRole("alert")).toContainText("Fixture clipboard permission denied");
  await expect(menu.locator("code")).toHaveText(second);
  await expect(menu.getByText("Original file path copied.")).toHaveCount(0);
  await page.evaluate(() => { navigator.clipboard.writeText = window.realClipboardWrite; });
  await menu.getByRole("menuitem", { name: "Copy full path" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(second);
  await page.keyboard.press("Escape");
  await frame.getByLabel("Authored input").fill("Retained authored input");
  const original = await page.locator("#frame").getAttribute("src");
  await setReviewTheme(page, "dark"); await setReviewTheme(page, "dark");
  await expect(page.locator("#frame")).toHaveAttribute("src", original);
  await expect(frame.getByLabel("Authored input")).toHaveValue("Retained authored input");
  await options.click(); await page.locator("#modeButton").click();
  await expect(menu).toHaveCount(0); await expect(page.getByRole("menu")).toHaveCount(1);
  await options.click(); await expect(page.locator("#modeButton")).toHaveAttribute("aria-expanded", "false");
  await frame.getByLabel("Authored input").click(); await expect(menu).toHaveCount(0);
  await expect(frame.getByLabel("Authored input")).toBeFocused();
  for (let i = 0; i < 2; i++) { await options.click(); await options.click(); }
  await expect(menu).toHaveCount(0);
  await mutate(review, ref, "end", { confirmUnsentReadOnly: true });
  await expect(page.getByText("Review ended", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 400 });
  for (const theme of ["light", "dark"]) {
    await setReviewTheme(page, theme);
    await options.click(); await expect(menu.getByLabel(second)).toBeVisible();
    await menu.getByRole("menuitem", { name: "Copy full path" }).click();
    await expect(menu.getByRole("status")).toHaveText("Original file path copied.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(second);
    await settled(menu);
    for (const item of await menu.getByRole("menuitemradio").all()) {
      expect(await renderedContrast(item)).toBeGreaterThanOrEqual(4.5);
    }
    await expect(async () => {
      const box = await menu.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(320);
      expect(box.y + box.height).toBeLessThanOrEqual(400);
    }).toPass({ timeout: 5000 });
    await page.screenshot({ path: info.outputPath(`review-options-ended-${theme}-320.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
  }
});

test("Review options follows comparison identity and disables stale path copying while it loads", async ({ page, review }) => {
  const first = writeFile(review, "comparison-original-one.html", source);
  const ref = await openReview(page, review, first);
  await waitForSdk(page);
  const second = writeFile(review, "comparison-original-two.html", source);
  const joined = await mutate(review, ref, "join-page", { target: second });
  await seedThread(review, ref, "First page");
  await seedThread(review, { ...ref, key: joined.value.pageKey }, "Second page");
  await sendPending(review, ref, { body: "Update both reviewed documents", intent: "request-change" });
  await handled(review, ref, { overallOutcome: "applied" });
  let release;
  await page.route("**/api/conversation/comparison", async route => {
    if (route.request().postDataJSON().pageKey === joined.value.pageKey) await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: { available: true, mode: route.request().postDataJSON().mode, version: 2,
      rows: [], changes: [], counts: { added: 0, removed: 0, modified: 0 }, limitations: ["visible_only"],
      viewComparison: { status: "unverified", message: "Visible content only; matching view not verified." } } });
  });
  await page.locator("#seeChanges").click();
  await expect(page.locator("#historyTarget")).toHaveAttribute("data-value", ref.key);
  await selectChoice(page, "historyTarget", joined.value.pageKey);
  await page.getByRole("button", { name: "Review options", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Copy full path" })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("menuitemradio", { name: "Light", exact: true })).toBeEnabled();
  await expect.poll(() => typeof release).toBe("function"); release();
  await expect(page.getByLabel(second, { exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Copy full path" })).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await page.locator("#latestVersion").click();
  await page.getByRole("button", { name: "Review options", exact: true }).click();
  await expect(page.getByLabel(first, { exact: true })).toBeVisible();
});

test("URL reviews explain the absence of an original file without inventing a copy command", async ({ page, review }) => {
  const server = createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end(source); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/original-page`;
    await openReview(page, review, url);
    await waitForSdk(page);
    await page.getByRole("button", { name: "Review options", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Review options", exact: true });
    await expect(menu.getByLabel(url, { exact: true })).toBeVisible();
    await expect(menu.getByText("This URL review has no original local file path.")).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Copy/ })).toHaveCount(0);
    await menu.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
