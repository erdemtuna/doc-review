import fs from "node:fs";
import { test, expect, enterEditMode, openReview, conversation, listed, sendPending, waitForSdk, writeFile, selectReviewMode } from "./helpers.js";

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
  await selectReviewMode(page, "View");
  await expect(page.locator("#modeLabel")).toHaveText("View");
  await expect.poll(async () => (await listed(review, session, "edits")).items[0]?.content.after).toBe(edited);
  expect((await listed(review, session, "threads")).totalCount).toBe(0);
  await page.locator("#commentsButton").click();
  await expect(page.getByText("Source pending", { exact: true })).toHaveCount(1);
  await expect(page.locator(".conversation-edit-details")).not.toHaveAttribute("open");
  await expect(page.locator(".conversation-edit-details details")).not.toHaveAttribute("open");

  fs.writeFileSync(file, "# External revision\n\nA source editor changed this.");
  await expect(frame.locator("h1")).toHaveText("External revision");
  await waitForSdk(page);
  await expect(page.getByText("Source pending", { exact: true })).toHaveCount(1);
  await expect(page.locator(".conversation-edit-details")).not.toHaveAttribute("open");
  await expect(page.locator(".conversation-edit-details details")).not.toHaveAttribute("open");
  expect((await listed(review, session, "edits")).items[0].content.after).toBe(edited);
  await sendPending(review, session);
  const delivered = await conversation(review, session, "poll");
  expect(delivered.submission.edits[0].content.after).toBe(edited);
  expect(fs.readFileSync(file, "utf8")).toContain("A source editor changed this.");
});
