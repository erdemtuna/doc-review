import fs from "node:fs";
import { test, expect, openReview, waitForSdk, writeFile, feedback, enterEditMode, selectText, selectReviewMode, listed, conversation, handled, seedThread, reviewApi, mutate, sendPending, beginComment } from "./helpers.js";
import { responseFor } from "../test/fixtures/agent-loop.js";

const visibleTextHeight = (locator) => locator.evaluate(node => {
  const range = document.createRange(); range.selectNodeContents(node);
  const text = range.getBoundingClientRect();
  let top = Math.max(0, text.top), bottom = Math.min(innerHeight, text.bottom);
  for (let parent = node; parent; parent = parent.parentElement) {
    if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
      const box = parent.getBoundingClientRect();
      top = Math.max(top, box.top + parent.clientTop);
      bottom = Math.min(bottom, box.top + parent.clientTop + parent.clientHeight);
    }
  }
  return Math.max(0, bottom - top);
});
const readableTextHeight = (locator) => locator.evaluate(node => {
  const range = document.createRange(); range.selectNodeContents(node);
  return Math.min(18, range.getBoundingClientRect().height);
});

for (const external of [false, true]) test(`automatic/manual capture ${external ? "reconciles an external immutable winner" : "shares exact ownership"} without a stale warning`, async ({ page, review }, info) => {
  test.setTimeout(60_000);
  const file = writeFile(review, "capture-overlap-baseline.html", "<p id='copy'>Before overlap</p>");
  const ref = await openReview(page, review, file);
  await waitForSdk(page); await feedback(page);
  await feedback(page);
  await page.getByRole("button", { name: /Note to agent/ }).click();
  await page.locator("#draft-note").fill("Update this paragraph.");
  await page.locator('[data-composer="note"]').getByRole("checkbox", { name: "Request a change" }).check();
  await page.locator("#send").click();
  await expect(page.getByRole("status", { name: "Waiting for agent", exact: true })).toBeVisible();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const captures = [];
  await page.route("**/api/conversation/capture", async route => {
    const body = route.request().postDataJSON();
    if (body.submissionId === null) return route.continue();
    const entry = { body, status: null, response: null };
    captures.push(entry);
    if (captures.length === 1) await gate;
    const response = await route.fetch();
    entry.response = await response.json();
    await route.fulfill({ response });
    entry.status = response.status();
  });
  try {
    fs.writeFileSync(file, "<p id='copy'>After overlap</p>");
    await expect(page.frameLocator("#frame").locator("#copy")).toHaveText("After overlap");
    await waitForSdk(page);
    const { work } = await handled(review, ref, { overallOutcome: "applied", resultNote: "Deterministic fixture response; not live-agent reasoning." });
    await expect.poll(() => captures.length).toBe(1);
    await page.getByRole("region", { name: "Latest submission result" }).getByRole("button", { name: "View changes" }).click();
    const changes = page.getByRole("region", { name: "Saved comparison" });
    const partial = {};
    for (const mode of ["source", "content"]) {
      const response = await reviewApi(review, "/api/conversation/comparison", { method: "POST", body: {
        reviewId: ref.reviewId, entryKey: ref.entryKey, submissionId: work.submissionId, pageKey: ref.key, mode,
      } });
      expect(response.status).toBe(200);
      partial[mode] = response.json().available;
    }
    expect(partial).toEqual({ source: true, content: false });
    await changes.getByRole("button", { name: "Capture current content" }).click();
    await page.waitForTimeout(200);
    expect(captures).toHaveLength(1);
    const comparison = async () => (await reviewApi(review, "/api/conversation/comparison", { method: "POST", body: {
      reviewId: ref.reviewId, entryKey: ref.entryKey, submissionId: work.submissionId, pageKey: ref.key, mode: "content",
    } })).json();
    if (external) {
      const winner = await reviewApi(review, "/api/conversation/capture", { method: "POST", body: captures[0].body });
      expect(winner.status, winner.raw).toBe(200);
    }
    release();
    await expect.poll(() => captures[0].status).toBe(external ? 409 : 200);
    if (external) expect(captures[0].response.error).toMatchObject({ code: "VERSION_CONFLICT", status: 409, retryable: false });
    await expect.poll(async () => (await comparison()).available).toBe(true);
    const ready = await comparison();
    expect(ready.available).toBe(true);
    const endpoint = (await listed(review, ref, "comparisons", { submissionId: work.submissionId })).items[0].resultRevisionId;
    await expect(changes.getByRole("button", { name: "Capture current content" })).toHaveCount(0);
    await expect(page.locator(".conversation-notice")).not.toContainText(["Rendered result endpoint is already immutable"]);
    expect(await comparison()).toEqual(ready);
    expect((await listed(review, ref, "comparisons", { submissionId: work.submissionId })).items[0].resultRevisionId).toBe(endpoint);
    expect(captures).toHaveLength(1);
    await page.screenshot({ path: info.outputPath("overlap-reconciled.png") });
    fs.writeFileSync(info.outputPath("capture-overlap.json"), JSON.stringify({
      classification: external ? "Typed same-result Content reconciliation" : "One automatic/manual POST",
      order: external ? "automatic held; explicit joins; external wins; automatic conflicts and reconciles" : "automatic held; explicit joins; shared POST completes",
      captures, partialBeforeManual: partial, endpoint, sameResultContentAvailable: ready.available, immutableEndpointPreserved: true,
      warning: await page.locator(".conversation-notice").allTextContents(),
      originalLiveCaller: "unproven",
    }, null, 2));
  } finally { release(); await page.unroute("**/api/conversation/capture"); }
});

