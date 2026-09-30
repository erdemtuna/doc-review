import fs from "node:fs";
import { test, expect, openReview, waitForSdk, writeFile, feedback, overallNote, seedThread, sendPending, handled, mutate, listed, conversation } from "./helpers.js";

test("real diff comes first; long Markdown, summaries, metadata and plain drafts remain readable", async ({ page, review }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const file = writeFile(review, "diff-first.html", "<p id='human'>Original human</p><p id='agent'>Original agent</p>");
  const ref = await openReview(page, review, file);
  await waitForSdk(page);
  const edited = await mutate(review, ref, "record-edit", { pageKey: ref.key, content: {
    label: "Human paragraph", kind: "edited", before: "Original human", after: "Saved human",
    before_html: "<p id='human'>Original human</p>", after_html: "<p id='human'>Saved human</p>",
    truncated: false, truncated_fields: [], staged_assets: [],
  } });
  await mutate(review, ref, "save-edit", { pageKey: ref.key, editId: edited.value.editId, editVersion: 1,
    expectedSourceHash: (await conversation(review, ref, "read-page", { pageKey: ref.key })).page.sourceHash,
    html: "<p id='human'>Saved human</p><p id='agent'>Original agent</p>" });
  await page.reload(); await waitForSdk(page);
  await expect(page.frameLocator("#frame").locator("#human")).toHaveText("Saved human");
  await waitForSdk(page);
  await seedThread(review, ref, "**Question**\n\n- Explain the edit.", { kind: "element", anchor: { selector: "#agent", label: "Agent passage" } });
  await feedback(page);
  await expect(page.locator("#send")).toHaveText("Send to agent (2)");
  await (await overallNote(page)).fill("Change only the agent passage.");
  await page.locator('[data-composer="note"]').getByRole("checkbox", { name: "Request a change" }).check();
  await page.locator("#send").click();
  await expect(page.getByRole("status", { name: "Waiting for agent", exact: true })).toBeVisible();
  const work = (await conversation(review, ref, "poll")).submission;
  fs.writeFileSync(file, "<p id='human'>Saved human</p><p id='agent'>Changed agent</p>");
  await expect(page.frameLocator("#frame").locator("#agent")).toHaveText("Changed agent");
  const summary = "**Changed the agent passage.** " + "Long orientation sentence. ".repeat(100);
  const prose = "## Answer\n\n" + "Readable explanation. ".repeat(1000) +
    "\n\n- One\n  - Nested\n\n```text\n" + "long-token".repeat(100) + "\n```\n\n| Key | Value |\n| --- | --- |\n| a | b |\n\n![No image](https://tracker.invalid/pixel)\n\n<svg onload='alert(1)'></svg>\n\n[safe](https://example.com) [unsafe](javascript:alert%281%29)";
  const requests = [];
  page.on("request", request => { if (request.url().includes("tracker.invalid")) requests.push(request.url()); });
  await handled(review, ref, {
    summary, resultNote: "Independent full batch answer.", overallOutcome: "applied",
    responses: work.messages.map(({ message }) => ({ threadId: message.threadId, messageId: message.messageId,
      messageVersion: message.version, body: prose, outcome: "answered" })),
  });
  await expect.poll(async () => (await listed(review, ref, "history")).items[0].comparisonStatus).toBe("ready");
  const peek = page.getByRole("region", { name: "Latest submission result" });
  await expect(peek.getByRole("button", { name: "Read more", exact: true })).toBeVisible();
  await peek.getByRole("button", { name: "View changes" }).click();
  const comparison = page.getByRole("region", { name: "Saved comparison" });
  await expect(comparison.locator(".comparison-current")).toContainText("Changed agent");
  const box = await comparison.locator(".comparison-current").boundingBox();
  expect(box.y).toBeLessThan(700);
  expect(await comparison.evaluate(node => node.scrollTop)).toBe(0);
  expect((await comparison.locator(".conversation-result-preview").boundingBox()).height).toBeLessThanOrEqual(80);
  await expect(comparison.locator(".conversation-result-body")).toBeHidden();
  await expect(comparison.getByRole("region", { name: "Your submitted edits" })).toBeHidden();
  await page.screenshot({ path: info.outputPath("diff-first-1280x800.png") });
  await comparison.getByText("Full agent response", { exact: true }).click();
  await expect(comparison.locator(".conversation-result-body")).toHaveText("Independent full batch answer.");
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(comparison.getByRole("button", { name: "Back to review" })).toBeInViewport();
  await expect(comparison.getByRole("group", { name: "Comparison tools" })).toBeInViewport();
  await page.screenshot({ path: info.outputPath("diff-first-200-percent.png") });
  await page.evaluate(() => { document.documentElement.style.zoom = ""; });
  await comparison.getByRole("button", { name: "Back to review" }).click();
  await page.locator(".conversation-inventory").evaluate(node => { node.scrollTop = 0; });
  const card = page.locator(".conversation-thread");
  await expect(card.locator(".conversation-response .message-markdown strong")).toHaveCount(0);
  await expect(card.locator(".conversation-response h4")).toHaveText("Answer");
  await expect(card.locator(".conversation-response .message-markdown").locator("img, svg, script")).toHaveCount(0);
  expect(requests).toEqual([]);
  const link = card.getByRole("link", { name: "safe", exact: true });
  await expect(link).toHaveAttribute("target", "_blank");
  const status = await card.locator(".conversation-response .conversation-status-icon").boundingBox();
  const meta = await card.locator(".conversation-response .conversation-meta").boundingBox();
  expect(Math.abs(status.x + status.width - meta.x - meta.width)).toBeLessThanOrEqual(1);
  const filters = page.locator(".conversation-filter-buttons button");
  for (const control of await filters.all()) expect((await control.boundingBox()).height).toBe(32);
  for (const control of await page.getByRole("group", { name: "Feedback destination" }).getByRole("button").all()) expect((await control.boundingBox()).height).toBe(32);
  for (const width of [380, 390, 640]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await card.locator(".message-markdown").last().evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  }
  await card.getByRole("button", { name: "Reply", exact: true }).click();
  const draft = card.getByRole("textbox", { name: "Reply", exact: true });
  await draft.fill("**Keep literal Markdown**\n\n- Plain editor");
  await expect(draft).toHaveValue("**Keep literal Markdown**\n\n- Plain editor");
  await draft.press("Enter");
  await card.getByRole("button", { name: "Edit message", exact: true }).click();
  await expect(card.getByRole("textbox", { name: "Edit message", exact: true })).toHaveValue("**Keep literal Markdown**\n\n- Plain editor");
  await page.screenshot({ path: info.outputPath("markdown-reading.png") });
});

