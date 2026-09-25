import fs from "node:fs";
import http from "node:http";
import { selectChoice } from "./choice-helpers.js";
import { test, expect, openReview, reviewApi, waitForSdk, writeFile, feedback, submissionHistory, overallNote, enterEditMode, conversation, handled, listed, intercept, failure, selectText, mutate, selectReviewMode } from "./helpers.js";

async function sendNote(page, text = "Refine this source", change = true) {
  await feedback(page);
  await overallNote(page);
  const note = page.locator('[data-composer="note"]');
  await note.getByRole("textbox").fill(text);
  await note.getByLabel("Request a change").setChecked(change);
  await page.locator("#send").click();
  await expect(page.getByText("Queued; not received", { exact: true })).toBeVisible({ timeout: 10000 });
}
async function compare(review, ref, submissionId, mode = "content") {
  const result = await reviewApi(review, "/api/conversation/comparison", { method: "POST", body: {
    reviewId: ref.reviewId, entryKey: ref.entryKey, submissionId, pageKey: ref.key, mode,
  } });
  expect(result.status, result.raw).toBe(200); return result.json();
}
async function openComparison(page, mode = "Content") {
  await submissionHistory(page);
  const submission = page.locator(".conversation-submission").first();
  if (!await submission.evaluate(node => node.open)) await submission.locator(":scope > summary").click();
  await page.locator(".conversation-submission").first().getByRole("button", { name: `${mode} changes` }).first().click();
  const region = page.getByRole("region", { name: "Saved comparison" });
  await expect(region.getByRole("status")).toHaveCount(0); return region;
}
async function setup(page, review, name) {
  const file = writeFile(review, name, "<!doctype html><p id='copy'>Before result</p><details id='details'><summary>Details</summary>Open state</details>");
  const ref = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  return { file, ref, frame };
}
async function complete(page, review, ref, file) {
  fs.writeFileSync(file, "<!doctype html><p id='copy'>After result</p>");
  await expect(page.frameLocator("#frame").locator("#copy")).toHaveText("After result");
  await waitForSdk(page);
  return handled(review, ref, { overallOutcome: "applied", resultNote: "Updated the requested source." });
}

test("multi-page partial history never recaptures an already immutable current-page Content endpoint", async ({ page, review }) => {
  const { file, ref } = await setup(page, review, "multi-history.html");
  const other = writeFile(review, "uncaptured-page.html", "<p>Other source without browser capture</p>");
  const joined = await mutate(review, ref, "join-page", { target: other });
  await mutate(review, ref, "create-thread", { pageKey: joined.value.pageKey, target: { kind: "selection", anchor: { quote: "Other source" } }, body: "Discuss the other page", intent: "discuss" });
  await sendNote(page);
  const work = (await conversation(review, ref, "poll")).submission;
  expect(work.pageKeys).toHaveLength(2);
  await complete(page, review, ref, file);
  await expect.poll(async () => (await compare(review, ref, work.submissionId)).available).toBe(true);
  const before = (await listed(review, ref, "comparisons", { submissionId: work.submissionId })).items;
  expect((await listed(review, ref, "history")).items[0].comparisonStatus).toBe("partial");
  const attempts = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/conversation/capture") && request.postDataJSON().submissionId === work.submissionId) attempts.push(request);
  });
  await page.reload(); await waitForSdk(page); await feedback(page);
  await submissionHistory(page);
  await page.locator(".conversation-submission").first().locator(":scope > summary").click();
  await page.locator(".conversation-submission").getByRole("button", { name: "Content changes" }).first().click();
  await selectChoice(page, "historyTarget", ref.key);
  await expect(page.getByRole("region", { name: "Saved comparison" })).toContainText("After result");
  await expect(page.getByText(/already immutable/)).toHaveCount(0);
  expect(attempts).toHaveLength(0);
  expect((await listed(review, ref, "comparisons", { submissionId: work.submissionId })).items).toEqual(before);
});

