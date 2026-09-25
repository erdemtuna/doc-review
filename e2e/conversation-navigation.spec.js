import { test, expect, openReview, waitForSdk, writeFile, seedThread, feedback, overallNote, mutate, conversation, sendPending, handled } from "./helpers.js";
import { content } from "../test/fixtures/review.js";

test("Jump to reveals the exact passage without an overlay and returns to the same editor and inventory position", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "jump.html",
    '<p id="copy">Exact passage for jumping</p><div style="height:1800px"></div><p id="bottom">Offscreen element</p>'));
  const frame = await waitForSdk(page);
  const { threadId } = await seedThread(review, ref, "Keep this discussion",
    { kind: "selection", anchor: { quote: "Exact passage for jumping" } });
  for (let i = 0; i < 4; i++) await seedThread(review, ref, `Another discussion ${i}. ${"Readable context. ".repeat(6)}`);
  await feedback(page);
  const card = page.locator(`[data-thread="${threadId}"]`), inventory = page.locator(".conversation-inventory");
  await card.getByRole("button", { name: "Reply", exact: true }).click();
  const editor = card.getByRole("textbox", { name: "Reply", exact: true });
  await editor.fill("Keep this unsaved reply");
  await editor.evaluate(node => { window.jumpEditor = node; node.setSelectionRange(3, 8); node.dispatchEvent(new Event("select", { bubbles: true })); });
  for (const width of [1366, 720]) {
    await page.setViewportSize({ width, height: 800 });
    const jump = card.getByRole("button", { name: "Jump to", exact: true });
    await jump.scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    const position = await inventory.evaluate(node => node.scrollTop);
    await jump.focus(); await jump.press("Enter");
    await expect(page.locator(".conversation-panel")).toBeHidden();
    await expect(page.locator(".conversation-backdrop")).toBeHidden();
    expect(await page.locator(".stage").evaluate(node => node.inert)).toBe(false);
    await expect(frame.locator(`mark[data-eh-mark="${threadId}"]`)).toBeInViewport();
    await expect(frame.locator(`mark[data-eh-mark="${threadId}"]`)).toHaveClass(/eh-active/);
    await feedback(page);
    await expect.poll(() => inventory.evaluate(node => node.scrollTop)).toBe(position);
    expect(await editor.evaluate(node => [node === window.jumpEditor, node.value, node.selectionStart, node.selectionEnd]))
      .toEqual([true, "Keep this unsaved reply", 3, 8]);
  }
  const offscreen = await seedThread(review, ref, "Element target", { kind: "element", anchor: { selector: "#bottom", label: "Offscreen element" } });
  await page.locator(`[data-thread="${offscreen.threadId}"]`).getByRole("button", { name: "Jump to" }).click();
  await expect(frame.locator("#bottom")).toBeInViewport();
  await expect(page.locator(".conversation-panel")).toBeHidden();
});

test("cross-page Jump to verifies membership before revealing and keeps unavailable, resolved and ended destinations honest", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "entry.html", "<p id='copy'>Entry page</p>"));
  await waitForSdk(page);
  const joined = await mutate(review, ref, "join-page", { target: writeFile(review, "member.html", "<p id='copy'>Member exact passage</p><p>Repeated</p><p>Repeated</p>") });
  const member = { ...ref, key: joined.value.pageKey };
  const { threadId } = await seedThread(review, member, "Member discussion", { kind: "selection", anchor: { quote: "Member exact passage" } });
  const missing = await seedThread(review, member, "Missing discussion", { kind: "selection", anchor: { quote: "No such passage" } });
  await feedback(page);
  const card = page.locator(`[data-thread="${threadId}"]`);
  await page.locator(`[data-thread="${missing.threadId}"]`).getByRole("button", { name: "Jump to" }).click();
  await expect(page.locator("#reviewPage")).toHaveAttribute("data-value", joined.value.pageKey);
  await expect(page.locator(".conversation-panel")).toBeVisible();
  const missingCard = page.locator(`[data-thread="${missing.threadId}"]`);
  await expect(missingCard.getByRole("button", { name: "Jump to" })).toBeDisabled();
  await expect(missingCard).toContainText("original target was not found");
  await card.getByRole("button", { name: "Jump to" }).click();
  await expect(page.locator(".conversation-panel")).toBeHidden();
  await expect(page.frameLocator("#frame").locator(`mark[data-eh-mark="${threadId}"]`)).toBeInViewport();
  await sendPending(review, ref); await handled(review, ref);
  await mutate(review, ref, "set-thread-status", { threadId, status: "resolved" });
  await feedback(page);
  await expect(card).toContainText("Resolved");
  await card.getByRole("button", { name: "Jump to" }).click();
  await expect(page.locator(".conversation-panel")).toBeHidden();
  await mutate(review, ref, "end", { confirmUnsentReadOnly: true });
  await feedback(page);
  await expect(page.locator("#send")).toBeDisabled();
  await expect(card.getByRole("button", { name: "Reply", exact: true })).toHaveCount(0);
  await card.getByRole("button", { name: "Jump to" }).click();
  await expect(page.locator(".conversation-panel")).toBeHidden();
});

