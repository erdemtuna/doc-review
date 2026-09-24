import { selectChoice } from "./choice-helpers.js";
import fs from "node:fs";
import { threadAction } from "./conversation-actions.js";
import { test, expect, enterEditMode, openReview, waitForSdk, writeFile, seedThread, mutate, listed, feedback, intercept, failure, conversation } from "./helpers.js";
import { content } from "../test/fixtures/review.js";

const source = '<!doctype html><html><body><p id="copy">Original paragraph for feedback.</p><label>Authored draft <input aria-label="Authored draft"></label></body></html>';
async function setup(page, review, name) {
  const file = writeFile(review, name, source), ref = await openReview(page, review, file);
  await waitForSdk(page); await seedThread(review, ref, "Clarify this paragraph"); await feedback(page);
  await expect(page.locator(".conversation-thread")).toHaveCount(1);
  return { ref, file };
}
const note = (page) => page.getByRole("textbox", { name: "Overall note", exact: true });
const close = (page) => page.locator(".conversation-panel-header").getByRole("button", { name: "Close", exact: true });

test("thread disclosure retains DOM and tab-lifetime choices across pages; reload expands and loses only local drafts", async ({ page, review }) => {
  const { ref } = await setup(page, review, "disclosure-first.html");
  const other = writeFile(review, "disclosure-second.html", source);
  const joined = await mutate(review, ref, "join-page", { target: other });
  const { threadId } = (await listed(review, ref, "threads")).items[0].thread;
  const thread = page.locator(`[data-thread="${threadId}"]`), toggle = thread.locator(".conversation-thread-title");
  await note(page).fill("Keep note identity and caret");
  await note(page).evaluate((element) => {
    window.originalNote = element; element.setSelectionRange(2, 8);
    element.dispatchEvent(new Event("select", { bubbles: true }));
  });
  await thread.evaluate((element) => { window.originalThread = element; });
  await toggle.focus(); await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(thread.locator(".conversation-thread-content")).toBeHidden();
  await close(page).click(); await page.locator("#theme").click(); await feedback(page);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await selectChoice(page, "reviewPage", joined.value.pageKey);
  await waitForSdk(page);
  await selectChoice(page, "reviewPage", ref.key);
  await waitForSdk(page);
  expect(await thread.evaluate((element) => element === window.originalThread)).toBe(true);
  expect(await note(page).evaluate((element) => ({
    same: element === window.originalNote, selection: [element.selectionStart, element.selectionEnd],
  }))).toEqual({ same: true, selection: [2, 8] });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.reload(); await waitForSdk(page); await feedback(page);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(note(page)).toHaveValue("");
});