for (const kind of ["html", "markdown", "scripted", "live"]) {
  test(`${kind} real Send and complete response freeze Content and true Source across restart`, async ({ page, review }) => {
    let text = "Before result", upstream;
    const source = () => kind === "markdown" ? `${text}\n` : `<!doctype html><p id='copy'>${text}</p>${kind === "scripted" || kind === "live" ? "<script>document.querySelector('p').append(' in browser')</script>" : ""}`;
    let target;
    if (kind === "live") {
      upstream = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(source()); });
      await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
      target = `http://127.0.0.1:${upstream.address().port}/review`;
    } else target = writeFile(review, `real-history.${kind === "markdown" ? "md" : "html"}`, source());
    try {
      const ref = await openReview(page, review, target);
      await waitForSdk(page); await sendNote(page);
      const work = (await conversation(review, ref, "poll")).submission;
      text = "After result";
      if (kind === "live") { await page.reload(); await waitForSdk(page); await feedback(page); }
      else fs.writeFileSync(target, source());
      await expect(page.frameLocator("#frame").locator("p").first()).toContainText("After result");
      await waitForSdk(page);
      await handled(review, ref, { overallOutcome: "applied", resultNote: "True source updated." });
      await expect.poll(async () => (await compare(review, ref, work.submissionId)).available).toBe(true);
      const value = await compare(review, ref, work.submissionId);
      const content = JSON.stringify(value);
      expect(content).toContain("Before result"); expect(content).toContain("After result");
      const sourceValue = await compare(review, ref, work.submissionId, "source");
      expect(sourceValue.available).toBe(kind !== "live");
      const rows = (await listed(review, ref, "comparisons", { submissionId: work.submissionId })).items;
      const result = rows[0].resultRevisionId;
      expect(review.store.revisions.readSemantic(result).blocks.map((block) => block.text).join(" ")).toContain("After result");
      await review.restart(); await page.reload(); await waitForSdk(page);
      expect(await compare(review, ref, work.submissionId, "source")).toEqual(sourceValue);
      const region = await openComparison(page);
      await expect(region).toContainText("After result");
    } finally { if (upstream) { upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); } }
  });
}

