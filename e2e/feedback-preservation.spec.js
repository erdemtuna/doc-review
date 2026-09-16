import fs from "node:fs";
import { test, expect, enterEditMode, openReview, reviewApi, waitForSdk, writeFile } from "./helpers.js";

test("external Markdown changes refresh the page but retain unsent browser edits", async ({ page, review }) => {
  const file = writeFile(review, "external-feedback.md", "# Draft\n\nOriginal paragraph.");
  const session = await openReview(page, review, file);
  const frame = await enterEditMode(page);
  const edited = "Unsent browser wording.";
  await frame.locator("p").evaluate((element, text) => {
    element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
    element.textContent = text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  }, edited);
  await expect(frame.locator("p")).toHaveText(edited);
  await page.locator("#modeButton").click();
  await page.getByRole("menuitemradio", { name: /^View/ }).click();
  await expect(page.locator("#modeLabel")).toHaveText("View");
  await expect.poll(async () => {
    const response = await reviewApi(review, `/api/page/${session.key}`);
    return response.json().edits[0]?.after;
  }).toBe(edited);

  fs.writeFileSync(file, "# External revision\n\nA source editor changed this.");
  await expect(frame.locator("h1")).toHaveText("External revision");
  await waitForSdk(page);
  const refreshed = await reviewApi(review, `/api/page/${session.key}`);
  expect(refreshed.json().edits[0].after).toBe(edited);
  const sent = await reviewApi(review, `/api/page/${session.key}/send`, {
    method: "POST", body: { sessionId: session.sessionId, note: "" },
  });
  expect(sent.status).toBe(200);
  const delivered = await reviewApi(review, `/api/poll?target=${encodeURIComponent(file)}`);
  expect(delivered.json().pages[0].edits[0].after).toBe(edited);
  expect(fs.readFileSync(file, "utf8")).toContain("A source editor changed this.");
});
