import { test, expect, openReview, waitForSdk, writeFile, enterEditMode } from "./helpers.js";

const source = `<!doctype html><html><head><title>Theme recovery</title></head>
  <body><p id="target">Keep this document and its unsent editing state.</p>
  <label>Page draft <input id="draft" value="Original draft"></label></body></html>`;

async function interceptThemeAcknowledgments(page, initiallyBlocked) {
  await page.addInitScript(({ initiallyBlocked }) => {
    if (window === window.top) {
      window.themeRecovery = { blocked: initiallyBlocked, acknowledgments: [], readyMessages: 0 };
      window.addEventListener("message", (event) => {
        if (event.source !== document.querySelector("#frame")?.contentWindow) return;
        if (event.data?.type === "eh:ready") window.themeRecovery.readyMessages++;
        if (event.data?.type !== "eh:themeApplied") return;
        window.themeRecovery.acknowledgments.push({ ...event.data });
        // Drop only actual SDK theme acknowledgments; ready and policy confirmation remain untouched.
        if (window.themeRecovery.blocked) event.stopImmediatePropagation();
      }, true);
    } else {
      window.themeRecoveryCommands = [];
      window.addEventListener("message", (event) => {
        if (event.source === parent && ["eh:setTheme", "eh:configureReview"].includes(event.data?.type)) {
          window.themeRecoveryCommands.push({ ...event.data });
        }
      });
    }
  }, { initiallyBlocked });
  const requests = { registrations: 0, confirmations: 0 };
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const pathname = new URL(request.url()).pathname;
    if (/\/api\/session\/[^/]+\/render$/.test(pathname)) requests.registrations++;
    if (/\/api\/session\/[^/]+\/render\/[^/]+\/ready$/.test(pathname)) requests.confirmations++;
  });
  return requests;
}

async function rememberFrame(page) {
  return page.locator("#frame").evaluate((frame) => {
    window.themeRecoveryFrame = frame;
    return frame.src;
  });
}

async function expectSameFrame(page, src) {
  expect(await page.locator("#frame").evaluate((frame) => frame === window.themeRecoveryFrame)).toBe(true);
  await expect(page.locator("#frame")).toHaveAttribute("src", src);
  await expect(page.locator("#previousFrame")).toHaveCount(0);
}

test("initial theme timeout offers Retry theme without repeating registration or replacing the iframe", async ({ page, review }) => {
  const requests = await interceptThemeAcknowledgments(page, true);
  await openReview(page, review, writeFile(review, "initial-theme-recovery.html", source));
  const src = await rememberFrame(page);
  const frame = page.frameLocator("#frame");
  await expect.poll(() => page.evaluate(() => window.themeRecovery.acknowledgments.length)).toBe(1);
  expect(await page.evaluate(() => window.themeRecovery.readyMessages)).toBe(1);
  await expect(page.locator("#frame")).not.toHaveAttribute("data-sdk-ready", "true");
  expect(requests).toEqual({ registrations: 1, confirmations: 1 });
  expect(await frame.locator("body").evaluate(() =>
    window.themeRecoveryCommands.filter((message) => message.type === "eh:configureReview").length)).toBe(0);
  await expect(page.locator("#themeNotice")).toBeVisible({ timeout: 6000 });
  await expect(page.locator("#themeNotice [role=alert]")).toContainText("synchronization was not confirmed");
  await expect(page.getByRole("button", { name: "Retry theme", exact: true })).toBeEnabled();
  await expect(page.locator("#reloadNotice")).toBeHidden();
  await expectSameFrame(page, src);
  // A late acknowledgment was not mistaken for success and there was no automatic retry.
  expect(await page.evaluate(() => window.themeRecovery.acknowledgments.length)).toBe(1);
  await page.evaluate(() => { window.themeRecovery.blocked = false; });
  await page.getByRole("button", { name: "Retry theme", exact: true }).click();
  await waitForSdk(page);
  await expect(page.locator("#themeNotice")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.themeRecovery.acknowledgments.length)).toBe(2);
  const acknowledgments = await page.evaluate(() => window.themeRecovery.acknowledgments);
  expect(acknowledgments[1]).toEqual(acknowledgments[0]);
  await expectSameFrame(page, src);
  expect(requests).toEqual({ registrations: 1, confirmations: 1 });
  expect(await page.evaluate(() => window.themeRecovery.readyMessages)).toBe(1);
});