test("actual saved human edits and captured agent result are discoverable, distinct and readable without disturbing drafts", async ({ page, review }, info) => {
  test.setTimeout(60_000);
  const file = writeFile(review, "result-discovery.html", "<p id='copy'>Original human wording</p><p id='agent'>Original agent target</p>");
  const ref = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await enterEditMode(page);
  await frame.locator("#copy").click(); await selectText(frame, "#copy"); await page.keyboard.insertText("Exact human wording");
  await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("Exact human wording");
  await selectReviewMode(page, "View"); await feedback(page);
  await feedback(page);
  const edits = page.locator(".conversation-edits");
  await expect(edits).toContainText("Already saved");
  await expect(edits.locator(".conversation-edit-preview")).toContainText("Original human wording");
  await expect(edits.locator(".conversation-edit-preview")).toContainText("Exact human wording");
  await expect(edits.getByRole("checkbox")).toHaveCount(0);
  await expect(page.locator("#send")).toHaveText("Send to agent (1)");
  await feedback(page);
  await page.getByRole("button", { name: /Note to agent/ }).click();
  await page.locator("#draft-note").fill("Please update the agent target only.");
  await page.locator('[data-composer="note"]').getByRole("checkbox", { name: "Request a change" }).check();
  await page.locator("#send").click();
  await expect(page.getByRole("status", { name: "Waiting for agent", exact: true })).toBeVisible();
  const work = (await conversation(review, ref, "poll")).submission;
  expect(work.edits[0].source.state).toBe("saved");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Original agent target", "Actual agent result"));
  await expect(frame.locator("#agent")).toHaveText("Actual agent result");
  await waitForSdk(page);
  const received = await reviewApi(review, "/api/conversation", { method: "POST", body: responseFor(work, {
    overallOutcome: "applied", resultNote: "Updated the agent target. Your saved wording was preserved.",
  }) });
  expect(received.status, received.raw).toBe(200);
  const peek = page.getByRole("region", { name: "Latest submission result" });
  await expect(peek).toBeVisible();
  expect(await page.locator(".conversation-submission").evaluate(node => node.open)).toBe(false);
  await peek.getByRole("button", { name: "View changes" }).click();
  const changes = page.getByRole("region", { name: "Saved comparison" });
  await expect(changes.getByRole("region", { name: "Full submission result note" })).toContainText("Updated the agent target.");
  await expect(changes).toContainText("Saved by you before Send; no additional agent edit reported.");
  await expect.poll(async () => (await listed(review, ref, "history")).items[0].comparisonStatus).toBe("ready");
  if (await changes.getByRole("button", { name: "Refresh comparison" }).count()) await changes.getByRole("button", { name: "Refresh comparison" }).click();
  await expect(changes.locator(".comparison-surface")).toContainText("Actual agent result");
  expect(await changes.locator(".comparison-current").textContent()).not.toContain("Exact human wording");
  await changes.getByRole("button", { name: "Back to review" }).click();
  await beginComment(page);
  const draft = page.locator("#draft-new");
  await draft.fill("Keep exact IME draft");
  await draft.evaluate(node => { window.resultDraft = node; node.setSelectionRange(3, 8); node.dispatchEvent(new Event("select", { bubbles: true }));
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
  await peek.getByRole("button", { name: "View changes" }).click();
  await changes.getByRole("button", { name: "Source", exact: true }).click();
  await expect(changes.locator(".comparison-surface")).toContainText("Actual agent result");
  await changes.getByRole("button", { name: "Back to review" }).click();
  expect(await draft.evaluate(node => [node === window.resultDraft, node.selectionStart, node.selectionEnd])).toEqual([true, 3, 8]);
  await expect(page.getByRole("button", { name: /^(Add comment|Add reply|Update comment)$/, exact: true })).toBeDisabled();
  await draft.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await draft.press("Escape");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(draft).toHaveCount(0);
  await page.getByRole("button", { name: "History", exact: true }).click();
  const submission = page.locator(".conversation-submission").first();
  await submission.locator(":scope > summary").click();
  await expect(submission).toContainText("Saved by you before Send; no additional agent edit reported.");
  await expect(submission.getByText(/^already-saved:/)).toHaveCount(0);
  await page.getByRole("group", { name: "Feedback destination" }).getByRole("button", { name: "Feedback", exact: true }).click();
  const measurements = [];
  for (const [width, height] of [[1440, 900], [1280, 720], [900, 700], [899, 700], [768, 900], [390, 844], [390, 480], [320, 400]]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height });
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
    await page.locator(".conversation-inventory").evaluate(node => { node.scrollTop = 0; });
    const preview = peek.locator(".conversation-result-preview");
    const requiredPreview = await readableTextHeight(preview);
    expect(requiredPreview).toBeGreaterThan(0);
    await expect.poll(() => visibleTextHeight(preview)).toBeGreaterThanOrEqual(requiredPreview);
    const previewHeight = await visibleTextHeight(preview);
    await page.screenshot({ path: info.outputPath(`result-peek-${theme}-${width}x${height}.png`) });
    const button = peek.getByRole("button", { name: "View changes" });
    await button.click();
    const body = changes.locator(".conversation-result-body");
    const requiredBody = await readableTextHeight(body);
    expect(requiredBody).toBeGreaterThan(0);
    await expect.poll(() => visibleTextHeight(body)).toBeGreaterThanOrEqual(requiredBody);
    measurements.push({ width, height, theme, preview: previewHeight, requiredPreview, requiredBody, body: await visibleTextHeight(body), panel: await changes.boundingBox() });
    await page.screenshot({ path: info.outputPath(`result-${theme}-${width}x${height}.png`) });
    await changes.getByRole("button", { name: "Back to review" }).click();
  }
  fs.writeFileSync(info.outputPath("result-readability.json"), JSON.stringify(measurements, null, 2));
  await page.locator("#endReview").click(); await page.getByRole("button", { name: "End review", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.locator(".conversation-lifecycle")).toHaveText("Review ended");
  await peek.getByRole("button", { name: "View changes" }).click();
  await expect(changes.locator(".conversation-result-body")).toContainText("Updated the agent target.");
});

test("reply-only results lead to the exact conversation without fetching an empty comparison", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "reply-result.html", "<p>Unchanged source</p>"));
  await waitForSdk(page); const thread = await seedThread(review, ref, "Please explain");
  await feedback(page); await expect(page.locator("#send")).toBeEnabled(); await page.locator("#send").click();
  await expect(page.getByRole("status", { name: "Waiting for agent", exact: true })).toBeVisible();
  await handled(review, ref, { resultNote: "Explanation only; no edits were made." });
  const peek = page.getByRole("region", { name: "Latest submission result" });
  let comparisons = 0;
  page.on("request", request => { if (request.url().endsWith("/api/conversation/comparison")) comparisons++; });
  await expect(peek).toContainText("Explanation only; no edits were made.");
  await expect(peek.getByRole("button", { name: "Read more", exact: true })).toHaveCount(0);
  await peek.getByRole("button", { name: "Replies (1)", exact: true }).click();
  await peek.getByRole("button", { name: /Please explain/ }).click();
  const card = page.locator(`[data-thread="${thread.threadId}"]`);
  await expect(card).toHaveClass(/focused/);
  await expect(card.locator(".conversation-response")).toBeVisible();
  await expect(card.locator(".conversation-exchange")).toBeFocused();
  await page.locator("#seeChanges").click();
  await expect(page.getByRole("region", { name: "Changes", exact: true })).toContainText("No document changes reported.");
  await page.getByRole("button", { name: "Back to review", exact: true }).click();
  await expect(card).toBeVisible();
  expect(comparisons).toBe(0);
  const history = (await listed(review, ref, "history")).items[0];
  const references = (await listed(review, ref, "comparisons", { submissionId: history.submissionId })).items;
  expect(references.every(item => item.resultRevisionId === null)).toBe(true);
});

