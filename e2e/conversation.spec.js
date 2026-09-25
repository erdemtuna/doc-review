import { selectChoice } from "./choice-helpers.js";
import fs from "node:fs";
import { threadAction } from "./conversation-actions.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { test, expect, reviewApi, writeFile, waitForSdk, selectReviewMode, expectEditBlocked, feedback } from "./helpers.js";
import { responseFor } from "../test/fixtures/agent-loop.js";

async function call(review, body, route = "/api/conversation") {
  const result = await reviewApi(review, route, { method: "POST", body });
  expect(result.status, result.raw).toBe(200);
  return result.json();
}
async function open(page, review, target) {
  const { receipt } = await call(review, { operation: "open", requestId: randomUUID(), target });
  const ref = { reviewId: receipt.reviewId, entryKey: receipt.entryKey };
  await page.goto(`http://127.0.0.1:${review.port}/r/${ref.reviewId}`);
  await waitForSdk(page);
  return ref;
}
async function mutate(review, ref, operation, fields = {}) {
  const state = await call(review, { ...ref, operation: "read-review" });
  return call(review, { ...ref, operation, requestId: randomUUID(), expectedVersion: state.version, ...fields });
}
async function message(page, text, checked = false) {
  await page.getByRole("button", { name: "New message", exact: true }).click();
  await page.getByRole("textbox", { name: "New message", exact: true }).fill(text);
  if (checked) await page.locator('[data-composer="new"]').getByLabel("Request a change").check();
  await page.locator('[data-composer="new"]').getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator('[data-composer="new"]')).toHaveCount(0);
}
async function pasteImage(paragraph) {
  await paragraph.evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([bytes], "image.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  });
}

test("durable discussion, inline response, Focus drafts and shared End", async ({ page, context, review }) => {
  test.setTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const original = "<!doctype html><html><body><h1>Conversation</h1><p id='copy'>Original paragraph</p></body></html>";
  const file = writeFile(review, "conversation.html", original);
  const ref = await open(page, review, file);
  await page.locator("#commentsButton").click();
  await message(page, "Why this wording?");
  await expect(page.getByText("Discussion", { exact: true })).toHaveCount(0);
  await expect(page.locator(".conversation-exchange").getByText("Pending", { exact: true })).toBeVisible();
  await page.locator("#send").click();
  await expect(page.getByText("Queued; not received")).toBeVisible();
  const picked = await call(review, { ...ref, operation: "poll" });
  expect(picked.submission.messages[0].message.intent).toBe("discuss");
  await call(review, responseFor(picked.submission, { resultNote: "No source changes were needed." }));
  await expect(page.getByText("The explanation preserves the original meaning.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Latest submission result" }).getByText("No source changes were needed.", { exact: true })).toHaveCount(1);
  expect(fs.readFileSync(file, "utf8")).toBe(original);
  const thread = page.locator(".conversation-thread");
  await thread.getByRole("button", { name: "Reply", exact: true }).click();
  const draft = thread.getByRole("textbox", { name: "Reply", exact: true });
  await draft.fill("An unsaved follow-up");
  await draft.evaluate((element) => { element.focus(); element.setSelectionRange(3, 9); element.dispatchEvent(new Event("select", { bubbles: true })); });
  await thread.getByRole("button", { name: "Focus", exact: true }).click();
  await expect(draft).toHaveValue("An unsaved follow-up");
  expect(await draft.evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual([3, 9]);
  await thread.getByRole("button", { name: "Back to Feedback" }).click();
  await expect(draft).toHaveValue("An unsaved follow-up");
  await (await threadAction(page, thread, "Resolve")).click();
  await expect(page.getByRole("alert").getByText(/Save or cancel/)).toBeVisible();
  await thread.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("An unsaved follow-up", { exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto(page.url()); await waitForSdk(other);
  await other.locator("#commentsButton").click();
  await other.locator("#endReview").click();
  await expect(other.getByRole("alertdialog")).toContainText("for every tab");
  await other.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.locator("#send")).toBeDisabled();
  await expect(page.getByText("Saved unsent · read-only")).toBeVisible();
  expect(errors).toEqual([]);
});

test("composer keyboard modes and double-click reply Save preserve one request and newer typing", async ({ page, review }) => {
  const ref = await open(page, review, writeFile(review, "conversation-keyboard.html", "<p>Keyboard target</p>"));
  await page.locator("#commentsButton").click();
  await page.getByRole("button", { name: "New message", exact: true }).click();
  const newMessage = page.getByRole("textbox", { name: "New message", exact: true });
  await newMessage.fill("First line"); await newMessage.press("Shift+Enter"); await newMessage.press("End");
  await page.keyboard.insertText("Second line"); await newMessage.press("Enter");
  const thread = page.locator(".conversation-thread");
  await expect(thread.getByText("First line\nSecond line", { exact: true })).toBeVisible();
  await thread.getByRole("button", { name: "Edit message", exact: true }).click();
  const edit = page.getByRole("textbox", { name: "Edit message", exact: true });
  await edit.fill("Cancelled correction"); await edit.press("Escape");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(thread.getByText("First line\nSecond line", { exact: true })).toBeVisible();
  await thread.getByRole("button", { name: "Edit message", exact: true }).click();
  await edit.fill("Saved correction"); await edit.press("Enter");
  await expect(edit).toHaveCount(0);
  await expect(thread.getByText("Saved correction", { exact: true })).toBeVisible();

  let release;
  const hold = new Promise((resolve) => { release = resolve; }), replies = [];
  await page.route("**/api/conversation", async (route) => {
    if (route.request().postDataJSON().operation === "reply") {
      replies.push(route.request().postDataJSON());
      const response = await route.fetch(); await hold; await route.fulfill({ response }); return;
    }
    await route.continue();
  });
  await thread.getByRole("button", { name: "Reply", exact: true }).click();
  const reply = thread.getByRole("textbox", { name: "Reply", exact: true });
  await reply.fill("One saved reply");
  await thread.getByRole("button", { name: "Save", exact: true }).evaluate((button) => { button.click(); button.click(); });
  await expect.poll(() => replies.length).toBe(1);
  await expect(thread.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(reply).toBeEditable();
  await reply.fill("Newer unsent typing");
  await reply.evaluate((element) => element.setSelectionRange(3, 8));
  release();
  await expect(thread.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await expect(thread.getByText("One saved reply", { exact: true })).toHaveCount(1);
  await expect(reply).toHaveValue("Newer unsent typing");
  expect(await reply.evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual([3, 8]);
  await reply.press("Escape");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(reply).toHaveCount(0);
  await thread.getByRole("button", { name: "Reply", exact: true }).click();
  await reply.fill("Keyboard saved reply"); await reply.press("Enter");
  await expect(reply).toHaveCount(0);
  await expect(thread.getByText("Keyboard saved reply", { exact: true })).toBeVisible();
  expect(replies).toHaveLength(2);

  await page.getByRole("button", { name: "New message", exact: true }).click();
  await newMessage.fill("IME draft");
  await newMessage.evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await newMessage.press("Enter"); await newMessage.press("Escape");
  await expect(newMessage).toBeVisible();
  await newMessage.evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await newMessage.press("Escape");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(newMessage).toHaveCount(0);
  await page.getByRole("button", { name: /Overall note \(optional\)/ }).click();
  const note = page.getByRole("textbox", { name: "Overall note", exact: true });
  await note.fill("Overall"); await note.press("Enter"); await page.keyboard.insertText("More");
  await note.press("Escape"); await expect(note).toHaveValue("Overall\nMore");
  expect((await call(review, { ...ref, operation: "poll" })).state).toBe("waiting");
});

test("accepted source save with disconnected verification is not reported saved and recovers without rewriting", async ({ page, review }) => {
  const file = writeFile(review, "conversation-save-verification.html", "<p id='copy'>Original</p>");
  await open(page, review, file);
  let failReads = false, writes = 0;
  await page.route("**/api/conversation", async (route) => {
    const body = route.request().postDataJSON();
    if (body.operation === "save-edit") {
      writes++;
      const response = await route.fetch(); failReads = true; await route.fulfill({ response }); return;
    }
    if (failReads && ["list", "status", "read-page"].includes(body.operation)) { await route.abort("failed"); return; }
    await route.continue();
  });
  await selectReviewMode(page, "Edit");
  const paragraph = page.frameLocator("#frame").locator("#copy");
  await paragraph.click();
  await paragraph.evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.keyboard.insertText("Accepted exactly once");
  await page.locator("#commentsButton").click();
  await expect(page.getByRole("alert")).toContainText("Source save accepted");
  await expect(page.locator(".conversation-lifecycle")).not.toHaveAccessibleDescription(/Source saved/);
  expect(fs.readFileSync(file, "utf8")).toContain("Accepted exactly once");
  expect(writes).toBe(1);
  failReads = false;
  await page.getByRole("button", { name: "Reload source (discard local page edits)" }).click();
  await expect(page.frameLocator("#frame").locator("#copy")).toHaveText("Accepted exactly once");
  await expect(page.getByText("Already saved", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
});

test("reconnected history bridges missed pages and retains loaded records and the reading anchor", async ({ page, context, review }) => {
  test.setTimeout(120_000);
  const ref = await open(page, review, writeFile(review, "conversation-history-gap.html", "<p>History gap</p>"));
  await page.locator("#commentsButton").click();
  const completeOffline = async (start) => {
    await context.setOffline(true);
    for (let index = start; index < start + 55; index++) {
      await mutate(review, ref, "send", { pageKeys: [ref.entryKey], messages: [], edits: [],
        overallNote: { body: `Offline note ${index}`, intent: "discuss" } });
      const work = (await call(review, { ...ref, operation: "poll" })).submission;
      await call(review, responseFor(work, { resultNote: `Offline result ${index}` }));
    }
    await context.setOffline(false);
    await expect(page.getByRole("region", { name: "Latest submission result" }).getByText(`Offline result ${start + 54}`, { exact: true })).toHaveCount(1, { timeout: 15_000 });
  };
  await completeOffline(0);
  await expect(page.locator(".conversation-submission")).toHaveCount(50);
  const earlier = page.getByRole("button", { name: "Load earlier submissions", exact: true });
  await earlier.scrollIntoViewIfNeeded();
  const marker = page.getByText("Offline result 5", { exact: true });
  await marker.locator("xpath=ancestor::details[contains(@class,'conversation-submission')]/summary").click();
  await earlier.scrollIntoViewIfNeeded();
  const before = (await marker.boundingBox()).y;
  await earlier.click();
  await expect(page.locator(".conversation-submission")).toHaveCount(55);
  expect(Math.abs((await marker.boundingBox()).y - before)).toBeLessThan(2);
  const retained = await page.locator(".conversation-submission > details > small").allTextContents();
  await completeOffline(55);
  await expect(page.locator(".conversation-submission")).toHaveCount(110);
  const ids = await page.locator(".conversation-submission > details > small").allTextContents();
  expect(new Set(ids).size).toBe(110);
  expect(ids.slice(-55)).toEqual(retained);
  expect(Math.abs((await marker.boundingBox()).y - before)).toBeLessThan(2);
});

test("real cumulative and repeated human HTML saves remain exact at Send", async ({ page, review }) => {
  test.setTimeout(60_000);
  const file = writeFile(review, "conversation-saves.html", "<!doctype html><html><body><h1>Save evidence</h1><p id='first'>First original</p><p id='second'>Second original</p></body></html>");
  const ref = await open(page, review, file);
  await selectReviewMode(page, "Edit");
  const frame = page.frameLocator("#frame");
  await expect(frame.locator("body")).toHaveAttribute("contenteditable", "true");
  for (const [id, text] of [["first", "First precise edit"], ["second", "Second precise edit"], ["first", "First revised again"]]) {
    await frame.locator(`#${id}`).click();
    await frame.locator(`#${id}`).evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.keyboard.type(text);
    await expect.poll(() => fs.readFileSync(file, "utf8")).toContain(text);
  }
  await page.locator("#commentsButton").click();
  await expect(page.getByText("Already saved", { exact: true })).toHaveCount(2);
  await page.locator("#send").click();
  await expect(page.getByText("Queued; not received")).toBeVisible();
  const work = (await call(review, { ...ref, operation: "poll" })).submission;
  expect(work.edits).toHaveLength(2);
  expect(work.edits.every((edit) => edit.source.state === "saved")).toBe(true);
  await call(review, responseFor(work));
  await expect(page.getByRole("heading", { name: "What changed", exact: true })).toBeVisible();
  await page.locator("#commentsButton").click();
  await selectReviewMode(page, "Edit");
  await frame.locator("#first").click();
  await frame.locator("#first").evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.type("New edit after completed submission");
  await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("New edit after completed submission");
});

test("checked intent editing and ended late results retain read-only observer", async ({ page, review }) => {
  const file = writeFile(review, "conversation-late.html", "<p>Late result</p>");
  const ref = await open(page, review, file);
  await page.locator("#commentsButton").click();
  await message(page, "Change this wording", true);
  await page.getByRole("button", { name: "Edit message", exact: true }).click();
  await expect(page.locator(".conversation-thread").getByLabel("Request a change")).toBeChecked();
  await page.locator(".conversation-thread").getByLabel("Request a change").uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#send").click();
  await expect(page.getByText("Queued; not received")).toBeVisible();
  await page.locator("#endReview").click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.locator("#send")).toBeDisabled();
  const work = (await call(review, { ...ref, operation: "poll" })).submission;
  expect(work.messages[0].message.intent).toBe("discuss");
  await call(review, responseFor(work, { resultNote: "Late response after shared End." }));
  await expect(page.getByRole("region", { name: "Latest submission result" }).getByText("Late response after shared End.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New message", exact: true })).toBeDisabled();
  await page.reload(); await waitForSdk(page); await page.locator("#commentsButton").click();
  await expect(page.getByRole("region", { name: "Latest submission result" }).getByText("Late response after shared End.", { exact: true })).toBeVisible();
});

test("fresh and overlapping reviews block source writes and Send, but allow discussion; abandonment releases them", async ({ page, context, review }) => {
  const file = writeFile(review, "conversation-blocked.html", "<p>Shared target</p>");
  const ref = await open(page, review, file);
  await page.locator("#commentsButton").click(); await message(page, "First work");
  await page.locator("#send").click(); await expect(page.getByText("Queued; not received")).toBeVisible();
  await page.locator("#endReview").click(); await page.getByRole("button", { name: "Confirm", exact: true }).click();
  const second = await context.newPage();
  const fresh = await open(second, review, file); expect(fresh.reviewId).not.toBe(ref.reviewId);
  await second.locator("#commentsButton").click();
  await expect(second.locator("#send")).toBeDisabled();
  await expectEditBlocked(second, true);
  await message(second, "Prepare a discussion while blocked");
  await page.getByRole("button", { name: "Abandon submission" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Stop the old agent");
  await expect(page.getByRole("alertdialog")).toContainText(ref.reviewId);
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Abandoned. External source work", { exact: false })).toBeVisible();
  await expect(second.locator("#send")).toBeEnabled();
  await expectEditBlocked(second, false);
  await second.locator("#send").click(); await expect(second.getByText("Queued; not received")).toBeVisible();
  await call(review, { ...fresh, operation: "poll" });
  await expect(second.getByText("Received; delivery is not evidence of an active agent")).toBeVisible();
  await second.getByRole("button", { name: "Abandon submission" }).click();
  await second.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(second.getByText("Abandoned. External source work", { exact: false })).toBeVisible();
});

test("resolved history expands, keyboard collapse and narrow Focus retain composition without overflowing", async ({ page, review }, testInfo) => {
  test.setTimeout(60_000);
  const file = writeFile(review, "conversation-layout.html", "<p>Layout target</p>");
  const ref = await open(page, review, file);
  await page.locator("#commentsButton").click(); await message(page, "Long discussion ".repeat(25));
  await page.locator("#send").click(); await expect(page.getByText("Queued; not received")).toBeVisible();
  const work = (await call(review, { ...ref, operation: "poll" })).submission;
  await call(review, responseFor(work));
  const thread = page.locator(".conversation-thread");
  await expect(thread.getByText("The explanation preserves the original meaning.", { exact: true })).toBeVisible();
  await (await threadAction(page, thread, "Resolve")).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resolved (1)", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(thread.getByText("The explanation preserves the original meaning.", { exact: true })).toBeVisible();
  const collapse = thread.locator(".conversation-thread-title");
  await collapse.focus(); await page.keyboard.press("Enter");
  await expect(collapse).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter"); await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await (await threadAction(page, thread, "Reopen")).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await thread.getByRole("button", { name: "Reply", exact: true }).click();
  const input = thread.getByRole("textbox", { name: "Reply", exact: true });
  await input.fill("Composition survives");
  await input.evaluate((element) => { element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "x" })); });
  await thread.getByRole("button", { name: "Focus", exact: true }).click();
  await expect(thread.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await input.evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await expect(thread.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
    for (const [width, height] of [[320, 400], [390, 400], [320, 480], [390, 520], [768, 560], [1440, 800]]) {
      await page.setViewportSize({ width, height });
      await expect(page.getByText("Reviewing", { exact: true })).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const button of [thread.getByRole("button", { name: "Save", exact: true }), thread.getByRole("button", { name: "Back to Feedback" })]) {
        const box = await button.boundingBox();
        expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(height);
      }
      if (theme === "light" && width === 320 && height === 400) {
        const transcript = thread.locator(".conversation-transcript");
        await transcript.evaluate((element) => { element.scrollTop = 120; });
        await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(120);
        const geometry = () => page.evaluate(() => [...document.querySelectorAll(".conversation-result-peek,.conversation-result-preview,.conversation-thread,.conversation-transcript,.conversation-inventory,[data-message]")].map(node => ({
          class: node.className, scroll: node.scrollTop, y: node.getBoundingClientRect().y, height: node.getBoundingClientRect().height,
        })));
        const before = await geometry();
        await thread.getByRole("button", { name: "Back to Feedback" }).click();
        const inventory = await geometry();
        await thread.getByRole("button", { name: "Focus", exact: true }).click();
        fs.writeFileSync(testInfo.outputPath("focus-transfer-geometry.json"), JSON.stringify({ before, inventory, after: await geometry() }, null, 2));
        await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(120);
      }
      if (width === 320) await page.screenshot({ path: testInfo.outputPath(`conversation-focus-${theme}-320-${height}.png`) });
    }
    await page.screenshot({ path: testInfo.outputPath(`conversation-focus-${theme}.png`) });
  }
  await thread.getByRole("button", { name: "Back to Feedback" }).click();
  await page.setViewportSize({ width: 320, height: 400 });
  const bottom = await page.locator("#send").boundingBox();
  expect(bottom.y + bottom.height).toBeLessThanOrEqual(400);
  await page.screenshot({ path: testInfo.outputPath("conversation-feedback-320.png") });
});

test("response transport loss reconciles Send without duplicating immutable work", async ({ page, review }) => {
  const file = writeFile(review, "conversation-unknown.html", "<p>Unknown acceptance</p>");
  const ref = await open(page, review, file);
  await page.locator("#commentsButton").click(); await message(page, "Only one send");
  let lost;
  await page.route("**/api/conversation", async (route) => {
    const body = route.request().postDataJSON();
    if (body.operation === "send" && !lost) { lost = body; await route.fetch(); await route.abort("connectionreset"); }
    else await route.continue();
  });
  await page.locator("#send").click();
  await expect(page.getByText("send: acceptance unknown", { exact: true })).toBeVisible();
  const receiptMessage = await page.locator(".conversation-error p").last().innerText();
  await page.getByRole("complementary", { name: "Feedback" }).getByRole("button", { name: "Close", exact: true }).click();
  const recovery = page.getByRole("status", { name: "Review recovery" });
  await expect(recovery).toContainText(receiptMessage);
  await expect(recovery.locator("code")).toHaveText(lost.requestId);
  await page.locator("#seeChanges").click();
  await page.setViewportSize({ width: 320, height: 450 });
  await expect(recovery).toContainText("send: acceptance unknown");
  await expect(recovery.getByRole("button", { name: "Retry same request" })).toBeEnabled();
  await recovery.getByRole("button", { name: "Check receipt", exact: true }).click();
  await expect(page.getByText("send: acceptance unknown", { exact: true })).toHaveCount(0);
  await expect(recovery.getByRole("button", { name: "Check receipt" })).toHaveCount(0);
  await expect(recovery.getByRole("alert")).toContainText("Failed to fetch");
  await expect(page.locator(".conversation-lifecycle")).toHaveText("Waiting for agent");
  const history = await call(review, { operation: "list", scope: { ...ref, collection: "history", pageKey: null, threadId: null, submissionId: null, status: "all" }, query: {} });
  expect(history.items).toHaveLength(1);
});

test("unknown End stays visible in its dialog and replays the same request without discarding drafts", async ({ page, review }) => {
  await open(page, review, writeFile(review, "conversation-end-unknown.html", "<p>End uncertainty</p>"));
  await page.locator("#commentsButton").click(); await message(page, "Retained unsent message");
  await page.getByRole("button", { name: /Overall note \(optional\)/ }).click();
  await page.getByRole("textbox", { name: "Overall note", exact: true }).fill("Local unsaved note");
  const attempts = [];
  await page.route("**/api/conversation", async (route) => {
    const body = route.request().postDataJSON();
    if (body.operation === "end") {
      attempts.push(body);
      if (attempts.length === 1) { await route.fetch(); await route.abort("failed"); return; }
    }
    await route.continue();
  });
  await page.locator("#endReview").click(); await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Acceptance is unknown");
  await expect(page.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Check receipt", exact: true }).click();
  await expect(page.locator(".conversation-panel").getByText("end: acceptance unknown", { exact: true })).toHaveCount(0);
  await expect(page.locator(".conversation-lifecycle")).toHaveText("Review ended");
  await expect(page.getByText("Retained unsent message", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Overall note", exact: true })).toHaveValue("Local unsaved note");
  expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
});

test("navigation joins the shared review and sends saved work from unvisited pages", async ({ page, context, review }) => {
  const linked = writeFile(review, "conversation-linked.html", "<p>Linked page</p>");
  const file = writeFile(review, "conversation-nav.html", '<p>Entry</p><a href="conversation-linked.html">Next page</a>');
  const ref = await open(page, review, file);
  await page.frameLocator("#frame").getByRole("link", { name: "Next page" }).click();
  await expect(page.locator("#reviewPage")).toContainText("conversation-linked.html");
  await waitForSdk(page);
  await page.locator("#commentsButton").click(); await message(page, "Other page discussion");
  const other = await context.newPage(); await other.goto(page.url()); await waitForSdk(other); await other.locator("#commentsButton").click();
  await expect(other.getByText("Other page discussion", { exact: true })).toBeVisible();
  await other.locator("#send").click(); await expect(other.getByText("Queued; not received")).toBeVisible();
  const work = (await call(review, { ...ref, operation: "poll" })).submission;
  expect(work.messages[0].pageKey).not.toBe(ref.entryKey);
  expect(fs.readFileSync(linked, "utf8")).toBe("<p>Linked page</p>");
});

test("Markdown and scripted pages retain exact source-pending edits", async ({ page, review }) => {
  test.setTimeout(60_000);
  for (const [name, source] of [["conversation.md", "# Heading\n\nOriginal paragraph\n"], ["conversation-script.html", "<p>Original paragraph</p><script>document.body.dataset.active = 'yes'</script>"]]) {
    const file = writeFile(review, name, source);
    const ref = await open(page, review, file);
    await selectReviewMode(page, "Edit");
    const paragraph = page.frameLocator("#frame").locator("p").first();
    await paragraph.click();
    await paragraph.evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
    await page.keyboard.type("Exact pending wording");
    await page.locator("#commentsButton").click();
    await expect(page.getByText("Source pending", { exact: true })).toBeVisible();
    await page.locator("#send").click(); await expect(page.getByText("Queued; not received")).toBeVisible();
    const work = (await call(review, { ...ref, operation: "poll" })).submission;
    expect(work.edits[0].content.after).toBe("Exact pending wording");
    expect(work.edits[0].source.state).toBe("pending");
    expect(fs.readFileSync(file, "utf8")).toBe(source);
    await call(review, responseFor(work));
  }
});

test("pasted staged asset is retained and cumulative later saves keep its exact mapping", async ({ page, review }) => {
  const file = writeFile(review, "conversation-image.html", "<html><body><h1>Images</h1><p id='image'>Image here</p><p id='text'>Other paragraph</p></body></html>");
  await open(page, review, file);
  await selectReviewMode(page, "Edit");
  const paragraph = page.frameLocator("#frame").locator("#image");
  await paragraph.click();
  await pasteImage(paragraph);
  await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("assets/paste_");
  const text = page.frameLocator("#frame").locator("#text");
  await text.click();
  await text.evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.keyboard.type("Other exact edit");
  await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("Other exact edit");
  await page.locator("#commentsButton").click(); await expect(page.getByText("Already saved", { exact: true })).toHaveCount(2);
});

test("browser formatting, block moves and deletions produce exact saved outcomes", async ({ page, review }, info) => {
  const file = writeFile(review, "conversation-structure.html", "<html><head><style>body{max-width:600px;padding:24px}</style></head><body><h1>Structure</h1><p id='a'>Alpha</p><p id='b'><em>Beta</em></p><p id='c'>Gamma</p></body></html>");
  const ref = await open(page, review, file);
  await selectReviewMode(page, "Edit");
  const frame = page.frameLocator("#frame");
  await frame.locator("#a").click();
  await frame.locator("#a").evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.keyboard.press("Control+b");
  await expect.poll(() => fs.readFileSync(file, "utf8")).toMatch(/<(b|strong)>Alpha/);
  await frame.locator("#a").evaluate(() => new Promise(resolve => {
    document.addEventListener("selectionchange", () => resolve(), { once: true });
    getSelection().removeAllRanges();
  }));
  await frame.locator("#c").hover();
  await frame.locator("#a").hover({ position: { x: 20, y: 8 } });
  await expect(frame.locator("#mover")).toBeVisible();
  const visibleBeforeRetarget = await frame.locator("#mover").boundingBox();
  // Visibility alone can still refer to Gamma during the SDK's retarget dwell.
  await expect.poll(async () => {
    const handle = await frame.locator("#mover").boundingBox(), target = await frame.locator("#a").boundingBox();
    return handle && handle.y - target.y;
  }).toBe(1);
  const mover = await frame.locator("#mover").boundingBox(), destination = await frame.locator("#c").boundingBox();
  fs.writeFileSync(info.outputPath("block-move-target.json"), JSON.stringify({
    visibleBeforeRetarget, mover, destination, source: await frame.locator("#a").boundingBox(),
  }, null, 2));
  await page.mouse.move(mover.x + mover.width / 2, mover.y + mover.height / 2); await page.mouse.down();
  await page.mouse.move(destination.x + 40, destination.y + destination.height - 2, { steps: 10 }); await page.mouse.up();
  await expect.poll(() => fs.readFileSync(file, "utf8")).toMatch(/Gamma.*Alpha/s);
  await frame.locator("#b").hover();
  await frame.locator("#chipDelete").click();
  await expect.poll(() => fs.readFileSync(file, "utf8")).not.toContain("Beta");
  await page.locator("#commentsButton").click(); await page.locator("#send").click();
  await expect(page.getByText("Queued; not received")).toBeVisible();
  const work = (await call(review, { ...ref, operation: "poll" })).submission;
  expect(new Set(work.edits.map((edit) => edit.content.kind))).toEqual(new Set(["edited", "moved", "deleted"]));
  expect(work.edits.find((edit) => edit.content.kind === "deleted").content.before_html).toContain("<em>Beta</em>");
  expect(work.edits.every((edit) => edit.source.state === "saved")).toBe(true);
});

test("known-page overlap blocks that page, not an independently selected entry", async ({ page, review }) => {
  const shared = writeFile(review, "conversation-shared.html", "<p>Known shared page</p>");
  const ref = await open(page, review, writeFile(review, "conversation-independent.html", "<p>Independent entry</p>"));
  const joined = await mutate(review, ref, "join-page", { target: shared });
  const opened = await call(review, { operation: "open", requestId: randomUUID(), target: shared });
  const other = { reviewId: opened.receipt.reviewId, entryKey: opened.receipt.entryKey };
  await mutate(review, other, "send", { pageKeys: [other.entryKey], messages: [], edits: [], overallNote: { body: "Independent pending work", intent: "discuss" } });
  await page.locator("#commentsButton").click(); await message(page, "Only the independent entry");
  await expect(page.locator("#send")).toBeEnabled();
  await expectEditBlocked(page, false);
  await selectChoice(page, "reviewPage", joined.receipt.value.pageKey);
  await expectEditBlocked(page, true);
  await expect(page.getByRole("button", { name: "Revert", exact: true })).toHaveCount(0);
  await page.locator("#send").click(); await expect(page.getByText("Queued; not received")).toBeVisible();
});

test("stale source save refusal preserves current bytes and exposes explicit recovery", async ({ page, review }) => {
  const file = writeFile(review, "conversation-conflict.html", "<p id='copy'>Initial source</p>");
  await open(page, review, file);
  let changed = false;
  await page.route("**/api/conversation", async (route) => {
    if (route.request().postDataJSON().operation === "save-edit" && !changed) {
      changed = true; fs.writeFileSync(file, "<p id='copy'>Concurrent source writer</p>");
    }
    await route.continue();
  });
  await selectReviewMode(page, "Edit");
  const paragraph = page.frameLocator("#frame").locator("#copy");
  await paragraph.click();
  await paragraph.evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.keyboard.type("Must not overwrite concurrent source");
  await page.locator("#commentsButton").click();
  await expect(page.getByRole("alert")).toContainText("Source changed");
  expect(fs.readFileSync(file, "utf8")).toBe("<p id='copy'>Concurrent source writer</p>");
  await expect(page.locator(".conversation-lifecycle")).not.toHaveAccessibleDescription(/Source saved/);
  await page.getByRole("button", { name: "Reload source (discard local page edits)" }).click();
  await expect(page.frameLocator("#frame").locator("#copy")).toHaveText("Concurrent source writer");
  await expect(page.getByText("Source pending", { exact: true })).toBeVisible();
});

test("bounded earlier history preserves reviewer/reply associations and new activity stays collapsed", async ({ page, review }) => {
  test.setTimeout(60_000);
  const ref = await open(page, review, writeFile(review, "conversation-paging.html", "<p>Paging target</p>"));
  await page.locator("#commentsButton").click(); await message(page, "The answered original");
  await page.locator("#send").click(); await expect(page.getByText("Queued; not received")).toBeVisible();
  const work = (await call(review, { ...ref, operation: "poll" })).submission;
  await call(review, responseFor(work));
  const id = work.messages[0].message.threadId;
  for (let index = 0; index < 51; index++) await mutate(review, ref, "reply", { threadId: id, body: `Pending follow-up ${index}`, intent: "discuss" });
  const thread = page.locator(".conversation-thread");
  await expect(thread.getByText("Pending follow-up 50", { exact: true })).toBeVisible();
  await expect(thread.getByText("The explanation preserves the original meaning.", { exact: true })).toHaveCount(0);
  await thread.getByRole("button", { name: "Load earlier", exact: true }).click();
  await expect(thread.locator(".conversation-exchange").first()).toContainText("The answered original");
  await expect(thread.locator(".conversation-exchange").first()).toContainText("The explanation preserves the original meaning.");
  await expect(thread.locator(".conversation-exchange").last().locator(".conversation-response")).toHaveCount(0);
  await thread.locator(".conversation-thread-title").click();
  await mutate(review, ref, "reply", { threadId: id, body: "Arrived while collapsed", intent: "discuss" });
  await expect(thread.getByRole("button", { name: "New activity" })).toBeVisible();
  await expect(thread.locator(".conversation-thread-title")).toHaveAttribute("aria-expanded", "false");
});

test("oversized browser edits remain explicitly truncated source-pending feedback", async ({ page, review }) => {
  test.setTimeout(60_000);
  const file = writeFile(review, "conversation-truncated.html", "<p id='copy'>Original</p>");
  const ref = await open(page, review, file);
  await selectReviewMode(page, "Edit");
  const paragraph = page.frameLocator("#frame").locator("#copy");
  await paragraph.click();
  await paragraph.evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.keyboard.insertText("x".repeat(200_005));
  await page.locator("#commentsButton").click();
  await expect(page.getByText("Incomplete capture.", { exact: false })).toBeVisible();
  await page.locator("#send").click(); await expect(page.getByText("Queued; not received")).toBeVisible();
  const work = (await call(review, { ...ref, operation: "poll" })).submission;
  expect(work.edits[0].content.truncated).toBe(true);
  expect(work.edits[0].content.truncated_fields).toEqual(expect.arrayContaining(["after", "after_html"]));
  expect(work.edits[0].source.state).toBe("pending");
  expect(fs.readFileSync(file, "utf8")).toBe("<p id='copy'>Original</p>");
});

test("source results expose real comparisons and reply-only results never replace the frame", async ({ page, review }) => {
  const file = writeFile(review, "conversation-comparison.html", "<p>Before source wording</p>");
  const ref = await open(page, review, file);
  await page.locator("#commentsButton").click(); await message(page, "Please change the wording", true);
  await page.locator("#send").click(); await expect(page.getByText("Queued; not received")).toBeVisible();
  const work = (await call(review, { ...ref, operation: "poll" })).submission;
  fs.writeFileSync(file, "<p>After exact source wording</p>");
  await call(review, responseFor(work, {
    responses: work.messages.map(({ message }) => ({ threadId: message.threadId, messageId: message.messageId, messageVersion: message.version,
      outcome: "applied", body: "Changed only this requested wording." })),
    resultNote: "Updated the source paragraph.",
  }));
  await expect(page.frameLocator("#frame").locator("p")).toHaveText("After exact source wording");
  await expect(page.getByRole("region", { name: "Latest submission result" }).getByText("Updated the source paragraph.", { exact: true })).toHaveCount(1);
  await page.locator(".conversation-submission").first().locator(":scope > summary").click();
  await page.getByRole("button", { name: "Source changes", exact: true }).click();
  await expect(page.getByRole("region", { name: "Saved comparison" })).toContainText("Before source wording");
  await expect(page.getByRole("region", { name: "Saved comparison" })).toContainText("After exact source wording");
  await page.getByRole("button", { name: "Close comparison" }).click();
  const before = await page.locator("#frame").getAttribute("src");
  await page.locator(".conversation-thread").getByRole("button", { name: "Reply", exact: true }).click();
  await page.getByRole("textbox", { name: "Reply", exact: true }).fill("Explain without more changes");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#send").click(); await expect(page.getByText("Queued; not received")).toBeVisible();
  const discussion = (await call(review, { ...ref, operation: "poll" })).submission;
  await call(review, responseFor(discussion, { resultNote: "Explanation only, no new version." }));
  await expect(page.getByRole("region", { name: "Latest submission result" }).getByText("Explanation only, no new version.", { exact: true })).toBeVisible();
  expect(await page.locator("#frame").getAttribute("src")).toBe(before);
});

test("typed selection projection shares target metadata only and keeps drafts through source reload", async ({ page, review }) => {
  const file = writeFile(review, "conversation-selection.html", "<p id='copy'>Select this exact passage</p>");
  await open(page, review, file);
  const frame = page.frameLocator("#frame");
  await frame.locator("body").evaluate(() => {
    window.anchorMessages = [];
    window.addEventListener("message", (event) => { if (event.data.type === "eh:threadAnchors") window.anchorMessages.push(event.data); });
  });
  await frame.locator("#copy").evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await frame.locator("#commentAction").click();
  await page.getByRole("textbox", { name: "New message", exact: true }).fill("Private reviewer body is not frame metadata");
  await page.locator('[data-composer="new"]').getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".conversation-thread")).toHaveCount(1);
  const anchors = await frame.locator("body").evaluate(() => window.anchorMessages);
  expect(anchors.length).toBeGreaterThan(0);
  expect(JSON.stringify(anchors)).not.toContain("Private reviewer body");
  expect(JSON.stringify(anchors)).not.toContain(review.token);
  await feedback(page);
  await page.locator(".conversation-thread").getByRole("button", { name: "Reply", exact: true }).click();
  await page.getByRole("textbox", { name: "Reply", exact: true }).fill("Keep this local conversation draft");
  fs.writeFileSync(file, "<p id='copy'>Changed externally</p>");
  await expect(page.frameLocator("#frame").locator("#copy")).toHaveText("Changed externally");
  await expect(page.getByRole("textbox", { name: "Reply", exact: true })).toHaveValue("Keep this local conversation draft");
});

test("review-local revert preserves conversations and exact pending edits", async ({ page, review }) => {
  const original = "<html><body><p id='copy'>Revert original</p></body></html>";
  const file = writeFile(review, "conversation-revert.html", original);
  await open(page, review, file);
  await selectReviewMode(page, "Edit");
  const paragraph = page.frameLocator("#frame").locator("#copy");
  await paragraph.click();
  await paragraph.evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.keyboard.type("A human source edit");
  await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("A human source edit");
  await page.locator("#commentsButton").click();
  await expect(page.getByRole("button", { name: "Revert", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Revert", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(() => fs.readFileSync(file, "utf8")).toBe(original);
  await expect(page.getByRole("button", { name: "Revert", exact: true })).toBeDisabled();
  await expect(page.getByText("Source pending", { exact: true })).toBeVisible();
});

test("restart reattaches exact ended review, keeps drafts and receives a late CLI response", async ({ page, review }) => {
    test.setTimeout(60_000);
    const ref = await open(page, review, writeFile(review, "conversation-restart.html", "<p>Restart source</p>"));
    await page.locator("#commentsButton").click(); await message(page, "Queued before restart");
    await page.locator("#send").click(); await expect(page.getByText("Queued; not received")).toBeVisible();
    await message(page, "Saved but never sent");
    await page.getByRole("button", { name: /Overall note \(optional\)/ }).click();
    await page.getByRole("textbox", { name: "Overall note", exact: true }).fill("Local draft survives reattachment only");
    await page.locator("#endReview").click(); await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.locator(".conversation-lifecycle")).toHaveText("Review ended");
    await expect(page.locator("#send")).toBeDisabled();
    const oldSession = await page.locator("body").getAttribute("data-session");
    await review.restart();
    await expect(page.locator("body")).not.toHaveAttribute("data-session", oldSession);
    await expect(page.getByRole("textbox", { name: "Overall note", exact: true })).toHaveValue("Local draft survives reattachment only");
    await expect(page.getByText("Saved but never sent", { exact: true })).toBeVisible();
    const cli = async (...args) => {
      const child = spawn(process.execPath, [path.join(process.cwd(), "lib", "cli.js"), ...args], {
        cwd: review.root, env: { ...process.env, DOC_REVIEW_STATE_DIR: path.join(review.root, "state") }, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      expect(code, stderr).toBe(0); return JSON.parse(stdout);
    };
    const args = ["--review", ref.reviewId, "--entry", ref.entryKey, "--timeout", "5"];
    const work = await cli("poll", ...args);
    const responseFile = path.join(review.root, "browser-response.json");
    fs.writeFileSync(responseFile, JSON.stringify(responseFor(work.submission, { resultNote: "CLI completed old review after restart." })));
    await cli("respond", ...args, "--response-file", responseFile);
    await expect(page.getByRole("region", { name: "Latest submission result" }).getByText("CLI completed old review after restart.", { exact: true })).toBeVisible();
    await expect(page.locator("#send")).toBeDisabled();
  });

  test("localhost source-pending edits and asset previews never rewrite rendered output to source", async ({ page, review }) => {
    const source = "<html><body><p id='copy'>URL original</p></body></html>";
    const app = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(source); });
    await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
    try {
      const ref = await open(page, review, `http://127.0.0.1:${app.address().port}/`);
      await selectReviewMode(page, "Edit");
      const paragraph = page.frameLocator("#frame").locator("#copy");
      await paragraph.click();
      await paragraph.evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
      await page.keyboard.type("URL exact new wording");
      await pasteImage(paragraph);
      await expect(paragraph.locator("img")).toHaveCount(1);
      await expect.poll(() => paragraph.locator("img").evaluate((image) => image.naturalWidth)).toBe(1);
      await page.locator("#commentsButton").click();
      await expect(page.getByText("Source pending", { exact: true })).toBeVisible();
      await page.locator("#send").click(); await expect(page.getByText("Queued; not received")).toBeVisible();
      const work = (await call(review, { ...ref, operation: "poll" })).submission;
      expect(work.edits[0].content.after).toBe("URL exact new wording");
      expect(work.edits[0].source.state).toBe("pending");
      expect(work.edits[0].content.staged_assets).toHaveLength(1);
      expect(work.edits[0].content.after_html).toContain(work.edits[0].content.staged_assets[0].preview_src);
      expect(work.edits[0].content.staged_assets[0].preview_src).toMatch(/^__doc_review_paste__\//);
      await call(review, responseFor(work));
      expect(await (await fetch(`http://127.0.0.1:${app.address().port}/`)).text()).toBe(source);
    } finally { app.closeAllConnections(); await new Promise((resolve) => app.close(resolve)); }
  });