test("live theme timeout preserves drafts and retries the latest theme without reload or mode configuration", async ({ page, review }) => {
  const requests = await interceptThemeAcknowledgments(page, false);
  await openReview(page, review, writeFile(review, "live-theme-recovery.html", source));
  const frame = await waitForSdk(page);
  await enterEditMode(page);
  await frame.locator("#draft").fill("Unsent authored draft");
  await frame.locator("#target").click();
  await frame.locator("#target").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.keyboard.press("Control+k");
  await expect(frame.locator("#linkInput")).toBeFocused();
  await frame.locator("#linkInput").fill("https://unsent.example/recovery");
  const configurationCount = await frame.locator("body").evaluate(() => {
    const host = document.querySelector("[data-eh-ui]");
    const input = host.shadowRoot.querySelector("#linkInput");
    input.setSelectionRange(8, 14);
    window.themeRecoveryNodes = { body: document.body, host, input };
    return window.themeRecoveryCommands.filter((message) => message.type === "eh:configureReview").length;
  });
  expect(configurationCount).toBeGreaterThan(0);
  const src = await rememberFrame(page);
  await expect(frame.locator("#linkInput")).toBeFocused();
  const initialRequests = { ...requests };
  const initialAckCount = await page.evaluate(() => window.themeRecovery.acknowledgments.length);
  await page.evaluate(() => { window.themeRecovery.blocked = true; });
  for (const theme of ["dark", "light", "dark"]) {
    await page.locator("#theme").evaluate((button) => button.click());
    await expect(frame.locator("[data-eh-ui]")).toHaveAttribute("data-review-theme", theme);
    await expect(frame.locator("#linkInput")).toBeFocused();
  }
  await expect.poll(() => page.evaluate(() => window.themeRecovery.acknowledgments.length)).toBe(initialAckCount + 3);
  await expect(page.locator("#themeNotice")).toBeVisible({ timeout: 6000 });
  await expect(page.locator("#frame")).toHaveAttribute("data-sdk-ready", "true");
  await expect(frame.locator("#linkInput")).toBeVisible();
  await expect(frame.locator("#linkInput")).toBeFocused();
  await expectSameFrame(page, src);
  const preservedState = () => frame.locator("body").evaluate(() => ({
    sameNodes: window.themeRecoveryNodes.body === document.body &&
      window.themeRecoveryNodes.host === document.querySelector("[data-eh-ui]") &&
      window.themeRecoveryNodes.input === window.themeRecoveryNodes.host.shadowRoot.querySelector("#linkInput"),
    draft: document.querySelector("#draft").value,
    link: window.themeRecoveryNodes.input.value,
    caret: [window.themeRecoveryNodes.input.selectionStart, window.themeRecoveryNodes.input.selectionEnd],
    mode: document.body.getAttribute("contenteditable"),
    configurations: window.themeRecoveryCommands.filter((message) => message.type === "eh:configureReview").length,
  }));
  const expectedState = {
    sameNodes: true, draft: "Unsent authored draft", link: "https://unsent.example/recovery",
    caret: [8, 14], mode: "true", configurations: configurationCount,
  };
  expect(await preservedState()).toEqual(expectedState);
  expect(requests).toEqual(initialRequests);
  await page.evaluate(() => { window.themeRecovery.blocked = false; });
  // Activate without moving focus out of the SDK editor.
  await page.getByRole("button", { name: "Retry theme", exact: true }).evaluate((button) => button.click());
  await expect(page.locator("#themeNotice")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.themeRecovery.acknowledgments.length)).toBe(initialAckCount + 4);
  const acknowledgments = await page.evaluate(() => window.themeRecovery.acknowledgments);
  expect(acknowledgments.at(-1)).toEqual(acknowledgments.at(-2));
  expect(acknowledgments.at(-1).theme).toBe("dark");
  expect(acknowledgments.slice(initialAckCount, -1).map((message) => message.themeRevision))
    .toEqual([acknowledgments[0].themeRevision + 1, acknowledgments[0].themeRevision + 2, acknowledgments[0].themeRevision + 3]);
  expect(await preservedState()).toEqual(expectedState);
  await expectSameFrame(page, src);
  expect(requests).toEqual(initialRequests);
  await expect(frame.locator("#linkInput")).toBeVisible();
  await expect(frame.locator("#linkInput")).toBeFocused();
  await frame.getByRole("button", { name: "Apply link", exact: true }).click();
  await expect(frame.locator("#target a")).toHaveAttribute("href", "https://unsent.example/recovery");
  await expect(frame.locator("#target a")).toHaveText("Keep this document and its unsent editing state.");
});