test("complete summaries and batch reply navigation preserve origin, reading space and drafts", async ({ page, review }, info) => {
  test.setTimeout(90_000);
  const ref = await openReview(page, review, writeFile(review, "reply-navigation.html",
    "<h1>Exact issue filtering</h1><p id='copy'>Goals and non-goals</p>"));
  await waitForSdk(page);
  await seedThread(review, ref, "Explain the goals", { kind: "element", anchor: { selector: "#copy", label: "Goals and non-goals" } });
  await seedThread(review, ref, "Keep this title", { kind: "element", anchor: { selector: "h1", label: "Exact issue filtering" } });
  await feedback(page);
  await page.locator("#send").click();
  await expect(page.getByRole("status", { name: "Waiting for agent", exact: true })).toBeVisible();
  const work = (await conversation(review, ref, "poll")).submission;
  const note = "Explained the paragraph and acknowledged the title feedback. ".repeat(12) + "Summary ending is readable.";
  const responses = work.messages.map(({ message }, index) => ({
    threadId: message.threadId, messageId: message.messageId, messageVersion: message.version,
    outcome: "answered", body: `Answer ${index + 1}.\n\n` +
      "Filter before paging. Keep the cursor tied to the same filters. Preserve authorization checks.\n\n".repeat(12) + "Final answer line.",
  }));
  const completed = await reviewApi(review, "/api/conversation", { method: "POST", body: responseFor(work, { responses, resultNote: note }) });
  expect(completed.status, completed.raw).toBe(200);
  const peek = page.getByRole("region", { name: "Latest submission result" });
  await expect(peek).toBeVisible();
  const firstCard = page.locator(`[data-thread="${work.messages[0].message.threadId}"]`);
  expect(await firstCard.locator(".conversation-thread-toolbar button").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label"))))
    .toEqual(["Mark conversation as read", "Show in document", "Resolve", "Conversation actions", "Collapse conversation"]);
  const inventory = page.locator(".conversation-inventory");
  const tabs = page.getByRole("group", { name: "Feedback destination" });
  let draftCreated = false;
  for (const [width, height] of [[1440, 900], [720, 600], [390, 600], [320, 400]]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height });
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
    await tabs.getByRole("button", { name: "Feedback", exact: true }).click();
    await inventory.evaluate(node => { node.scrollTop = 0; });
    await peek.getByRole("button", { name: "Read more", exact: true }).click();
    const summary = peek.locator(".conversation-result-preview");
    expect(await summary.evaluate(node => getComputedStyle(node).webkitLineClamp)).toBe("none");
    await peek.getByRole("button", { name: "Show less", exact: true }).scrollIntoViewIfNeeded();
    expect(await summary.evaluate(node => node.clientHeight >= node.scrollHeight)).toBe(true);
    await page.screenshot({ path: info.outputPath(`full-summary-${theme}-${width}.png`), animations: "disabled", caret: "initial" });
    await peek.getByRole("button", { name: "Show less", exact: true }).click();
    const moreBounds = await peek.getByRole("button", { name: "Read more", exact: true }).boundingBox();
    const repliesBounds = await peek.getByRole("button", { name: "Replies (2)", exact: true }).boundingBox();
    expect(Math.abs(moreBounds.y - repliesBounds.y)).toBeLessThanOrEqual(1);
    expect(moreBounds.x + moreBounds.width).toBeLessThan(repliesBounds.x);
    const actionBounds = await peek.locator(".conversation-actions").boundingBox();
    expect(Math.abs(moreBounds.x - actionBounds.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(repliesBounds.x + repliesBounds.width - actionBounds.x - actionBounds.width)).toBeLessThanOrEqual(1);
    for (const origin of ["Feedback", "History"]) {
      await tabs.getByRole("button", { name: origin, exact: true }).click();
      const result = origin === "Feedback" ? peek : page.locator(".conversation-submission").first();
      if (origin === "History" && !await result.evaluate(node => node.open)) await result.locator(":scope > summary").click();
      const disclosure = result.getByRole("button", { name: "Replies (2)", exact: true });
      if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
      const row = result.locator(".conversation-result-replies button").first();
      await expect(row.locator(".conversation-source")).not.toBeEmpty();
      const rows = await result.locator(".conversation-result-replies button").evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect();
        const source = node.querySelector(".conversation-source").getBoundingClientRect();
        const excerpt = node.querySelector(".conversation-result-reply-excerpt").getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right,
          sourceTop: source.top, sourceBottom: source.bottom, sourceLeft: source.left,
          excerptTop: excerpt.top, excerptBottom: excerpt.bottom, excerptLeft: excerpt.left,
          align: getComputedStyle(node).textAlign };
      }));
      for (const item of rows) {
        expect(item.align).toBe("left");
        expect(item.sourceTop).toBeGreaterThanOrEqual(item.top + 4);
        expect(item.sourceBottom).toBeLessThanOrEqual(item.excerptTop);
        expect(item.excerptBottom).toBeLessThanOrEqual(item.bottom - 4);
        expect(item.sourceLeft - item.left).toBeLessThanOrEqual(12);
        expect(item.excerptLeft).toBe(item.sourceLeft);
      }
      expect(rows[0].bottom).toBeLessThan(rows[1].top);
      if (origin === "Feedback") {
        await row.focus();
        await page.screenshot({ path: info.outputPath(`reply-picker-${theme}-${width}.png`), animations: "disabled", caret: "initial" });
      }
      await row.scrollIntoViewIfNeeded();
      const originTop = await inventory.evaluate(node => node.scrollTop);
      await row.click();
      const navigation = page.getByRole("navigation", { name: "Reply navigation" });
      await expect(navigation.getByRole("status")).toHaveText("1 of 2");
      await expect(tabs).toBeVisible();
      await expect(tabs.getByRole("button", { name: origin, exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(navigation.getByRole("button", { name: "Previous reply", exact: true })).toBeDisabled();
      if (!draftCreated) {
        await firstCard.getByRole("button", { name: "Reply", exact: true }).click();
        const draft = firstCard.getByRole("textbox", { name: "Reply", exact: true });
        await draft.fill("Preserve my follow-up");
        await firstCard.getByRole("checkbox", { name: "Request a change" }).check();
        await draft.evaluate(node => {
          window.replyNavigationDraft = node;
          node.focus(); node.setSelectionRange(2, 7); node.dispatchEvent(new Event("select", { bubbles: true }));
        });
        draftCreated = true;
      }
      await navigation.getByRole("button", { name: "Next reply", exact: true }).click();
      await expect(navigation.getByRole("status")).toHaveText("2 of 2");
      await expect(navigation.getByRole("button", { name: "Next reply", exact: true })).toBeDisabled();
      await navigation.getByRole("button", { name: "Previous reply", exact: true }).click();
      await expect(navigation.getByRole("status")).toHaveText("1 of 2");
      const draft = firstCard.getByRole("textbox", { name: "Reply", exact: true });
      await expect(draft).toHaveValue("Preserve my follow-up");
      const saveBounds = await firstCard.getByRole("button", { name: "Add reply", exact: true }).boundingBox();
      expect(saveBounds.y + saveBounds.height).toBeLessThanOrEqual(height);
      await expect(firstCard.getByRole("checkbox", { name: "Request a change" })).toBeChecked();
      expect(await draft.evaluate(node => [node === window.replyNavigationDraft, node.selectionStart, node.selectionEnd])).toEqual([true, 2, 7]);
      await firstCard.locator(".conversation-transcript").evaluate(node => { node.scrollTop = node.scrollHeight; });
      const tail = await firstCard.locator(".conversation-response .conversation-body").evaluate(node => {
        const text = node.lastChild, range = document.createRange();
        range.setStart(text, text.textContent.length - "Final answer line.".length); range.setEnd(text, text.textContent.length);
        const rect = range.getBoundingClientRect(), container = node.closest(".conversation-transcript").getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, containerTop: container.top, containerBottom: container.bottom };
      });
      expect(tail.top).toBeGreaterThanOrEqual(tail.containerTop - 1);
      expect(tail.bottom).toBeLessThanOrEqual(tail.containerBottom + 1);
      await expect(navigation.getByRole("button", { name: "Back to replies", exact: true })).toBeInViewport();
      if (origin === "Feedback") await page.screenshot({ path: info.outputPath(`reader-${theme}-${width}.png`), animations: "disabled", caret: "initial" });
      await navigation.getByRole("button", { name: "Back to replies", exact: true }).click();
      await expect(row).toBeFocused();
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      await expect(tabs.getByRole("button", { name: origin, exact: true })).toHaveAttribute("aria-pressed", "true");
      expect(Math.abs(await inventory.evaluate(node => node.scrollTop) - originTop)).toBeLessThanOrEqual(1);
    }
  }
});

