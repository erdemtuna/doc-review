import fs from "node:fs";
import { test, expect, openReview, waitForSdk, writeFile, feedback, enterEditMode, selectText, selectReviewMode,
  listed, conversation, handled, seedThread, reviewApi, mutate } from "./helpers.js";
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

test("UX baseline: automatic/manual capture overlap preserves the immutable result but leaves a stale warning", async ({ page, review }, info) => {
  test.setTimeout(60_000);
  const file = writeFile(review, "capture-overlap-baseline.html", "<p id='copy'>Before overlap</p>");
  const ref = await openReview(page, review, file);
  await waitForSdk(page); await feedback(page);
  await page.locator("#draft-note").fill("Update this paragraph.");
  await page.locator('[data-composer="note"]').getByRole("checkbox", { name: "Request a change" }).check();
  await page.locator("#send").click();
  await expect(page.getByText("Queued; not received")).toBeVisible();
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
    entry.status = response.status(); entry.response = await response.json();
    await route.fulfill({ response });
  });
  try {
    fs.writeFileSync(file, "<p id='copy'>After overlap</p>");
    await expect(page.frameLocator("#frame").locator("#copy")).toHaveText("After overlap");
    await waitForSdk(page);
    const { work } = await handled(review, ref, { overallOutcome: "applied", resultNote: "Deterministic fixture response; not live-agent reasoning." });
    await expect.poll(() => captures.length).toBe(1);
    await page.getByRole("region", { name: "Latest submission result" }).getByRole("button", { name: "View in Changes" }).click();
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
    await expect.poll(() => captures.length).toBe(2);
    await expect.poll(() => captures[1].status).toBe(200);
    const comparison = async () => (await reviewApi(review, "/api/conversation/comparison", { method: "POST", body: {
      reviewId: ref.reviewId, entryKey: ref.entryKey, submissionId: work.submissionId, pageKey: ref.key, mode: "content",
    } })).json();
    const ready = await comparison();
    expect(ready.available).toBe(true);
    const endpoint = (await listed(review, ref, "comparisons", { submissionId: work.submissionId })).items[0].resultRevisionId;
    release();
    await expect.poll(() => captures[0].status).toBe(409);
    expect(captures[0].response.error).toMatchObject({ code: "VERSION_CONFLICT", status: 409, retryable: false });
    await expect(page.locator(".conversation-notice")).toContainText("Rendered result endpoint is already immutable");
    expect(await comparison()).toEqual(ready);
    expect((await listed(review, ref, "comparisons", { submissionId: work.submissionId })).items[0].resultRevisionId).toBe(endpoint);
    expect(captures[0].body.submissionId).toBe(captures[1].body.submissionId);
    expect(captures[0].body.pageKey).toBe(captures[1].body.pageKey);
    await page.screenshot({ path: info.outputPath("overlap-stale-warning-baseline.png") });
    fs.writeFileSync(info.outputPath("capture-overlap-baseline.json"), JSON.stringify({
      classification: "Known baseline defect, not desired behavior; no production reconciliation implemented",
      order: "automatic POST held; manual POST succeeds; automatic POST released and conflicts",
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
  const edits = page.locator(".conversation-edits");
  await expect(edits).toContainText("Already saved");
  await expect(edits.locator(".conversation-edit-preview")).toContainText("Original human wording");
  await expect(edits.locator(".conversation-edit-preview")).toContainText("Exact human wording");
  const include = edits.getByRole("checkbox");
  await include.uncheck();
  await expect(page.locator("#send")).toBeDisabled();
  await include.check();
  await page.locator("#draft-note").fill("Please update the agent target only.");
  await page.locator('[data-composer="note"]').getByRole("checkbox", { name: "Request a change" }).check();
  await page.locator("#send").click();
  await expect(page.getByText("Queued; not received")).toBeVisible();
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
  await peek.getByRole("button", { name: "View in Changes" }).click();
  const changes = page.getByRole("region", { name: "Saved comparison" });
  await expect(changes.getByRole("region", { name: "Full submission result note" })).toContainText("Updated the agent target.");
  await expect(changes).toContainText("Saved by you before Send; no additional agent edit reported.");
  await expect.poll(async () => (await listed(review, ref, "history")).items[0].comparisonStatus).toBe("ready");
  if (await changes.getByRole("button", { name: "Refresh comparison" }).count()) await changes.getByRole("button", { name: "Refresh comparison" }).click();
  await expect(changes.locator(".comparison-surface")).toContainText("Actual agent result");
  expect(await changes.locator(".comparison-current").textContent()).not.toContain("Exact human wording");
  await changes.getByRole("button", { name: "Close comparison" }).click();
  await page.getByRole("button", { name: "New message", exact: true }).click();
  const draft = page.locator("#draft-new");
  await draft.fill("Keep exact IME draft");
  await draft.evaluate(node => { window.resultDraft = node; node.setSelectionRange(3, 8); node.dispatchEvent(new Event("select", { bubbles: true }));
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
  await peek.getByRole("button", { name: "View in Changes" }).click();
  await changes.getByRole("button", { name: "Source", exact: true }).click();
  await expect(changes.locator(".comparison-surface")).toContainText("Actual agent result");
  await changes.getByRole("button", { name: "Close comparison" }).click();
  expect(await draft.evaluate(node => [node === window.resultDraft, node.selectionStart, node.selectionEnd])).toEqual([true, 3, 8]);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await draft.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await draft.press("Escape");
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
    const button = peek.getByRole("button", { name: "View in Changes" });
    await button.click();
    const body = changes.locator(".conversation-result-body");
    const requiredBody = await readableTextHeight(body);
    expect(requiredBody).toBeGreaterThan(0);
    await expect.poll(() => visibleTextHeight(body)).toBeGreaterThanOrEqual(requiredBody);
    measurements.push({ width, height, theme, preview: previewHeight, requiredPreview, requiredBody, body: await visibleTextHeight(body), panel: await changes.boundingBox() });
    await page.screenshot({ path: info.outputPath(`result-${theme}-${width}x${height}.png`) });
    await changes.getByRole("button", { name: "Close comparison" }).click();
  }
  fs.writeFileSync(info.outputPath("result-readability.json"), JSON.stringify(measurements, null, 2));
  await page.locator("#endReview").click(); await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await peek.getByRole("button", { name: "View in Changes" }).click();
  await expect(changes.locator(".conversation-result-body")).toContainText("Updated the agent target.");
});

test("reply-only results keep their notes without fabricated captures and invalid response modes stay explicit", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "reply-result.html", "<p>Unchanged source</p>"));
  await waitForSdk(page); await seedThread(review, ref, "Please explain");
  await feedback(page); await expect(page.locator("#send")).toBeEnabled(); await page.locator("#send").click();
  await expect(page.getByText("Queued; not received")).toBeVisible();
  await handled(review, ref, { resultNote: "Explanation only; no edits were made." });
  const peek = page.getByRole("region", { name: "Latest submission result" });
  await peek.getByRole("button", { name: "View in Changes" }).click();
  const changes = page.getByRole("region", { name: "Saved comparison" });
  await expect(changes.locator(".conversation-result-body")).toHaveText("Explanation only; no edits were made.");
  await expect(changes.getByRole("region", { name: "Comparison availability" })).toContainText("No new source changes reported");
  await expect(changes.locator(".comparison-surface")).toHaveCount(0);
  const history = (await listed(review, ref, "history")).items[0];
  const references = (await listed(review, ref, "comparisons", { submissionId: history.submissionId })).items;
  expect(references.every(item => item.resultRevisionId === null)).toBe(true);
  await page.route("**/api/conversation/comparison", route => route.fulfill({ json: {
    available: false, mode: "content", reason: "Wrong mode", changes: [], limitations: [],
  } }));
  await changes.getByRole("button", { name: "Source", exact: true }).click();
  await expect(changes.getByRole("alert")).toContainText("Invalid comparison response");
  await expect(changes.locator(".conversation-result-body")).toHaveText("Explanation only; no edits were made.");
  await page.unroute("**/api/conversation/comparison");
  await changes.getByRole("button", { name: "Retry comparison" }).click();
  await expect(changes.getByRole("alert")).toHaveCount(0);
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
  await expect(edits).toContainText("Source pending");
  const checkbox = edits.getByRole("checkbox", { name: "Include Recorded paragraph in Send" });
  await expect(checkbox).toHaveAttribute("data-slot", "checkbox");
  await checkbox.uncheck(); await expect(page.locator("#send")).toBeDisabled();
  await checkbox.check(); await expect(page.locator("#send")).toHaveText("Send (1)");
  await edits.getByText("Exact edit details", { exact: true }).click();
  await expect(edits.locator("pre").first()).toContainText("<p>Proposed wording</p>");
  await edits.getByText("Exact edit details", { exact: true }).click();
  await page.screenshot({ path: info.outputPath("source-pending-before-send.png") });
  await page.locator("#send").click(); await expect(page.getByText("Queued; not received")).toBeVisible();
  const { work } = await handled(review, ref, { resultNote: "Deferred the recorded paragraph pending clarification." });
  expect(work.edits).toHaveLength(1); expect(work.edits[0].source.state).toBe("pending");
  const peek = page.getByRole("region", { name: "Latest submission result" });
  await peek.getByRole("button", { name: "View in Changes" }).click();
  const changes = page.getByRole("region", { name: "Saved comparison" });
  await expect(changes).toContainText("Source pending at Send");
  await expect(changes).toContainText("Deferred; no application reported for this edit.");
  await expect(changes.locator(".conversation-result-body")).toHaveText("Deferred the recorded paragraph pending clarification.");
  await expect(changes.locator(".comparison-surface")).toHaveCount(0);
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  const refs = (await listed(review, ref, "comparisons", { submissionId: work.submissionId })).items;
  expect(refs.every(item => item.resultRevisionId === null)).toBe(true);
});

for (const destination of ["Source", "Close comparison"]) test(`late explicit capture preserves ${destination} rather than restoring its old comparison`, async ({ page, review }) => {
  const file = writeFile(review, `capture-selection-${destination.replaceAll(" ", "-")}.html`, "<p id='copy'>Before agent work</p>");
  const ref = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await feedback(page);
  await page.locator("#draft-note").fill("Update this paragraph.");
  await page.locator('[data-composer="note"]').getByRole("checkbox", { name: "Request a change" }).check();
  await page.locator("#send").click(); await expect(page.getByText("Queued; not received")).toBeVisible();
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
    await expect(page.locator(".conversation-notice")).toContainText("Capture deliberately unavailable");
    await page.getByRole("region", { name: "Latest submission result" }).getByRole("button", { name: "View in Changes" }).click();
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