test("Comments, Your edits and optional note are independent disclosures with authoritative multi-page and note-only Send", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "counts.html", "<p id='copy'>Original</p>"));
  await waitForSdk(page);
  const joined = await mutate(review, ref, "join-page", { target: writeFile(review, "counts-member.md", "Other original") });
  await seedThread(review, ref, "First comment");
  await seedThread(review, { ...ref, key: joined.value.pageKey }, "Other-page comment");
  await mutate(review, ref, "record-edit", { pageKey: joined.value.pageKey, content: content("Other original", "Exact after") });
  await feedback(page);
  const noteToggle = page.getByRole("button", { name: /Overall note \(optional\)/ });
  await expect(noteToggle).toHaveAttribute("aria-expanded", "false");
  const note = await overallNote(page);
  await note.fill("Only this note grants permission");
  await page.locator('[data-composer="note"]').getByRole("checkbox").check();
  await note.evaluate(node => { window.disclosureNote = node; node.setSelectionRange(2, 7); node.dispatchEvent(new Event("select", { bubbles: true })); });
  await note.dispatchEvent("compositionstart");
  await expect(noteToggle).toBeDisabled(); await expect(page.locator("#send")).toBeDisabled();
  await note.dispatchEvent("compositionend");
  await noteToggle.click();
  await expect(noteToggle).toContainText("Draft");
  await expect(page.locator("#send")).toHaveText("Send (4)");
  const comments = page.getByRole("button", { name: "Comments (2)", exact: true });
  const edits = page.getByRole("button", { name: "Your edits (1)", exact: true });
  await comments.click();
  await expect(page.locator("#conversationComments")).toBeHidden();
  await expect(page.locator("#conversationEdits")).toBeVisible();
  await edits.click();
  await expect(page.locator("#send")).toHaveText("Send (4)");
  await comments.click();
  await expect(page.locator("#conversationEdits")).toBeHidden();
  for (const box of await page.getByRole("checkbox", { name: "Send message", exact: true }).all()) await box.uncheck();
  await edits.click();
  await expect(page.locator(".conversation-edit-preview")).toContainText("Other original");
  await expect(page.locator(".conversation-edit-preview")).toContainText("Exact after");
  await page.locator(".conversation-edits").getByRole("checkbox").uncheck();
  await expect(page.locator("#send")).toHaveText("Send (1)");
  await expect(page.locator("#toolbarCount")).toHaveText("3");
  await noteToggle.click();
  expect(await note.evaluate(node => [node === window.disclosureNote, node.selectionStart, node.selectionEnd])).toEqual([true, 2, 7]);
  await page.locator("#send").click();
  await expect(page.getByText("Queued; not received", { exact: true })).toBeVisible();
  const work = (await conversation(review, ref, "poll")).submission;
  expect(work.messages).toEqual([]); expect(work.edits).toEqual([]);
  expect(work.overallNote).toEqual({ body: "Only this note grants permission", intent: "request-change" });
});
