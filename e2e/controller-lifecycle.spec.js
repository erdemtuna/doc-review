import { test, expect, openReview, waitForSdk, writeFile } from "./helpers.js";

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
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await frame.getByRole("button", { name: "Increment" }).click();
  await frame.getByLabel("Draft").fill("Keep this input");
  await page.locator("#frame").evaluate((element) => { window.reviewFrameBeforeSwitch = element; });
  for (let round = 0; round < 3; round++) {
    await page.locator("#seeChanges").click();
    await expect(page.locator("#historyPanel")).toBeVisible();
    await page.locator("#latestVersion").click();
    await expect(page.locator("#historyPanel")).toBeHidden();
  }
  expect(await page.locator("#frame").evaluate((element) => element === window.reviewFrameBeforeSwitch)).toBe(true);
  await expect(frame.getByLabel("Draft")).toHaveValue("Keep this input");
  await expect(frame.locator("#counter")).toHaveText("1");
  expect(await frame.locator("body").evaluate(() => window.boots)).toBe(1);
});

test("ending review disposes shell interaction without replacing the authored document", async ({ page, review }) => {
  const file = writeFile(review, "controller-end.html", "<h1>End this review</h1><p>Content stays here.</p>");
  await openReview(page, review, file);
  await waitForSdk(page);
  await page.locator("#frame").evaluate((element) => { window.reviewFrameBeforeEnd = element; });
  await page.locator("#commentsButton").click();
  await page.locator("#endReview").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "End review", exact: true }).click();
  await expect(page.locator(".ended")).toBeVisible();
  expect(await page.locator("#frame").evaluate((element) => element === window.reviewFrameBeforeEnd)).toBe(true);
  await page.locator("#seeChanges").evaluate((element) => element.click());
  await expect(page.locator("#historyPanel")).toBeHidden();
  await expect(page.locator(".ended")).toHaveCount(1);
});
