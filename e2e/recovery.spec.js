import { test, expect, openReview, waitForSdk, writeFile, selectText, selectReviewMode, expectEditBlocked } from "./helpers.js";

const source = `<!doctype html><html><head><style>
body{margin:24px;color:#263142;background:white;font:17px/1.6 system-ui}
input{max-width:100%;box-sizing:border-box;font:inherit}
</style></head><body><h1>Recovery review</h1>
<p id="copy">Keep this source-directed conversation draft while the page reloads.</p>
<label>Page input <input aria-label="Page input" value="Keep this page input"></label>
<script>document.body.dataset.executed="yes";</script></body></html>`;
const reload = (page) => page.getByRole("button", { name: "Reload source (discard local page edits)", exact: true });
async function exposeRecovery(page, review, name) {
  await page.route("**/api/session/*/render/*/ready", (route) => route.fulfill({ status: 503, json: { error: "Ready unavailable" } }));
  writeFile(review, name, `${source}\n<!-- source update -->`);
  await expect(reload(page)).toBeEnabled();
  await page.unroute("**/api/session/*/render/*/ready");
}
async function captureWidths(page, info, name) {
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const status = await page.locator(".conversation-global-status").count()
        ? await page.locator(".conversation-global-status").boundingBox()
        : await page.locator(".conversation-lifecycle").boundingBox();
      expect(status.x).toBeGreaterThanOrEqual(0);
      expect(status.x + status.width).toBeLessThanOrEqual(width);
      expect((await page.locator("#frame").boundingBox()).height).toBeGreaterThan(250);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${name}-${theme}-${width}.png`), animations: "disabled" });
    }
  }
}

test("contextual source recovery preserves the single conversation draft and served policy", async ({ page, review }, info) => {
  await openReview(page, review, writeFile(review, "held-notice.html", source));
  const frame = await waitForSdk(page);
  await selectText(frame, "#copy"); await frame.locator("#commentAction").click();
  const draft = page.getByRole("textbox", { name: "New message", exact: true });
  await draft.fill("Keep this source-directed draft");
  await draft.evaluate((element) => { window.originalDraft = element; element.setSelectionRange(2, 8); element.dispatchEvent(new Event("select", { bubbles: true })); });
  const before = await page.locator("#frame").getAttribute("src");
  await exposeRecovery(page, review, "held-notice.html");
  await reload(page).click();
  await expect(page.locator("#frame")).not.toHaveAttribute("src", before);
  await waitForSdk(page);
  await expect(frame.locator("body")).toHaveAttribute("data-executed", "yes");
  await expect(page.locator("#frame")).toHaveAttribute("data-save-policy", "feedback-only");
  await expect(draft).toHaveValue("Keep this source-directed draft");
  expect(await draft.evaluate((element) => ({ same: element === window.originalDraft, caret: [element.selectionStart, element.selectionEnd] })))
    .toEqual({ same: true, caret: [2, 8] });
  await captureWidths(page, info, "recovery-draft");
});

test("loading and failed recovery leave the document area visible and allow retry", async ({ page, review }, info) => {
  await openReview(page, review, writeFile(review, "failed-notice.html", source)); await waitForSdk(page);
  await exposeRecovery(page, review, "failed-notice.html");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/session/*/render/*/ready", async (route) => {
    await gate; await route.fulfill({ status: 503, json: { error: "Ready unavailable" } });
  });
  try {
    await reload(page).click();
    await expect(page.locator("#previousFrame")).toBeVisible();
    await expect(page.locator("#previousFrame")).toHaveAttribute("inert", "");
    await expectEditBlocked(page, true);
    await page.screenshot({ path: info.outputPath("recovery-loading.png") });
  } finally { release(); }
  await expect(reload(page)).toBeEnabled();
  await expect(page.locator(".conversation-global-status")).toContainText("could not confirm");
  await captureWidths(page, info, "recovery-failed");
  await page.unroute("**/api/session/*/render/*/ready");
  await reload(page).click(); await waitForSdk(page);
  await expect(reload(page)).toHaveCount(0);
});

test("recovery errors are explicit and status explanations never trap iframe focus", async ({ page, review }) => {
  await openReview(page, review, writeFile(review, "request-error.html", source));
  const frame = await waitForSdk(page);
  await page.locator(".conversation-lifecycle").focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await frame.getByLabel("Page input").click();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  expect(await frame.getByLabel("Page input").evaluate((element) => document.activeElement === element)).toBe(true);
  await selectReviewMode(page, "View");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await exposeRecovery(page, review, "request-error.html");
  await page.route("**/api/page/*", (route) => route.fulfill({ status: 503, json: { error: "Try again later" } }));
  await reload(page).click();
  await expect(page.getByRole("alert")).toContainText("Try again later");
  await page.unroute("**/api/page/*");
  await reload(page).click(); await waitForSdk(page);
  await expect(frame.locator("body")).toHaveAttribute("data-executed", "yes");
});

test("contextual recovery remains operable in Changes without the removed More menu", async ({ page, review }) => {
  await openReview(page, review, writeFile(review, "recovery-reopen.html", source)); await waitForSdk(page);
  await exposeRecovery(page, review, "recovery-reopen.html");
  await page.locator("#seeChanges").click();
  await expect(page.getByRole("button", { name: "More", exact: true })).toHaveCount(0);
  await expect(page.locator(".conversation-lifecycle")).toBeVisible();
  await reload(page).focus(); await page.keyboard.press("Enter");
  await waitForSdk(page);
  await expect(reload(page)).toHaveCount(0);
  await expect(page.locator("#seeChanges")).toHaveAttribute("aria-pressed", "true");
});
