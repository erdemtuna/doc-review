import { test, expect, openReview, waitForSdk, writeFile, enterEditMode, message, handled, expectEditBlocked, submissionHistory } from "./helpers.js";

test("confirmed source updates survive paused shell painting without requiring reload", async ({ page, review }) => {
  test.setTimeout(30_000);
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const requestPaint = window.requestAnimationFrame.bind(window);
    const cancelPaint = window.cancelAnimationFrame.bind(window);
    const held = new Map();
    let sequence = 0;
    window.paintProbe = {
      paused: false,
      confirmations: [],
      resume() {
        this.paused = false;
        for (const callback of held.values()) requestPaint(callback);
        held.clear();
      },
    };
    window.requestAnimationFrame = (callback) => {
      if (!window.paintProbe.paused) return requestPaint(callback);
      const id = --sequence;
      held.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      if (id < 0) held.delete(id);
      else cancelPaint(id);
    };
    window.addEventListener("message", (event) => {
      if (event.source === document.querySelector("#frame")?.contentWindow &&
        event.data?.type === "eh:configurationApplied") {
        window.paintProbe.confirmations.push(event.data.generation);
      }
    });
  });
  const source = (version) => `<!doctype html><h1>Agent revision ${version}</h1><p>Review this text.</p>`;
  const file = writeFile(review, "paused-paint.html", source(0));
  await openReview(page, review, file);
  await expect.poll(() => page.evaluate(() => window.paintProbe.confirmations.length)).toBe(1);
  for (const version of [1, 2]) {
    await page.evaluate(() => { window.paintProbe.paused = true; });
    writeFile(review, "paused-paint.html", source(version));
    await expect.poll(() => page.evaluate(() => window.paintProbe.confirmations.length)).toBe(version + 1);
    const frame = page.frameLocator("#frame");
    await expect(frame.locator("h1")).toHaveText(`Agent revision ${version}`);
    await expect(page.locator("#previousFrame")).toHaveCount(1);
    // The real five-second deadline must elapse while protocol messages still flow.
    await page.waitForTimeout(5500);
    await expect(page.getByRole("button", { name: "Reload source (discard local page edits)", exact: true })).toBeHidden();
    await expect(page.locator("#frame")).toHaveAttribute("data-sdk-ready", "true");
    await expect(page.locator("#previousFrame")).toHaveCount(1);
    await page.evaluate(() => window.paintProbe.resume());
    await expect(page.locator("#previousFrame")).toHaveCount(0);
    await expect(page.locator("#frame")).not.toHaveAttribute("data-replacing");
  }
  const frame = await enterEditMode(page);
  await expect(frame.locator("h1")).toHaveText("Agent revision 2");
  await expect(page.getByRole("button", { name: "Reload source (discard local page edits)", exact: true })).toBeHidden();
});

test("an unconfirmed source update still offers recovery and can retry", async ({ page, review }) => {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    window.blockConfigurationAck = false;
    window.addEventListener("message", (event) => {
      if (window.blockConfigurationAck && event.data?.type === "eh:configurationApplied") {
        event.stopImmediatePropagation();
      }
    });
  });
  const file = writeFile(review, "missing-confirmation.html", "<h1>Original document</h1>");
  await openReview(page, review, file);
  await enterEditMode(page);
  await page.evaluate(() => { window.blockConfigurationAck = true; });
  writeFile(review, "missing-confirmation.html", "<h1>Updated document</h1>");
  await expect(page.frameLocator("#frame").locator("h1")).toHaveText("Updated document");
  await expect(page.locator(".conversation-global-status")).toContainText("did not confirm", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Reload source (discard local page edits)", exact: true })).toBeVisible();
  await expect(page.locator("#frame")).not.toHaveAttribute("data-sdk-ready");
  await page.evaluate(() => { window.blockConfigurationAck = false; });
  await page.getByRole("button", { name: "Reload source (discard local page edits)", exact: true }).click();
  await waitForSdk(page);
  await expect(page.locator("#previousFrame")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reload source (discard local page edits)", exact: true })).toBeHidden();
  await expect(page.frameLocator("#frame").locator("body")).toHaveAttribute("contenteditable", "true");
});

test("Review and Changes keep the same iframe and authored runtime state", async ({ page, review }) => {
  const file = writeFile(review, "controller-state.html", `<!doctype html>
    <html><body><h1>Review lifecycle</h1>
    <label>Draft <input aria-label="Draft" value="initial"></label>
    <button id="increment">Increment</button><output id="counter">0</output>
    <script>
      window.boots = (window.boots || 0) + 1;
      let count = 0;
      document.getElementById("increment").onclick = () => {
        document.getElementById("counter").textContent = String(++count);
      };
    </script></body></html>`);
  const ref = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await message(page, "Explain without changing source");
  await page.locator("#send").click();
  await expect(page.getByText("Queued; not received", { exact: true })).toBeVisible();
  await handled(review, ref);
  await expect(page.getByRole("region", { name: "Latest submission result" })).toBeVisible();
  await submissionHistory(page);
  await page.locator(".conversation-submission").first().locator(":scope > summary").click();
  await expect(page.getByRole("button", { name: "Source changes", exact: true })).toBeVisible();
  await page.locator("#commentsButton").click();
  await frame.getByRole("button", { name: "Increment" }).click();
  await frame.getByLabel("Draft").fill("Keep this input");
  await page.locator("#frame").evaluate((element) => { window.reviewFrameBeforeSwitch = element; });
  await page.locator("#commentsButton").click();
  for (let round = 0; round < 3; round++) {
    await page.getByRole("button", { name: "Source changes", exact: true }).click();
    await expect(page.getByRole("region", { name: "Saved comparison", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close comparison", exact: true }).click();
    await expect(page.getByRole("region", { name: "Saved comparison", exact: true })).toBeHidden();
  }
  expect(await page.locator("#frame").evaluate((element) => element === window.reviewFrameBeforeSwitch)).toBe(true);
  await expect(frame.getByLabel("Draft")).toHaveValue("Keep this input");
  await expect(frame.locator("#counter")).toHaveText("1");
  expect(await frame.locator("body").evaluate(() => window.boots)).toBe(1);
});

test("ending review keeps a read-only observer without replacing the authored document", async ({ page, review }) => {
  const file = writeFile(review, "controller-end.html", "<h1>End this review</h1><p>Content stays here.</p>");
  await openReview(page, review, file);
  await waitForSdk(page);
  await page.locator("#frame").evaluate((element) => { window.reviewFrameBeforeEnd = element; });
  await page.locator("#commentsButton").click();
  await page.locator("#endReview").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.locator(".conversation-lifecycle")).toHaveText("Review ended");
  expect(await page.locator("#frame").evaluate((element) => element === window.reviewFrameBeforeEnd)).toBe(true);
  await expectEditBlocked(page, true);
  await page.locator("#theme").click();
  await expect(page.getByRole("region", { name: "Saved comparison", exact: true })).toBeHidden();
  await expect(page.locator(".conversation-lifecycle")).toHaveCount(1);
});