test("invalid comparison modes remain explicit and retry keeps the result summary", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "invalid-result-mode.html", "<p>Comparison target</p>"));
  await waitForSdk(page);
  await sendPending(review, ref, { body: "Update the paragraph", intent: "request-change" });
  await handled(review, ref, { overallOutcome: "applied", resultNote: "Reported change; comparison validation stays independent." });
  await feedback(page);
  await page.getByRole("region", { name: "Latest submission result" }).getByRole("button", { name: "View changes" }).click();
  const changes = page.getByRole("region", { name: "Saved comparison" });
  await page.route("**/api/conversation/comparison", route => route.fulfill({ json: {
    available: false, mode: "content", reason: "Wrong mode", changes: [], limitations: [],
  } }));
  await changes.getByRole("button", { name: "Source", exact: true }).click();
  await expect(changes.getByRole("alert")).toContainText("Invalid comparison response");
  await expect(changes.locator(".conversation-result-body")).toHaveText("Reported change; comparison validation stays independent.");
  await page.unroute("**/api/conversation/comparison");
  await changes.getByRole("button", { name: "Retry comparison" }).click();
  await expect(changes.getByText("Invalid comparison response", { exact: false })).toHaveCount(0);
  await expect(changes.locator(".comparison-surface")).toContainText("Comparison target");
  await expect(changes.locator(".conversation-result-body")).toHaveText("Reported change; comparison validation stays independent.");
});

