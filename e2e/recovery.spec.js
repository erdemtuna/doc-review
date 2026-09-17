import { test, expect, openReview, waitForSdk, writeFile } from "./helpers.js";

const source = `<!doctype html><html><head><style>
  body{margin:24px;color:#263142;background:white;font:17px/1.6 system-ui}
  input{max-width:100%;box-sizing:border-box;font:inherit}
  </style></head><body><h1>Recovery review</h1>
  <p id="copy">Keep this source-directed comment draft while the page reloads.</p>
  <label>Page input <input aria-label="Page input" value="Keep this page input"></label>
  <script>document.body.dataset.executed="yes";</script></body></html>`;

async function recover(page) {
  await page.locator("#reviewDetails").click();
  await page.locator("#executionStatic").click();
}

async function captureWidths(page, testInfo, name) {
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const notice = await page.locator("#noticesRoot").boundingBox();
      const frame = await page.locator("#frame").boundingBox();
      expect(notice.x).toBeGreaterThanOrEqual(0);
      expect(notice.x + notice.width).toBeLessThanOrEqual(width);
      expect(frame.y).toBeGreaterThanOrEqual(notice.y + notice.height - 1);
      expect(frame.height).toBeGreaterThan(250);
      expect(await page.locator("#noticesRoot").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`g3-${name}-${theme}-${width}.png`), animations: "disabled" });
    }
  }
}

test("G3 held reload has priority, fits all widths and preserves draft and displayed policy", async ({ page, review }, testInfo) => {
  test.setTimeout(90_000);
  await openReview(page, review, writeFile(review, "held-notice.html", source));
  const frame = await waitForSdk(page);
  await frame.locator("#copy").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await frame.locator("#commentAction").click();
  await page.locator("#composeText").fill("Keep this comment draft");
  const before = await page.locator("#frame").getAttribute("src");
  await recover(page);
  await expect(page.locator("#reloadNotice")).toBeVisible();
  await expect(page.locator("#executionStatus")).toHaveCount(0);
  await expect(frame.locator("body")).toHaveAttribute("data-executed", "yes");
  await captureWidths(page, testInfo, "held");
  expect(await page.locator("#frame").getAttribute("src")).toBe(before);
  await page.locator("#reviewDetails").click();
  await expect(page.getByRole("menu")).toHaveAttribute("aria-labelledby", "reviewDetails");
  await page.screenshot({ path: testInfo.outputPath("g3-more-dark.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(page.locator("#reviewDetails")).toBeFocused();
  await expect(page.locator("#composeText")).toHaveValue("Keep this comment draft");
  await page.locator("#keepCurrent").click();
  await expect(page.locator("#reloadNotice")).toBeHidden();
  await expect(page.locator("#executionStatus")).toContainText("previous page");
  await page.locator("#seeChanges").click();
  await expect(page.locator("#executionStatus")).toBeHidden();
  await page.locator("#latestVersion").click();
  await expect(page.locator("#reloadNotice")).toBeVisible();
  await page.locator("#commentsButton").click();
  await page.locator("#safeReload").click();
  await waitForSdk(page);
  await expect(frame.locator("body")).not.toHaveAttribute("data-executed", "yes");
  await expect(page.locator("#composeText")).toHaveValue("Keep this comment draft");
  await expect(page.locator("#reloadNotice")).toBeHidden();
});

test("G3 loading and failed notices leave the document area visible and allow retry", async ({ page, review }, testInfo) => {
  test.setTimeout(90_000);
  await openReview(page, review, writeFile(review, "failed-notice.html", source));
  await waitForSdk(page);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/session/*/render/*/ready", async (route) => {
    await gate;
    await route.fulfill({ status: 503, json: { error: "Ready unavailable" } });
  });
  try {
    await recover(page);
    await expect(page.locator("#previousFrame")).toBeVisible();
    await expect(page.locator("#executionStatus")).toBeVisible();
    await captureWidths(page, testInfo, "loading");
  } finally { release(); }
  await expect(page.locator("#reloadNotice")).toBeVisible();
  await expect(page.locator("#reloadNotice [role=alert]")).toContainText("Review needs attention");
  await expect(page.locator("#safeReload")).toBeEnabled();
  await captureWidths(page, testInfo, "failed");
  await page.unroute("**/api/session/*/render/*/ready");
  await page.locator("#safeReload").click();
  await waitForSdk(page);
  await expect(page.locator("#reloadNotice")).toBeHidden();
  await expect(page.locator("#executionStatus")).toBeHidden();
});

test("G3 recovery errors are explicit and More never traps iframe focus", async ({ page, review }) => {
  await openReview(page, review, writeFile(review, "request-error.html", source));
  const frame = await waitForSdk(page);
  await page.locator("#reviewDetails").click();
  await frame.getByLabel("Page input").click();
  await expect(page.locator("#recoveryMenu")).toBeHidden();
  expect(await frame.getByLabel("Page input").evaluate((element) => document.activeElement === element)).toBe(true);
  await page.locator("#reviewDetails").click();
  await page.locator("#modeButton").click();
  await expect(page.locator("#recoveryMenu")).toBeHidden();
  await expect(page.locator("#modeMenu")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.route("**/api/session/*/execution", (route) => route.fulfill({ status: 503, json: { error: "Try again later" } }));
  await recover(page);
  await expect(page.locator("#executionStatus")).toHaveAttribute("role", "alert");
  await expect(page.locator("#executionStatus")).toContainText("Retry from More");
  await page.unroute("**/api/session/*/execution");
  await recover(page);
  await waitForSdk(page);
  await expect(page.locator("#executionStatus")).toBeHidden();
});

test("G3 More can reopen during its previous close animation", async ({ page, review }) => {
  await openReview(page, review, writeFile(review, "recovery-reopen.html", source));
  await waitForSdk(page);
  const trigger = page.locator("#reviewDetails");
  const menu = page.locator("#recoveryMenu");
  for (let attempt = 0; attempt < 8; attempt++) {
    await trigger.click();
    await page.keyboard.press("Escape");
    await trigger.click();
    await expect(menu).toBeVisible();
    await menu.evaluate(async (element) => {
      await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  }
});