test("deferred and abandoned edits survive history paging, reload and End without becoming Send candidates", async ({ page, review }) => {
  test.setTimeout(90_000);
  const ref = await openReview(page, review, writeFile(review, "attention.html", "<p>Original</p>"));
  await waitForSdk(page);
  const content = { label: "Manual edit", kind: "edited", before: "Original", after: "Replacement",
    truncated: false, truncated_fields: [], staged_assets: [] };
  await mutate(review, ref, "record-edit", { pageKey: ref.key, content });
  await sendPending(review, ref);
  const { work } = await handled(review, ref);
  await mutate(review, ref, "record-edit", { pageKey: ref.key, content: { ...content, label: "Abandoned edit" } });
  await sendPending(review, ref);
  const abandoned = (await conversation(review, ref, "poll")).submission;
  await mutate(review, ref, "abandon", { expectedVersion: abandoned.version, submissionId: abandoned.submissionId,
    confirmExternalWorkMayContinue: true, reason: "**Check source** before continuing." });
  for (let i = 0; i < 51; i++) {
    await sendPending(review, ref, { body: `Independent note ${i}`, intent: "discuss" });
    await handled(review, ref);
  }
  await page.reload(); await waitForSdk(page); await feedback(page);
  await expect(page.locator("#toolbarCount")).toHaveText("0 open");
  await expect(page.getByLabel("2 manual edits awaiting handling", { exact: true })).toHaveText("2 edits");
  await expect(page.locator("#send")).toBeDisabled();
  const edits = page.getByRole("region", { name: "Your edits", exact: true });
  await expect(edits).toContainText("Deferred; needs follow-up");
  await expect(edits).toContainText("Abandoned; inspect the source");
  await expect(edits.locator("strong").filter({ hasText: "Check source" })).toBeVisible();
  await edits.locator("li").filter({ hasText: "Deferred; needs follow-up" }).getByRole("button", { name: "Original submission" }).click();
  await expect(page.locator(`#submission-${work.submissionId}`)).toHaveAttribute("open", "");
  await expect(page.locator(`#submission-${work.submissionId} > summary`)).toBeFocused();
  await mutate(review, ref, "end", { confirmUnsentReadOnly: true });
  await page.reload(); await waitForSdk(page); await feedback(page);
  await expect(page.getByLabel("2 manual edits awaiting handling", { exact: true })).toBeVisible();
  await expect(page.locator("#send")).toBeDisabled();
  expect((await listed(review, ref, "edits")).totalCount).toBe(0);
  expect((await listed(review, ref, "edit-attention")).totalCount).toBe(2);
});