test("collapse and host transfer preserve the one editable message through validation, Save and Cancel", async ({ page, review }) => {
  await setup(page, review, "disclosure-edit.html");
  const thread = page.locator(".conversation-thread"), toggle = thread.locator(".conversation-thread-title");
  await thread.getByRole("button", { name: "Edit message", exact: true }).click();
  const editor = thread.getByRole("textbox", { name: "Edit message", exact: true });
  await editor.fill("Retain this draft and caret");
  await editor.evaluate((element) => { window.originalEditor = element; element.setSelectionRange(3, 9); element.dispatchEvent(new Event("select", { bubbles: true })); });
  await toggle.click(); await expect(editor).toBeHidden();
  await page.locator("#theme").click(); await toggle.click();
  expect(await editor.evaluate((element) => ({ same: element === window.originalEditor, selection: [element.selectionStart, element.selectionEnd] })))
    .toEqual({ same: true, selection: [3, 9] });
  await editor.fill("   "); await expect(thread.getByRole("button", { name: "Save message", exact: true })).toBeDisabled();
  await editor.press("Escape"); await expect(editor).toHaveCount(0);
  await thread.getByRole("button", { name: "Edit message", exact: true }).click();
  await editor.fill("Saved revised feedback");
  await editor.evaluate((element) => { window.savedEditor = element; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await intercept(page, "update-message", async (route) => { await gate; await route.continue(); });
  try {
    await editor.press("Enter");
    await expect(thread.getByRole("button", { name: "Save message", exact: true })).toBeDisabled();
    await toggle.click(); await toggle.click();
    await expect(editor).toHaveValue("Saved revised feedback");
    await thread.getByRole("button", { name: "Focus", exact: true }).click();
    expect(await editor.evaluate((element) => element === window.savedEditor)).toBe(true);
    await expect(thread.locator("textarea")).toHaveCount(1);
  } finally { release(); }
  await expect(editor).toHaveCount(0); await expect(thread).toContainText("Saved revised feedback");
  await thread.getByRole("button", { name: "Back to Feedback", exact: true }).click();
  await (await threadAction(page, thread, "Delete thread")).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(thread.getByRole("button", { name: "Conversation actions", exact: true })).toBeFocused();
});

test("a source failure stays visible independently of collapsed conversation content and receipt recovery", async ({ page, review }) => {
  const { file } = await setup(page, review, "disclosure-save.html");
  await page.locator(".conversation-thread-title").click(); await close(page).click();
  const frame = await enterEditMode(page);
  let attempts = 0;
  await intercept(page, "save-edit", (route) => ++attempts === 1 ? failure(route, "Source save unavailable") : route.continue());
  await frame.locator("#copy").click(); await page.keyboard.press("End"); await page.keyboard.type(" changed");
  await feedback(page);
  await expect(page.getByRole("alert")).toContainText("Source save unavailable");
  await expect(page.locator(".conversation-thread-title")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#send")).toBeDisabled();
  expect(fs.readFileSync(file, "utf8")).toBe(source);
  await page.getByRole("button", { name: "Retry same request", exact: true }).click();
  await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("paragraph for feedback. changed");
  expect(attempts).toBe(2);
  await expect(page.locator(".conversation-thread-title")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Already saved", { exact: true })).toHaveCount(1);
});

test("Send selects all saved items across authorized pages beyond one page of results, never unsaved drafts", async ({ page, review }) => {
  test.setTimeout(60000);
  const { ref } = await setup(page, review, "feedback-total-first.html");
  const otherFile = writeFile(review, "feedback-total-second.html", source);
  const joined = await mutate(review, ref, "join-page", { target: otherFile });
  await seedThread(review, { ...ref, key: joined.value.pageKey }, "Other-page message");
  for (const [pageKey, count] of [[ref.key, 100], [joined.value.pageKey, 2]]) {
    for (let i = 0; i < count; i++) await mutate(review, ref, "record-edit", {
      pageKey, content: content("Original wording", `Revised wording ${i + 1}`, { label: `Paragraph ${i + 1}` }),
    });
  }
  await expect(page.locator(".conversation-edits").getByRole("checkbox")).toHaveCount(102);
  await expect(page.locator("#toolbarCount")).toHaveText("99+");
  await expect(page.locator("#commentsButton")).toHaveAccessibleDescription("104 saved pending feedback items");
  await expect(page.locator("#send")).toHaveText("Send (104)");
  await page.getByRole("button", { name: "New message", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "New message", exact: true });
  await draft.fill("Unsaved contextual draft is excluded");
  await note(page).fill("A submission-level note, not a conversation");
  await expect(page.locator("#send")).toHaveText("Send (105)");
  await expect(page.locator("#send")).toHaveAccessibleDescription("2 saved messages · 102 pending edits · 1 overall note selected");
  await page.locator("#send").click();
  await expect(page.getByText("Queued; not received", { exact: true })).toBeVisible();
  const work = (await conversation(review, ref, "poll")).submission;
  expect(work.edits).toHaveLength(102); expect(work.messages).toHaveLength(2);
  expect(new Set(work.pageKeys)).toEqual(new Set([ref.key, joined.value.pageKey]));
  expect(work.overallNote).toEqual({ body: "A submission-level note, not a conversation", intent: "discuss" });
  await expect(draft).toHaveValue("Unsaved contextual draft is excluded");
  expect((await listed(review, ref, "threads")).totalCount).toBe(2);
  await expect(page.locator("#toolbarCount")).toHaveText("0");
});
