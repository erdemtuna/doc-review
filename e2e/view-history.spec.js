import http from "node:http";
import { test, expect, openReview, waitForSdk, feedback, conversation, handled, listed } from "./helpers.js";

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
    await feedback(page);
    await page.getByRole("textbox", { name: "Overall note" }).fill("Improve the Screens section");
    await page.locator('[data-composer="note"]').getByLabel("Request a change").check();
    await page.locator("#send").click();
    await expect(page.getByRole("textbox", { name: "Overall note" })).toHaveValue("");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const work = (await conversation(review, session, "poll")).submission;
    version = "After";
    await page.reload();
    await waitForSdk(page);
    await expect(frame.locator("#product-panel")).toHaveText("After product content");
    await handled(review, session, { overallOutcome: "applied" });
    await expect(frame.locator("#product-panel")).toHaveText("After product content");
    await waitForSdk(page);
    await feedback(page);
    await expect(page.getByText(/Response handled; comparison capture unavailable/)).toContainText(/Screens|view/i);
    let comparison = (await listed(review, session, "comparisons", { submissionId: work.submissionId })).items[0];
    expect(comparison.resultRevisionId).toBeNull();
    await expect(frame.locator("#product")).toHaveAttribute("aria-selected", "true");
    const renderPath = await page.locator("#frame").getAttribute("src");
    if (await page.locator("#commentsButton").getAttribute("aria-expanded") === "true") await page.locator("#commentsButton").click();
    await frame.locator("#screens").click();
    await expect.poll(async () => {
      comparison = (await listed(review, session, "comparisons", { submissionId: work.submissionId })).items[0];
      return comparison.resultRevisionId;
    }, { timeout: 15000 }).toBeTruthy();
    expect(await page.locator("#frame").getAttribute("src")).toBe(renderPath);
    const after = review.store.revisions.readSemantic(comparison.resultRevisionId);
    expect(after.blocks.map((block) => block.text).join(" ")).toContain("After screens content");
    expect(after.blocks.map((block) => block.text).join(" ")).not.toContain("After product content");
    await feedback(page);
    await page.locator(".conversation-submission").first().locator(":scope > summary").click();
    await page.getByRole("button", { name: "Content changes" }).click();
    await page.getByText("Comparison details", { exact: true }).click();
    await expect(page.getByRole("region", { name: "Saved comparison" })).toContainText("Matching visible view: Screens");
  } finally {
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
