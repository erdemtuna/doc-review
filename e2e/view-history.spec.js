import http from "node:http";
import { test, expect, openReview, reviewApi, waitForSdk } from "./helpers.js";

test("returning to the captured live tab retries without reloading or auto-clicking tabs", async ({ page, review }) => {
  let version = "Before";
  const upstream = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><html><body>
      <nav role="tablist" id="sections">
        <button role="tab" id="product" aria-controls="product-panel" aria-selected="true">Product</button>
        <button role="tab" id="screens" aria-controls="screens-panel" aria-selected="false">Screens</button>
      </nav>
      <section role="tabpanel" id="product-panel"><p>${version} product content</p></section>
      <section role="tabpanel" id="screens-panel" hidden><p>${version} screens content</p></section>
      <script>
        for (const tab of document.querySelectorAll('[role="tab"]')) tab.addEventListener('click', () => {
          for (const candidate of document.querySelectorAll('[role="tab"]')) {
            const selected = candidate === tab;
            candidate.setAttribute('aria-selected', String(selected));
            document.getElementById(candidate.getAttribute('aria-controls')).hidden = !selected;
          }
        });
      </script>
    </body></html>`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const target = `http://127.0.0.1:${upstream.address().port}/tabs`;
    const session = await openReview(page, review, target);
    const frame = await waitForSdk(page);
    await frame.locator("#screens").click();
    await expect(frame.locator("#screens-panel")).toBeVisible();
    await page.locator("#commentsButton").click();
    await page.locator("#note").fill("Improve the Screens section");
    await page.locator("#send").click();
    await expect(page.locator("#note")).toHaveValue("");
    await page.locator("#drawerClose").click();
    const batch = (await reviewApi(review, `/api/poll?target=${encodeURIComponent(target)}`)).json();
    version = "After";
    const acknowledged = await fetch(
      `http://127.0.0.1:${review.port}/api/poll?target=${encodeURIComponent(target)}&ack=${encodeURIComponent(batch.batch_id)}`,
      { headers: { "x-doc-review-token": review.token } }
    );
    await acknowledged.body.cancel();
    await expect(frame.locator("#product-panel")).toHaveText("After product content");
    await waitForSdk(page);
    let round;
    await expect.poll(async () => {
      round = (await reviewApi(review, `/api/session/${session.sessionId}/history`)).json().rounds[0];
      return round?.targets[0]?.capture?.error || "";
    }, { timeout: 15000 }).toContain("Return to Screens");
    expect(round.targets[0].resultRevisionId).toBeNull();
    await expect(frame.locator("#product")).toHaveAttribute("aria-selected", "true");
    const renderPath = await page.locator("#frame").getAttribute("src");
    await frame.locator("#screens").click();
    await expect.poll(async () => {
      round = (await reviewApi(review, `/api/session/${session.sessionId}/history`)).json().rounds[0];
      return round?.targets[0]?.resultRevisionId;
    }, { timeout: 15000 }).toBeTruthy();
    expect(await page.locator("#frame").getAttribute("src")).toBe(renderPath);
    const after = review.store.revisions.readSemantic(round.targets[0].resultRevisionId);
    expect(after.blocks.map((block) => block.text).join(" ")).toContain("After screens content");
    expect(after.blocks.map((block) => block.text).join(" ")).not.toContain("After product content");
    await page.locator("#seeChanges").click();
    await expect(page.locator("#historyPanel")).toContainText("Matching visible view: Screens");
  } finally {
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