test("comparison leaves interactive document, new-message draft and selection mounted at narrow width", async ({ page, review }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const { ref, frame } = await setup(page, review, "history-draft.html");
  await frame.locator("#details summary").click(); await sendNote(page, "Explain", false);
  await handled(review, ref);
  await page.getByRole("button", { name: "New message", exact: true }).click();
  const input = page.getByRole("textbox", { name: "New message", exact: true });
  await input.fill("Unsent draft"); await input.evaluate((element) => { window.historyDraft = element; element.setSelectionRange(2, 7); element.dispatchEvent(new Event("select", { bubbles: true })); });
  const region = await openComparison(page);
  await expect(region).toContainText("No new source changes reported");
  await region.getByRole("button", { name: "Close comparison" }).click();
  await feedback(page);
  expect(await input.evaluate((element) => element === window.historyDraft)).toBe(true);
  expect(await input.evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual([2, 7]);
  await expect(frame.locator("#details")).toHaveAttribute("open", "");
  expect((await conversation(review, ref, "status")).pendingMessageCount).toBe(0);
});

test("Send waits for the exact source-save acceptance and verification before baseline capture", async ({ page, review }) => {
  const { file, ref, frame } = await setup(page, review, "save-barrier.html");
  let release, returned = false, captured = false;
  const gate = new Promise((resolve) => { release = resolve; });
  await intercept(page, "save-edit", async (route) => { const response = await route.fetch(); await gate; returned = true; await route.fulfill({ response }); });
  await page.route("**/api/conversation/capture", async (route) => { expect(returned).toBe(true); captured = true; await route.continue(); });
  await enterEditMode(page); await frame.locator("#copy").click(); await selectText(frame, "#copy"); await page.keyboard.insertText("Saved before Send");
  await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("Saved before Send");
  await feedback(page); await page.getByRole("button", { name: /Overall note \(optional\)/ }).click();
  await page.getByRole("textbox", { name: "Overall note" }).fill("Check");
  await expect(page.locator("#send")).toBeDisabled();
  expect((await conversation(review, ref, "status")).work).toBeNull(); expect(captured).toBe(false);
  release(); await page.locator("#send").click();
  await expect(page.getByText("Queued; not received", { exact: true })).toBeVisible();
  const work = (await conversation(review, ref, "poll")).submission;
  expect(work.edits[0].source.state).toBe("saved");
  const baseline = (await listed(review, ref, "comparisons", { submissionId: work.submissionId })).items[0].baselineRevisionId;
  expect(review.store.revisions.readSemantic(baseline).blocks[0].text).toBe("Saved before Send");
});

for (const fault of ["error", "deadline", "wrong-identity"]) {
  test(`optional baseline ${fault} sends once without accepting a late or uncorrelated snapshot`, async ({ page, review }) => {
    await page.addInitScript((fault) => {
      if (window === parent) return;
      window.addEventListener("message", (event) => {
        if (event.data?.type !== "eh:captureSnapshot") return;
        event.stopImmediatePropagation();
        if (fault === "error") parent.postMessage({ ...event.data, type: "eh:snapshot", error: "Capture unavailable" }, "*");
        else setTimeout(() => parent.postMessage({ ...event.data, type: "eh:snapshot",
          ...(fault === "wrong-identity" ? { generation: event.data.generation + 1 } : {}),
          capturedAt: Date.now(), snapshot: { version: 1, blocks: [], limitations: [] } }, "*"), fault === "deadline" ? 7000 : 0);
      }, true);
    }, fault);
    const { ref } = await setup(page, review, `optional-${fault}.html`);
    let sends = 0; await intercept(page, "send", async (route) => { sends++; await route.continue(); });
    await sendNote(page);
    await expect(page.getByText(/Comparison baseline unavailable/)).toBeVisible();
    await page.waitForTimeout(2100); expect(sends).toBe(1);
    const work = (await conversation(review, ref, "poll")).submission;
    const baseline = (await listed(review, ref, "comparisons", { submissionId: work.submissionId })).items[0].baselineRevisionId;
    expect(review.store.revisions.get(baseline).semantic).toBeUndefined();
  });
}

test("accepted Send remains accepted when its history refresh fails", async ({ page, review }) => {
  const { ref } = await setup(page, review, "history-refresh.html");
  let accepted = false, sends = 0;
  await page.route("**/api/conversation", async (route) => {
    const body = route.request().postDataJSON();
    if (body.operation === "send") { sends++; const response = await route.fetch(); accepted = true; return route.fulfill({ response }); }
    if (accepted && body.operation === "list" && body.scope.collection === "history") return failure(route, "History offline");
    await route.continue();
  });
  await feedback(page); await page.getByRole("button", { name: /Overall note \(optional\)/ }).click();
  const note = page.getByRole("textbox", { name: "Overall note" }); await note.fill("One accepted note");
  await page.locator("#send").click();
  await expect(page.getByRole("alert")).toContainText(/accepted|refresh|History offline/i);
  await expect(note).toHaveValue(""); expect(sends).toBe(1);
  expect((await conversation(review, ref, "status")).work.state).toBe("queued");
});

test("reply-only response creates neither a result capture nor a fake source version or reload", async ({ page, review }) => {
  const { file, ref, frame } = await setup(page, review, "reply-only.html");
  const bytes = fs.readFileSync(file); await sendNote(page, "Explain only", false);
  const render = await page.locator("#frame").getAttribute("src");
  let captures = 0; await page.route("**/api/conversation/capture", async (route) => { captures++; await route.continue(); });
  const { work } = await handled(review, ref);
  await expect(page.getByRole("region", { name: "Latest submission result" }).getByText("Answered without changing source.", { exact: true })).toBeVisible();
  expect(captures).toBe(0); expect(fs.readFileSync(file)).toEqual(bytes);
  expect(await page.locator("#frame").getAttribute("src")).toBe(render);
  expect((await compare(review, ref, work.submissionId)).available).toBe(false);
  await expect(frame.locator("#copy")).toHaveText("Before result");
});

test("result capture failure does not undo handling; explicit recovery stays nonmodal and preserves source snapshot", async ({ page, review }) => {
  const { file, ref } = await setup(page, review, "capture-retry.html");
  await sendNote(page);
  let fail = true, attempts = 0;
  await page.route("**/api/conversation/capture", async (route) => {
    attempts++; if (fail) return failure(route, "Capture temporarily unavailable", "VERSION_CONFLICT");
    await route.continue();
  });
  const { work } = await complete(page, review, ref, file);
  await expect(page.getByText(/Result capture unavailable:/)).toBeVisible();
  expect((await conversation(review, ref, "submission", { submissionId: work.submissionId })).submission.state).toBe("handled");
  const source = await compare(review, ref, work.submissionId, "source");
  await page.waitForTimeout(200); expect(attempts).toBe(1);
  fail = false;
  await page.getByRole("region", { name: "Latest submission result" }).getByRole("button", { name: "View result" }).click();
  await page.getByRole("button", { name: "Capture current content" }).click();
  await expect.poll(async () => (await compare(review, ref, work.submissionId)).available).toBe(true);
  expect((await compare(review, ref, work.submissionId, "source")).sourceHash).toBe(source.sourceHash);
  expect((await compare(review, ref, work.submissionId, "source")).afterCapturedAt).toBe(source.afterCapturedAt);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("two real observers may request compatible captures but cannot rewrite immutable Source", async ({ page, context, review }) => {
  const { file, ref } = await setup(page, review, "two-captures.html");
  const other = await context.newPage(); await other.goto(page.url()); await waitForSdk(other);
  await sendNote(page); const { work } = await complete(page, review, ref, file);
  await expect.poll(async () => (await compare(review, ref, work.submissionId)).available).toBe(true);
  const source = await compare(review, ref, work.submissionId, "source");
  fs.writeFileSync(file, "<p id='copy'>Still newer source</p>");
  await expect(page.frameLocator("#frame").locator("#copy")).toHaveText("Still newer source");
  expect(await compare(review, ref, work.submissionId, "source")).toEqual(source);
  await other.close();
});

test("clean Edit to View requires no fake source work; changed source causes a visible conflict", async ({ page, review }) => {
  const { file, ref, frame } = await setup(page, review, "clean-view.html");
  await enterEditMode(page); await selectReviewMode(page, "View");
  await expect(frame.locator("body")).not.toHaveAttribute("contenteditable");
  expect((await listed(review, ref, "edits")).items).toHaveLength(0);
  await enterEditMode(page);
  await intercept(page, "save-edit", (route) => failure(route, "Source changed; reload it", "VERSION_CONFLICT"));
  await frame.locator("#copy").click(); await page.keyboard.press("End"); await page.keyboard.insertText(" local");
  await expect(page.getByRole("alert")).toContainText(/Source changed/);
  expect(fs.readFileSync(file, "utf8")).not.toContain("local");
  expect((await listed(review, ref, "edits")).items).toHaveLength(1);
});

test("strict flush rejects stale and uncorrelated acknowledgements instead of dispatching", async ({ page, review }) => {
  await page.addInitScript(() => {
    if (window === parent) return;
    window.addEventListener("message", (event) => {
      if (event.data?.type !== "eh:flush") return;
      event.stopImmediatePropagation();
      parent.postMessage({ ...event.data, type: "eh:flushed", generation: event.data.generation + 1 }, "*");
      parent.postMessage({ ...event.data, type: "eh:flushed", requestId: "unrelated" }, "*");
    }, true);
  });
  const { ref } = await setup(page, review, "strict-flush.html");
  await feedback(page); await page.getByRole("button", { name: /Overall note \(optional\)/ }).click();
  await page.getByRole("textbox", { name: "Overall note" }).fill("Do not lose this");
  await page.locator("#send").click();
  await expect(page.getByRole("alert")).toContainText(/flush|respond|save|page/i, { timeout: 10000 });
  expect((await conversation(review, ref, "status")).work).toBeNull();
  await expect(page.getByRole("textbox", { name: "Overall note" })).toHaveValue("Do not lose this");
});

test("two immutable completed submissions keep different baselines and comparisons after later work", async ({ page, review }) => {
  const { file, ref } = await setup(page, review, "two-submissions.html");
  const saved = [];
  for (const after of ["First result", "Second result"]) {
    await sendNote(page);
    fs.writeFileSync(file, `<p id='copy'>${after}</p>`);
    await expect(page.frameLocator("#frame").locator("#copy")).toHaveText(after); await waitForSdk(page);
    const { work } = await handled(review, ref, { overallOutcome: "applied" });
    await expect.poll(async () => (await compare(review, ref, work.submissionId)).available).toBe(true);
    saved.push({ id: work.submissionId, source: await compare(review, ref, work.submissionId, "source") });
  }
  expect(saved[0].source.baselineRevisionId).not.toBe(saved[1].source.baselineRevisionId);
  for (const item of saved) expect(await compare(review, ref, item.id, "source")).toEqual(item.source);
  await expect(page.locator(".conversation-submission")).toHaveCount(2);
});