test("header History preserves mounted reply/note permissions and full results without technical clutter", async ({ page, review }) => {
  const file = writeFile(review, "history-disclosure.html", "<p id='copy'>A preserved source</p>");
  const ref = await openReview(page, review, file);
  await waitForSdk(page);
  const { threadId } = await seedThread(review, ref, "Explain the passage");
  await feedback(page);
  await page.locator("#send").click();
  await expect(page.getByRole("status", { name: "Waiting for agent", exact: true })).toBeVisible();
  await handled(review, ref, { resultNote: "The complete reply-only result stays available from History and View changes. ".repeat(12) });
  const card = page.locator(`[data-thread="${threadId}"]`);
  await expect(card.locator(".conversation-response")).toBeVisible();
  await card.getByRole("button", { name: "Reply", exact: true }).click();
  const reply = card.getByRole("textbox", { name: "Reply", exact: true, includeHidden: true });
  await reply.fill("Retain this unsent reply");
  await reply.evaluate(node => { window.historyReply = node; node.setSelectionRange(3, 7); node.dispatchEvent(new Event("select", { bubbles: true })); });
  await card.getByRole("checkbox", { name: "Request a change" }).check();
  await feedback(page);
  await page.getByRole("button", { name: /Note to agent/ }).click();
  const note = page.getByRole("textbox", { name: "Note to agent", exact: true, includeHidden: true });
  await note.fill("A separate note");
  await note.evaluate(node => { window.historyNote = node; });
  await expect(page.getByRole("region", { name: "Submission history" })).toHaveCount(0);
  const history = page.getByRole("button", { name: "History", exact: true });
  await history.focus(); await history.press("Enter");
  await expect(page.getByRole("region", { name: "Submission history" })).toBeVisible();
  await expect(reply).toBeHidden(); await expect(note).toBeHidden();
  expect(await reply.evaluate(node => node === window.historyReply)).toBe(true);
  expect(await note.evaluate(node => node === window.historyNote)).toBe(true);
  await page.locator(".conversation-submission > summary").click();
  await expect(page.locator(".conversation-submission")).toContainText("The complete reply-only result");
  expect(await page.getByRole("region", { name: "Submission history" }).textContent())
    .not.toMatch(/Receipt details|Agent command|Technical details|review_|submission_|doc-review poll/);
  await page.setViewportSize({ width: 720, height: 480 });
  const inventory = page.locator(".conversation-inventory");
  await expect.poll(() => inventory.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThanOrEqual(100);
  await inventory.evaluate(node => { node.scrollTop = 100; });
  await expect.poll(() => inventory.evaluate(node => node.scrollTop)).toBe(100);
  await page.getByRole("button", { name: "Close feedback", exact: true }).click();
  await page.locator("#commentsButton").click();
  await expect(page.getByRole("region", { name: "Submission history" })).toBeVisible();
  await expect.poll(() => inventory.evaluate(node => node.scrollTop)).toBe(100);
  await page.getByRole("group", { name: "Feedback destination" }).getByRole("button", { name: "Feedback", exact: true }).click();
  await expect(reply).toBeVisible(); await expect(note).toHaveValue("A separate note");
  expect(await reply.evaluate(node => [node === window.historyReply, node.selectionStart, node.selectionEnd])).toEqual([true, 3, 7]);
  await expect(card.getByRole("checkbox", { name: "Request a change" })).toBeChecked();
  await expect(page.locator('[data-composer="note"]').getByRole("checkbox", { name: "Request a change" })).not.toBeChecked();
  await expect(page.locator("#send")).toHaveText("Send to agent (1)");
  expect(fs.readFileSync(file, "utf8")).toBe("<p id='copy'>A preserved source</p>");
});

test("deferred source-pending edits retain complete evidence and selected Send identity without implying a source change", async ({ page, review }, info) => {
  const file = writeFile(review, "deferred-result.html", "<p>Original source</p>");
  const ref = await openReview(page, review, file);
  await waitForSdk(page);
  const before = fs.readFileSync(file, "utf8");
  await mutate(review, ref, "record-edit", { pageKey: ref.key, content: {
    label: "Recorded paragraph", kind: "edited", before: "Original source", after: "Proposed wording",
    before_html: "<p>Original source</p>", after_html: "<p>Proposed wording</p>",
    truncated: false, truncated_fields: [], staged_assets: [],
  } });
  await feedback(page);
  const edits = page.locator(".conversation-edits");
  await feedback(page);
  await expect(edits).toContainText("Source pending");
  await expect(edits.getByRole("checkbox")).toHaveCount(0);
  await expect(page.locator("#send")).toHaveText("Send to agent (1)");
  await edits.getByText("Exact edit details", { exact: true }).click();
  await expect(edits.locator("pre").first()).toContainText("<p>Proposed wording</p>");
  await edits.getByText("Exact edit details", { exact: true }).click();
  await page.screenshot({ path: info.outputPath("source-pending-before-send.png") });
  await page.locator("#send").click(); await expect(page.getByRole("status", { name: "Waiting for agent", exact: true })).toBeVisible();
  const { work } = await handled(review, ref, { resultNote: "Deferred the recorded paragraph pending clarification." });
  expect(work.edits).toHaveLength(1); expect(work.edits[0].source.state).toBe("pending");
  const peek = page.getByRole("region", { name: "Latest submission result" });
  await peek.getByRole("button", { name: "View response" }).click();
  const changes = page.getByRole("region", { name: "Saved comparison" });
  await expect(changes).toContainText("Source pending at Send");
  await expect(changes).toContainText("Deferred; no application reported for this edit.");
  await expect(changes.locator(".conversation-result-body")).toHaveText("Deferred the recorded paragraph pending clarification.");
  await expect(changes.locator(".comparison-surface")).toHaveCount(0);
  await expect(changes.getByRole("group", { name: "Comparison tools" })).toHaveCount(0);
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  const refs = (await listed(review, ref, "comparisons", { submissionId: work.submissionId })).items;
  expect(refs.every(item => item.resultRevisionId === null)).toBe(true);
});

for (const destination of ["Source", "Back to review"]) test(`late explicit capture preserves ${destination} rather than restoring its old comparison`, async ({ page, review }) => {
  const file = writeFile(review, `capture-selection-${destination.replaceAll(" ", "-")}.html`, "<p id='copy'>Before agent work</p>");
  const ref = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await feedback(page);
  await feedback(page);
  await page.getByRole("button", { name: /Note to agent/ }).click();
  await page.locator("#draft-note").fill("Update this paragraph.");
  await page.locator('[data-composer="note"]').getByRole("checkbox", { name: "Request a change" }).check();
  await page.locator("#send").click(); await expect(page.getByRole("status", { name: "Waiting for agent", exact: true })).toBeVisible();
  let retry = false, release, captured = false;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/api/conversation/capture", async route => {
    if (!retry) return route.fulfill({ status: 503, json: { error: "Capture deliberately unavailable" } });
    captured = true; await gate; await route.continue();
  });
  try {
    fs.writeFileSync(file, "<p id='copy'>Actual agent work</p>");
    await expect(frame.locator("#copy")).toHaveText("Actual agent work"); await waitForSdk(page);
    const { work } = await handled(review, ref, { overallOutcome: "applied", resultNote: "Updated the paragraph; capture is independent." });
    await expect(page.getByRole("region", { name: "Latest submission result" })).toContainText("Capture deliberately unavailable");
    await page.getByRole("region", { name: "Latest submission result" }).getByRole("button", { name: "View changes" }).click();
    const changes = page.getByRole("region", { name: "Saved comparison" });
    await expect(changes.locator(".conversation-result-body")).toHaveText("Updated the paragraph; capture is independent.");
    await expect(changes.getByRole("alert")).toContainText("Capture deliberately unavailable");
    retry = true;
    await changes.getByRole("button", { name: "Capture current content" }).click();
    await expect.poll(() => captured).toBe(true);
    await changes.getByRole("button", { name: destination, exact: true }).click();
    release();
    await expect.poll(async () => (await reviewApi(review, "/api/conversation/comparison", { method: "POST", body: {
      reviewId: ref.reviewId, entryKey: ref.entryKey, submissionId: work.submissionId, pageKey: ref.key, mode: "content",
    } })).json().available).toBe(true);
    if (destination === "Source") {
      await expect(changes.getByRole("button", { name: "Source", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(changes.locator(".comparison-surface")).toContainText("Actual agent work");
    } else await expect(changes).toBeHidden();
    expect(fs.readFileSync(file, "utf8")).toBe("<p id='copy'>Actual agent work</p>");
  } finally { release(); }
});
