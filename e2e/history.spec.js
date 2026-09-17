import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test, expect, enterEditMode, openReview, reviewApi, waitForSdk, writeFile } from "./helpers.js";

test("Latest version remains interactive across a read-only history switch at 320px", async ({ page, review }) => {
  const file = writeFile(review, "history.html", `<!doctype html><h1>Review me</h1>
    <details id="action"><summary>Open details</summary><p>Still open</p></details>`);
  await page.setViewportSize({ width: 320, height: 740 });
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await frame.locator("#action summary").click();
  await expect(frame.locator("#action")).toHaveAttribute("open", "");
  await page.locator("#seeChanges").click();
  await expect(page.locator("#historyPanel")).toBeVisible();
  await expect(page.locator("#modeButton")).toBeHidden();
  await expect(page.locator("#commentsButton")).toBeHidden();
  await expect(page.locator("#latestVersion")).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const latest = await page.locator("#latestVersion").boundingBox();
  const changes = await page.locator("#seeChanges").boundingBox();
  expect(latest.x + latest.width).toBeLessThanOrEqual(changes.x);
  expect(changes.x + changes.width).toBeLessThanOrEqual(320);
  await page.locator("#latestVersion").click();
  await expect(page.locator("#historyPanel")).toBeHidden();
  await expect(page.locator("#modeButton")).toBeEnabled();
  await expect(frame.locator("#action")).toHaveAttribute("open", "");
});

test("an open comment draft survives Compare and remains excluded from Send", async ({ page, review }) => {
  const file = writeFile(review, "draft-history.html", '<!doctype html><p id="copy">Keep this draft</p>');
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await frame.locator("#copy").evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild, 0);
    range.setEnd(element.firstChild, element.firstChild.nodeValue.length);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await frame.locator("#commentAction").click();
  await page.locator("#composeText").fill("Unsent draft");
  await page.locator("#seeChanges").click();
  await expect(page.locator("#compose")).toBeHidden();
  await page.locator("#latestVersion").click();
  await expect(page.locator("#composeText")).toHaveValue("Unsent draft");
  await expect(page.locator("#toolbarCount")).toHaveText("0");
  await page.locator("#commentsButton").click();
  await expect(page.locator("#draftWarning")).toContainText("1 open draft is not included");
  fs.writeFileSync(file, '<!doctype html><p id="copy">New agent result</p>');
  await expect(page.locator("#reloadNotice")).toBeVisible();
  await expect(frame.locator("#copy")).toHaveText("Keep this draft");
  await page.locator("#safeReload").click();
  await expect(frame.locator("#copy")).toHaveText("New agent result");
  await expect(page.locator("#composeText")).toHaveValue("Unsent draft");
  await expect(page.locator("#composeQuote")).toHaveText("Keep this draft");
  await expect(page.locator("#composeError")).toContainText("original excerpt");
});

test("comparison exposes textual counts, removed excerpts and keyboard-friendly navigation", async ({ page, review }) => {
  const round = {
    id: "round-example", number: 1, status: "completed", acknowledgedAt: 1700000000000,
    targets: [{
      key: "saved-page", filename: "example.html", status: "completed",
      comparison: { availableModes: ["content"], content: {
        counts: { added: 0, modified: 1, removed: 1, total: 2 },
        viewComparison: { status: "unverified", message: "Visible content only; matching view not verified." },
        beforeCapturedAt: 1699999900000, afterCapturedAt: 1700000030000, changes: [
        { kind: "modified", label: "Heading", before: "Before title", after: "After title", segments: [{ value: "Before", removed: true }, { value: "After", added: true }, { value: " title" }] },
        { kind: "removed", label: "Old paragraph", before: "Deleted excerpt", after: "" },
      ] } },
    }],
  };
  await page.route("**/api/session/*/history**", async (route) => {
    const url = new URL(route.request().url());
    const json = url.pathname.endsWith("/compare")
      ? url.searchParams.get("mode") === "content" ? { available: true, ...round.targets[0].comparison.content } : { available: false, changes: [] }
      : url.pathname.endsWith("/history") ? { rounds: [round] } : { round };
    await route.fulfill({ json });
  });
  await openReview(page, review, writeFile(review, "compare.html", "<!doctype html><p>Latest live page</p>"));
  await waitForSdk(page);
  await page.locator("#seeChanges").click();
  await expect(page.locator("#historyCounts")).toHaveText("0 Added · 1 Modified · 1 Removed");
  await expect(page.locator("#changeDetail")).toContainText("Before title");
  await expect(page.locator("#changeDetail del").first()).toHaveText("Before");
  await expect(page.locator("#changeDetail ins")).toHaveText("After");
  await page.locator("#historyDiagnostics > summary").click();
  await expect(page.locator("#historyTiming")).toContainText("Agent acknowledged");
  await expect(page.locator("#historyTiming")).not.toContainText("Not available");
  await expect(page.locator("#historyCaptureDelay")).toContainText("30 seconds after acknowledgment");
  await expect(page.locator("#comparisonModes")).not.toContainText("Source");
  await expect(page.locator("#historyViewCoverage")).toBeVisible();
  await expect(page.locator("#historyViewCoverage")).toContainText("matching view not verified");
  await page.locator("#nextChange").click();
  await expect(page.locator("#changeDetail")).toContainText("Deleted excerpt");
  await expect(page.locator('.comparison-before .comparison-block[title*="no target"]')).toContainText("Deleted excerpt");
  await expect(page.locator("#previousChange")).toBeEnabled();
});

test("Send waits for the HTML save response before accepting a baseline capture", async ({ page, review }) => {
  let saveReturned = false;
  let sentBody = null;
  await page.route("**/api/page/*/save", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.renderId).toBeTruthy();
    expect(body.sessionId).toBeTruthy();
    expect(body.generation).toBeGreaterThan(0);
    expect(body.baseHash).toBeTruthy();
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 300));
    saveReturned = true;
    await route.fulfill({ response });
  });
  await page.route("**/api/page/*/send", async (route) => {
    expect(saveReturned).toBe(true);
    sentBody = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/session/*/history", (route) => route.fulfill({ json: { rounds: [] } }));
  await openReview(page, review, writeFile(review, "save-barrier.html", '<!doctype html><p id="copy">Before</p>'));
  const frame = await enterEditMode(page);
  // This fixture implements the SDK capture envelope to isolate the parent save barrier.
  await frame.locator("body").evaluate(() => {
    window.addEventListener("message", (event) => {
      if (event.data?.type !== "eh:captureSnapshot") return;
      const text = document.querySelector("#copy").textContent;
      parent.postMessage({
        ...event.data, type: "eh:snapshot", capturedAt: Date.now(),
        snapshot: { version: 1, blocks: [{ id: "copy", selector: "#copy", tag: "p", text, attributes: {}, path: [], runs: [{ text, marks: [] }] }], limitations: [] },
      }, "*");
    });
  });
  await frame.locator("#copy").evaluate((element) => {
    element.textContent = "Saved before Send";
    element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await page.locator("#commentsButton").click();
  await page.locator("#note").fill("Please review");
  await page.locator("#send").click();
  await expect(page.locator("#frame")).toHaveAttribute("inert", "");
  await expect.poll(() => sentBody).not.toBeNull();
  await expect(page.locator("#frame")).not.toHaveAttribute("inert", "");
  expect(sentBody.history.semantic.blocks.some((block) => block.text === "Saved before Send")).toBe(true);
  expect(sentBody.history.expectedSourceHash).toBeTruthy();
  expect(sentBody.history.semanticCapturedAt).toBeGreaterThan(0);
  expect(sentBody.history.allowUnavailable).toBe(true);
});

test("optional capture failure sends feedback once without an override gate", async ({ page, review }) => {
  let sentBody;
  let deliveries = 0;
  await page.route("**/api/session/*/history", (route) => route.fulfill({ json: { rounds: [] } }));
  await page.route("**/api/page/*/send", async (route) => {
    sentBody = route.request().postDataJSON();
    deliveries += 1;
    await route.fulfill({ json: { ok: true } });
  });
  await openReview(page, review, writeFile(review, "capture-failure.html", "<!doctype html><p>Still loading</p>"));
  const frame = await waitForSdk(page);
  await frame.locator("body").evaluate(() => {
    window.addEventListener("message", (event) => {
      if (event.data?.type === "eh:captureSnapshot") {
        parent.postMessage({ ...event.data, type: "eh:snapshot", error: "The page is still changing" }, "*");
      }
    });
  });
  await page.locator("#commentsButton").click();
  await page.locator("#note").fill("Keep this feedback");
  await page.locator("#send").click();
  await expect.poll(() => sentBody?.history.allowUnavailable).toBe(true);
  expect(sentBody.note).toBe("Keep this feedback");
  expect(sentBody.history.semantic).toBeNull();
  await expect(page.locator("#note")).toHaveValue("");
  await expect(page.locator("#captureWarning")).toBeHidden();
  await expect(page.locator("#sendWithoutComparison")).toBeHidden();
  expect(deliveries).toBe(1);
});

test("a missed optional capture deadline still sends once and ignores a late snapshot", async ({ page, review }) => {
  await page.addInitScript(() => {
    if (window === parent) return;
    window.addEventListener("message", (event) => {
      if (event.data?.type !== "eh:captureSnapshot") return;
      event.stopImmediatePropagation();
      setTimeout(() => parent.postMessage({
        ...event.data, type: "eh:snapshot", capturedAt: Date.now(),
        snapshot: { version: 1, blocks: [], limitations: [] },
      }, "*"), 900);
    }, true);
  });
  const deliveries = [];
  await page.route("**/api/page/*/send", async (route) => {
    deliveries.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  await openReview(page, review, writeFile(review, "capture-budget.html", "<!doctype html><p>Ready for feedback</p>"));
  await waitForSdk(page);
  await page.locator("#commentsButton").click();
  await page.locator("#note").fill("Do not wait for optional history");
  await page.locator("#send").click();
  await expect(page.locator("#note")).toHaveValue("", { timeout: 2000 });
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0].history).toMatchObject({ allowUnavailable: true, semantic: null });
  await page.waitForTimeout(1000);
  expect(deliveries).toHaveLength(1);
  await expect(page.locator("#frame")).not.toHaveAttribute("inert", "");
});

test("history refresh failure after successful Send cannot turn delivery into a retry", async ({ page, review }) => {
  let delivered = false;
  let sends = 0;
  await page.route("**/api/session/*/history", (route) => route.fulfill(delivered
    ? { status: 503, json: { error: "History refresh unavailable" } }
    : { json: { rounds: [] } }));
  await page.route("**/api/page/*/send", async (route) => {
    sends += 1;
    delivered = true;
    await route.fulfill({ json: { ok: true } });
  });
  await openReview(page, review, writeFile(review, "delivered-history-error.html", "<!doctype html><p>Send this review</p>"));
  await waitForSdk(page);
  await page.locator("#commentsButton").click();
  await page.locator("#note").fill("Delivered exactly once");
  await page.locator("#send").click();
  await expect(page.locator("#note")).toHaveValue("");
  await expect(page.locator("#send")).toBeDisabled();
  await page.locator("#seeChanges").click();
  await expect(page.locator("#historyError")).toContainText("History refresh unavailable");
  await page.locator("#latestVersion").click();
  await expect(page.locator("#note")).toHaveValue("");
  expect(sends).toBe(1);
});

test("Capture result remains nonmodal and manual recovery does not override a competing lease", async ({ page, review }) => {
  let round;
  let manual;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/session/*/history**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/capture")) {
      const body = route.request().postDataJSON();
      if (!body.manual) return route.fulfill({ status: 409, json: { error: "Another review window owns capture", code: "history_capture_owner" } });
      manual = body;
      await gate;
      return route.fulfill({ status: 409, json: { error: "Another capture is already running", code: "history_capture_conflict" } });
    }
    return route.fulfill({ json: pathname.endsWith("/history") ? { rounds: round ? [round] : [] }
      : pathname.endsWith("/compare") ? { available: false, changes: [], reason: "Waiting for result" } : { round } });
  });
  const session = await openReview(page, review, writeFile(review, "manual-lease.html",
    '<!doctype html><details id="interactive"><summary>Open rollout details</summary><p>Available while capturing</p></details>'));
  const frame = await waitForSdk(page);
  round = { roundId: "other-window-round", feedbackStatus: "acknowledged", targets: [{ key: session.key, capture: { status: "pending" } }] };
  await page.locator("#seeChanges").click();
  await expect(page.locator("#historyError")).toContainText("Another review window owns capture");
  await page.locator("#captureResult").click();
  try {
    await expect.poll(() => manual).toBeTruthy();
    await page.locator("#latestVersion").click();
    await expect(page.locator("#frame")).not.toHaveAttribute("inert", "");
    await frame.locator("#interactive summary").click();
    await expect(frame.locator("#interactive")).toHaveAttribute("open", "");
    expect(manual).toMatchObject({ manual: true, sessionId: session.sessionId, renderId: expect.any(String), generation: expect.any(Number) });
  } finally {
    release();
  }
  await page.locator("#seeChanges").click();
  await expect(page.locator("#historyError")).toContainText("Another capture is already running");
  await expect(page.locator("#captureResult")).toBeEnabled();
  await expect(page.locator("#finishCapture")).toBeHidden();
});

test("an acknowledged unchanged frame captures a result without reloading the document", async ({ page, review }) => {
  const file = writeFile(review, "unchanged-result.html", '<!doctype html><p id="copy">Unchanged result</p>');
  const session = await openReview(page, review, file);
  await waitForSdk(page);
  const before = await page.locator("#frame").getAttribute("src");
  await page.locator("#commentsButton").click();
  await page.locator("#note").fill("Reviewed without source changes");
  await page.locator("#send").click();
  await expect(page.locator("#note")).toHaveValue("");
  const batch = (await reviewApi(review, `/api/poll?target=${encodeURIComponent(file)}`)).json();
  const acknowledged = await fetch(`http://127.0.0.1:${review.port}/api/poll?target=${encodeURIComponent(file)}&ack=${encodeURIComponent(batch.batch_id)}`, {
    headers: { "x-doc-review-token": review.token },
  });
  await acknowledged.body.cancel();
  let round;
  await expect.poll(async () => {
    round = (await reviewApi(review, `/api/session/${session.sessionId}/history`)).json().rounds[0];
    return round?.targets[0]?.resultRevisionId;
  }, { timeout: 10000 }).toBeTruthy();
  expect(await page.locator("#frame").getAttribute("src")).toBe(before);
  expect(round.feedbackStatus).toBe("acknowledged");
  const result = review.store.revisions.readSemantic(round.targets[0].resultRevisionId);
  expect(result.blocks.some((block) => block.text === "Unchanged result")).toBe(true);
});

test("manual capture from a second review cannot steal a real active capture lease", async ({ page, review }) => {
  const file = writeFile(review, "capture-owner.html", "<!doctype html><p>Shared review result</p>");
  const owner = await openReview(page, review, file);
  await waitForSdk(page);
  let automatic;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/session/*/history/*/capture", async (route) => {
    automatic = route.request().postDataJSON();
    await gate;
    await route.fulfill({ status: 409, json: { error: "Capture lease test completed", code: "history_capture_conflict" } });
  });
  await page.locator("#commentsButton").click();
  await page.locator("#note").fill("Compare this shared review");
  await page.locator("#send").click();
  await expect(page.locator("#note")).toHaveValue("");
  const batch = (await reviewApi(review, `/api/poll?target=${encodeURIComponent(file)}`)).json();
  const other = await page.context().newPage();
  try {
    await openReview(other, review, file);
    await waitForSdk(other);
    const acknowledged = await fetch(`http://127.0.0.1:${review.port}/api/poll?target=${encodeURIComponent(file)}&ack=${encodeURIComponent(batch.batch_id)}`, {
      headers: { "x-doc-review-token": review.token },
    });
    await acknowledged.body.cancel();
    await expect.poll(() => automatic).toBeTruthy();
    const round = (await reviewApi(review, `/api/session/${owner.sessionId}/history`)).json().rounds[0];
    review.store.claimCapture(owner.key, round.roundId, owner.key, { ownerSessionId: owner.sessionId, generation: automatic.generation });
    await other.locator("#seeChanges").click();
    await expect(other.locator("#captureResult")).toBeEnabled();
    const responsePromise = other.waitForResponse((response) =>
      response.url().endsWith("/capture") && response.request().postDataJSON()?.manual === true);
    await other.locator("#captureResult").click();
    const response = await responsePromise;
    expect(response.status()).toBe(409);
    await expect(other.locator("#historyError")).toContainText(/capture|lease/i);
    const retained = (await reviewApi(review, `/api/session/${owner.sessionId}/history`)).json().rounds[0].targets[0];
    expect(retained.capture.status).toBe("running");
    expect(retained.capture.ownerSessionId).toBe(owner.sessionId);
    expect(retained.resultRevisionId).toBeNull();
  } finally {
    release();
    await other.close();
  }
});

test("transient result capture retries at 1, 2 and 4 seconds, then waits for explicit recovery", async ({ page, review }) => {
  test.setTimeout(30000);
  await page.addInitScript(() => {
    if (window === parent) return;
    window.addEventListener("message", (event) => {
      if (event.data?.type !== "eh:captureSnapshot") return;
      event.stopImmediatePropagation();
      parent.postMessage({
        ...event.data, type: "eh:snapshot",
        error: { code: "CAPTURE_UNSTABLE", message: "Result is still changing" },
      }, "*");
    }, true);
  });
  const attempts = [];
  let round;
  await page.route("**/api/session/*/history**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/capture")) {
      attempts.push({ at: Date.now(), ...route.request().postDataJSON() });
      round.targets[0].capture.status = "failed";
      return route.fulfill({ json: { ok: false, round } });
    }
    return route.fulfill({ json: pathname.endsWith("/history") ? { rounds: round ? [round] : [] }
      : pathname.endsWith("/compare") ? { available: false, counts: null, changes: [], reason: "Not captured" } : { round } });
  });
  const session = await openReview(page, review, writeFile(review, "bounded-retries.html", '<!doctype html><p id="copy">Changing result</p>'));
  const frame = await waitForSdk(page);
  round = { roundId: "bounded-result", feedbackStatus: "acknowledged", targets: [{ key: session.key, capture: { status: "pending" } }] };
  await page.locator("#seeChanges").click();
  await expect.poll(() => attempts.length, { timeout: 15000 }).toBe(4);
  for (const [index, delay] of [1000, 2000, 4000].entries()) {
    const elapsed = attempts[index + 1].at - attempts[index].at;
    expect(elapsed).toBeGreaterThanOrEqual(delay - 100);
    expect(elapsed).toBeLessThan(delay + 2000);
  }
  expect(attempts.every((attempt) => attempt.manual === false)).toBe(true);
  await frame.locator("#copy").evaluate((element) => { element.append(" Ordinary mutation is not readiness"); });
  await page.waitForTimeout(1500);
  expect(attempts).toHaveLength(4);
  await page.locator("#captureResult").click();
  await expect.poll(() => attempts.length).toBe(5);
  expect(attempts.at(-1).manual).toBe(true);
});

test("a limited comparison is unavailable, not a successful zero-change result", async ({ page, review }) => {
  const round = { roundId: "limited-round", captureStatus: "ready", targets: [{ key: "limited-page", resultRevisionId: "result" }] };
  await page.route("**/api/session/*/history**", async (route) => {
    const url = new URL(route.request().url());
    const json = url.pathname.endsWith("/compare")
      ? { available: false, status: "limited", changes: [], counts: null, reason: "Comparison exceeds processing limits.", limitations: ["comparison-limit:characters"] }
      : url.pathname.endsWith("/history") ? { rounds: [round] } : { round };
    await route.fulfill({ json });
  });
  await openReview(page, review, writeFile(review, "limited.html", "<!doctype html><p>Latest page</p>"));
  await page.locator("#seeChanges").click();
  await expect(page.locator("#historyCounts")).toBeHidden();
  await expect(page.locator("#historyStatus")).toHaveAttribute("data-state", "partial");
  await expect(page.locator("#changeDetail")).not.toContainText("No changes detected");
  await page.locator("#historyDiagnostics > summary").click();
  await expect(page.locator("#historyUnavailable")).toContainText("processing limits");
  await page.locator("#historyLimitations summary").click();
  await expect(page.locator("#historyLimitationsList")).toContainText("comparison limit:characters");
});

test("manual SDK capture failures are persisted as retryable round diagnostics", async ({ page, review }) => {
  await page.addInitScript(() => {
    if (window === parent) return;
    window.addEventListener("message", (event) => {
      if (event.data?.type !== "eh:captureSnapshot") return;
      event.stopImmediatePropagation();
      parent.postMessage({ ...event.data, type: "eh:snapshot", error: "Result is still changing" }, "*");
    }, true);
  });
  let round = null;
  let diagnostic = null;
  await page.route("**/api/session/*/history**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/capture")) {
      diagnostic = route.request().postDataJSON();
      round.targets[0].capture.status = "failed";
      await route.fulfill({ json: { ok: false, round } });
      return;
    }
    await route.fulfill({ json: path.endsWith("/compare")
      ? { available: false, changes: [], reason: "Result not captured" }
      : path.endsWith("/history") ? { rounds: round ? [round] : [] } : { round } });
  });
  const session = await openReview(page, review, writeFile(review, "capture-diagnostic.html", "<!doctype html><p>Pending result</p>"));
  await waitForSdk(page);
  round = { roundId: "retryable", createdAt: Date.now(), feedbackStatus: "acknowledged", targets: [{ key: session.key, capture: { status: "pending" } }] };
  await page.locator("#seeChanges").click();
  await expect.poll(() => diagnostic?.manual).toBe(false);
  await page.locator("#captureResult").click();
  await expect.poll(() => diagnostic?.manual).toBe(true);
  await expect.poll(() => diagnostic?.error).toBe("Result is still changing");
  expect(diagnostic.manual).toBe(true);
  expect(diagnostic.renderId).toBeTruthy();
  expect(diagnostic.generation).toBeGreaterThan(0);
  await expect(page.locator("#historyStatus")).toHaveAttribute("data-state", "failed");
  await expect(page.locator("#captureResult")).toBeEnabled();
});

test("Compare prefers completed history and retains Content limits while Source is available", async ({ page, review }) => {
  const pending = { roundId: "new-pending", ordinal: 2, captureStatus: "pending", feedbackStatus: "acknowledged",
    targets: [{ key: "source-page", sourceResultRevisionId: "source-result", capture: { status: "running" } }] };
  const completed = { roundId: "older-completed", ordinal: 1, captureStatus: "ready", targets: [{ key: "source-page", resultRevisionId: "result" }] };
  await page.route("**/api/session/*/history**", async (route) => {
    const url = new URL(route.request().url());
    const json = url.pathname.endsWith("/compare")
      ? url.searchParams.get("mode") === "source"
        ? { available: true, status: "complete", changes: [], counts: { added: 0, modified: 0, removed: 0, total: 0 } }
        : { available: false, status: "limited", changes: [], counts: null, reason: "Content exceeded processing limits." }
      : url.pathname.endsWith("/history") ? { rounds: [pending, completed] }
        : { round: url.pathname.endsWith("older-completed") ? completed : pending };
    await route.fulfill({ json });
  });
  await openReview(page, review, writeFile(review, "source-fallback.html", "<!doctype html><p>Latest content</p>"));
  await page.locator("#seeChanges").click();
  await expect(page.locator("#roundPicker")).toHaveValue("older-completed");
  await expect(page.locator("#comparisonModes")).toHaveText("Source");
  await page.locator("#historyDiagnostics > summary").click();
  await expect(page.locator("#historyUnavailable")).toContainText("Content exceeded processing limits");
  await expect(page.locator("#historyCounts")).toHaveText("0 Added · 0 Modified · 0 Removed");
  await expect(page.locator("#changeDetail")).toHaveText("No changes detected in this comparison format.");
  await page.locator("#roundPicker").selectOption("new-pending");
  await expect(page.locator("#historyStatus")).toHaveText("Source available. Content is pending or unavailable.");
  await expect(page.locator("#comparisonModes")).toHaveText("Source");
});

test("an inactive failed target can finish with Source snapshots without contacting the SDK", async ({ page, review }) => {
  let request = null;
  const round = { roundId: "inactive-round", feedbackStatus: "acknowledged", captureStatus: "failed",
    targets: [{ key: "inactive-page", filename: "other.html", sourceResultRevisionId: "source-after", capture: { status: "failed" } }] };
  await page.route("**/api/session/*/history**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/capture")) {
      request = route.request().postDataJSON();
      round.targets[0].capture.status = "unavailable";
      round.completedAt = Date.now();
      await route.fulfill({ json: { ok: true, round } });
      return;
    }
    await route.fulfill({ json: url.pathname.endsWith("/compare")
      ? url.searchParams.get("mode") === "source" ? { available: true, changes: [] } : { available: false, changes: [], reason: "No Content snapshot" }
      : url.pathname.endsWith("/history") ? { rounds: [round] } : { round } });
  });
  await openReview(page, review, writeFile(review, "active-page.html", "<!doctype html><p>Different active page</p>"));
  await page.locator("#seeChanges").click();
  await expect(page.locator("#captureResult")).toBeDisabled();
  await page.locator("#historyDiagnostics > summary").click();
  await expect(page.locator("#finishCaptureHelp")).toContainText("does not invent a result");
  await page.locator("#finishCapture").click();
  await expect.poll(() => request).toEqual({ key: "inactive-page", manual: true, finalUnavailable: true });
  await expect(page.locator("#finishCapture")).toBeHidden();
  await expect(page.locator("#captureResult")).toBeHidden();
  await expect(page.locator("#historyStatus")).toHaveText("Source available. Content is pending or unavailable.");
  await expect(page.locator("#comparisonModes")).toHaveText("Source");
});

test("real Send and acknowledged result produce a durable automatic Content comparison", async ({ page, review }) => {
  const file = writeFile(review, "real-history.html", '<!doctype html><p id="copy">Before result</p>');
  const session = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await page.locator("#commentsButton").click();
  await page.locator("#note").fill("Please update the paragraph");
  await page.locator("#send").click();
  await expect(page.locator("#note")).toHaveValue("");
  const delivered = await reviewApi(review, `/api/poll?target=${encodeURIComponent(file)}`);
  expect(delivered.status, delivered.raw).toBe(200);
  const batch = delivered.json();
  expect(batch.batch_id).toBeTruthy();
  fs.writeFileSync(file, '<!doctype html><p id="copy">After result</p>');
  await expect(frame.locator("#copy")).toHaveText("After result");
  await waitForSdk(page);
  const acknowledged = await fetch(`http://127.0.0.1:${review.port}/api/poll?target=${encodeURIComponent(file)}&ack=${encodeURIComponent(batch.batch_id)}`, {
    headers: { "x-doc-review-token": review.token },
  });
  await acknowledged.body.cancel();
  let round;
  await expect.poll(async () => {
    const response = await reviewApi(review, `/api/session/${session.sessionId}/history`);
    round = response.json().rounds[0];
    return round?.targets[0]?.resultRevisionId;
  }, { timeout: 10000 }).toBeTruthy();
  expect(round.feedbackStatus).toBe("acknowledged");
  await page.locator("#seeChanges").click();
  await expect(page.locator("#comparisonModes")).toContainText("Content");
  await expect(page.locator("#changeDetail")).toContainText("Before result");
  await expect(page.locator("#changeDetail")).toContainText("After result");
  await expect(page.locator("#historyTiming")).not.toContainText("Not available");
  await page.reload();
  await waitForSdk(page);
  await page.locator("#seeChanges").click();
  await expect(page.locator("#roundPicker")).toHaveValue(round.roundId);
  await expect(page.locator("#changeDetail")).toContainText("After result");
});

for (const kind of ["markdown", "live"]) {
  test(`${kind} review captures real browser content across an acknowledged round`, async ({ page, review }) => {
    let text = "Before result";
    let upstream;
    let target;
    if (kind === "live") {
      upstream = http.createServer((_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(`<!doctype html><p>${text}</p><script>document.querySelector('p').append(' in browser');</script>`);
      });
      await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
      target = `http://127.0.0.1:${upstream.address().port}/review`;
    } else target = writeFile(review, "markdown-history.md", `${text}\n`);
    try {
      const session = await openReview(page, review, target);
      const frame = await waitForSdk(page);
      const suffix = kind === "live" ? " in browser" : "";
      await expect(frame.locator("p")).toHaveText(`Before result${suffix}`);
      await page.locator("#commentsButton").click();
      await page.locator("#note").fill("Improve the content");
      await page.locator("#send").click();
      await expect(page.locator("#note")).toHaveValue("");
      const delivered = await reviewApi(review, `/api/poll?target=${encodeURIComponent(target)}`);
      expect(delivered.status, delivered.raw).toBe(200);
      text = "After result";
      if (kind === "markdown") {
        fs.writeFileSync(target, `${text}\n`);
        await expect(frame.locator("p")).toHaveText(text);
        await waitForSdk(page);
      } else {
        await page.reload();
        await waitForSdk(page);
        await expect(frame.locator("p")).toHaveText(`${text}${suffix}`);
      }
      const acknowledged = await fetch(
        `http://127.0.0.1:${review.port}/api/poll?target=${encodeURIComponent(target)}&ack=${encodeURIComponent(delivered.json().batch_id)}`,
        { headers: { "x-doc-review-token": review.token } }
      );
      await acknowledged.body.cancel();
      await expect(frame.locator("p")).toHaveText(`After result${suffix}`);
      let round;
      await expect.poll(async () => {
        round = (await reviewApi(review, `/api/session/${session.sessionId}/history`)).json().rounds[0];
        return round?.targets[0]?.resultRevisionId;
      }, { timeout: 15000 }).toBeTruthy();
      const snapshots = round.targets[0];
      expect(review.store.revisions.readSemantic(snapshots.baselineRevisionId).blocks.map((block) => block.text).join(" "))
        .toContain(`Before result${suffix}`);
      expect(review.store.revisions.readSemantic(snapshots.resultRevisionId).blocks.map((block) => block.text).join(" "))
        .toContain(`After result${suffix}`);
      if (kind === "live") expect(review.store.revisions.readSource(snapshots.resultRevisionId)).toBeNull();
      else expect(review.store.revisions.readSource(snapshots.sourceResultRevisionId)).toBe("After result\n");
      await page.locator("#seeChanges").click();
      await expect(page.locator("#changeDetail")).toContainText(`Before result${suffix}`);
      await expect(page.locator("#changeDetail")).toContainText(`After result${suffix}`);
    } finally {
      if (upstream) await new Promise((resolve, reject) => upstream.close((err) => err ? reject(err) : resolve()));
    }
  });
}

test("SDK clean cannot erase a failed save; retrying Send persists the retained HTML first", async ({ page, review }) => {
  let failing = true;
  let deliveries = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/send") && request.method() === "POST") deliveries += 1;
  });
  await page.route("**/api/page/*/save", async (route) => {
    if (failing) await route.fulfill({ status: 503, json: { error: "Storage unavailable" } });
    else await route.continue();
  });
  const file = writeFile(review, "retry-save.html", '<!doctype html><p id="copy">Original</p>');
  await openReview(page, review, file);
  const frame = await enterEditMode(page);
  await frame.locator("#copy").evaluate((element) => {
    element.textContent = "Retained edit";
    element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await page.locator("#commentsButton").click();
  await page.locator("#note").fill("Keep my unsaved edit");
  await page.locator("#send").click();
  await expect(page.locator(".toast").filter({ hasText: "Feedback not sent" })).toBeVisible();
  await expect(page.locator("#send")).toBeEnabled();
  await expect(page.locator("#note")).toHaveValue("Keep my unsaved edit");
  expect(deliveries).toBe(0);
  expect(fs.readFileSync(file, "utf8")).toContain("Original");
  failing = false;
  await page.locator("#send").click();
  await expect(page.locator("#note")).toHaveValue("");
  expect(fs.readFileSync(file, "utf8")).toContain("Retained edit");
  expect(deliveries).toBe(1);
});

test("a clean unchanged edit can return to View without a false unsaved-DOM warning", async ({ page, review }) => {
  await openReview(page, review, writeFile(review, "clean-edit.html", '<!doctype html><p id="copy">Unchanged</p>'));
  const frame = await enterEditMode(page);
  await frame.locator("#copy").evaluate((element) => {
    element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await page.locator("#modeButton").click();
  await page.getByRole("menuitemradio", { name: /^View/ }).click();
  await expect(page.locator("#modeLabel")).toHaveText("View");
  await expect(frame.locator("body")).not.toHaveAttribute("contenteditable", "true");
});

test("strict Send ignores stale and uncorrelated flush acknowledgements", async ({ page, review }) => {
  await page.addInitScript(() => {
    if (window === window.parent) return;
    window.flushProof = { acknowledged: false, prematureCapture: false };
    window.addEventListener("message", (event) => {
      if (event.data?.type === "eh:captureSnapshot" && !window.flushProof.acknowledged) {
        window.flushProof.prematureCapture = true;
      }
      if (event.data?.type !== "eh:flush") return;
      event.stopImmediatePropagation();
      const { requestId, ...uncorrelated } = event.data;
      parent.postMessage({ ...uncorrelated, type: "eh:flushed" }, "*");
      parent.postMessage({ ...event.data, type: "eh:flushed", requestId: "stale-flush" }, "*");
      setTimeout(() => {
        window.flushProof.acknowledged = true;
        parent.postMessage({ ...event.data, type: "eh:flushed", requestId }, "*");
      }, 150);
    }, true);
  });

  await openReview(page, review, writeFile(review, "flush-identity.html", "<!doctype html><p>Ready</p>"));
  const frame = await waitForSdk(page);
  await page.locator("#commentsButton").click();
  await page.locator("#note").fill("Correlated flush");
  await page.locator("#send").click();
  await expect(page.locator("#note")).toHaveValue("");
  expect(await frame.locator("body").evaluate(() => window.flushProof)).toEqual({ acknowledged: true, prematureCapture: false });
});

test("populated continuous comparisons align real Content and Source across two immutable rounds", async ({ page, review }, testInfo) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width: 1440, height: 1100 });
    const prose = "A readable review keeps the surrounding explanation in view, so reviewers can understand why a change matters without jumping between isolated excerpts.";
    const document = (version) => `<!doctype html>
  <html><head><title>Release readiness</title><style>body{font:16px/1.6 system-ui;max-width:850px;margin:40px auto}table{border-collapse:collapse}td,th{padding:8px;border:1px solid #aaa}</style></head><body>
  <h1 id="title">Release readiness ${version ? "and rollout" : "review"}</h1>
  <p id="lead">The release is <strong>${version ? "ready for a staged rollout" : "waiting for final approval"}</strong>. ${prose} ${version ? "The updated schedule gives teams a full week to verify their regional configuration and report any regressions before the remaining traffic is enabled." : ""}</p>
  <h2 id="checklist">Launch checklist</h2>
  <ol start="3"><li id="step-a">Confirm service ownership and rollback procedures.</li><li id="step-b">${version ? "Validate production alerts and the on-call handover." : "Validate staging alerts."}</li></ol>
  <h2 id="metrics">Acceptance metrics</h2>
  <table><thead><tr><th>Signal</th><th>Target</th><th>Owner</th></tr></thead><tbody><tr><td>Latency</td><td id="latency">${version ? "180 ms" : "250 ms"}</td><td>Platform</td></tr><tr><td>Error rate</td><td>Below 0.1%</td><td>Reliability</td></tr></tbody></table>
  <p id="reference">See the <a href="${version ? "/new-guide" : "/old-guide"}">rollout guide</a> for the approved sequence.</p>
  <pre id="command">release --region=${version ? "europe" : "canary"}\n  --traffic=${version ? "25" : "5"}\n</pre>
  ${Array.from({ length: 24 }, (_, index) => `<p id="context-${index}">Context ${index + 1}. ${prose}</p>`).join("\n")}
  ${version ? '<p id="added">Added safeguard: pause automatically when the error budget is exhausted.</p>' : '<p id="removed">Removed assumption: all regions will deploy simultaneously.</p>'}
  <p id="footer">Decision recorded for review round ${version + 1}.</p>
  </body></html>`;
    const file = writeFile(review, "release-readiness-europe-production-regional-rollout-and-oncall-review.html", document(0));
    const session = await openReview(page, review, file);
    const frame = await waitForSdk(page);
    const completeRound = async (version) => {
      await page.locator("#latestVersion").click();
      if (!(await page.locator("#note").isVisible())) await page.locator("#commentsButton").click();
      await page.locator("#note").fill(`Review rollout revision ${version}`);
      await page.locator("#send").click();
      await expect(page.locator("#note")).toHaveValue("");
      const delivered = (await reviewApi(review, `/api/poll?target=${encodeURIComponent(file)}`)).json();
      expect(delivered.batch_id).toBeTruthy();
      fs.writeFileSync(file, document(version));
      await expect(frame.locator("#footer")).toHaveText(`Decision recorded for review round ${version + 1}.`);
      await waitForSdk(page);
      const response = await fetch(`http://127.0.0.1:${review.port}/api/poll?target=${encodeURIComponent(file)}&ack=${encodeURIComponent(delivered.batch_id)}`, {
        headers: { "x-doc-review-token": review.token },
      });
      await response.body.cancel();
      let round;
      await expect.poll(async () => {
        round = (await reviewApi(review, `/api/session/${session.sessionId}/history`)).json().rounds[0];
        return round?.targets[0]?.resultRevisionId;
      }, { timeout: 15000 }).toBeTruthy();
      return round;
    };
    const round = await completeRound(1);
    const comparisonRoute = `/api/session/${session.sessionId}/history/${round.roundId}/compare?key=${encodeURIComponent(session.key)}&mode=content`;
    const firstComparison = (await reviewApi(review, comparisonRoute)).json();
    expect(firstComparison.version).toBe(2);
    expect(firstComparison.rows.length).toBeGreaterThan(30);
    await page.locator("#seeChanges").click();
    await expect(page.locator("#comparisonModes button[aria-pressed=true]")).toHaveText("Content");
    await expect(page.locator(".comparison-row")).not.toHaveCount(1);
    await expect(page.locator(".comparison-after h1")).toHaveText("Release readiness and rollout");
    await expect(page.locator(".comparison-after table").first()).toBeVisible();
    await expect(page.locator(".comparison-expand").first()).toBeVisible();
    await expect(page.locator("#historyDiagnostics")).not.toHaveAttribute("open", "");
    expect(await page.locator("#changesList").count()).toBe(0);
    expect(await page.locator(".comparison-row").evaluateAll((rows) => rows.every((row) => {
      const [left, right] = [...row.children].map((cell) => cell.getBoundingClientRect());
      return Math.abs(left.top - right.top) < 1 && Math.abs(left.height - right.height) < 1;
    }))).toBe(true);
    expect(await page.locator("#changeDetail script, #changeDetail iframe, #changeDetail img, #changeDetail a").count()).toBe(0);
    const screenshot = async (name) => {
      const destination = process.env.DOC_REVIEW_SCREENSHOTS
        ? path.join(process.env.DOC_REVIEW_SCREENSHOTS, name) : testInfo.outputPath(name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      await page.screenshot({ path: destination, fullPage: true });
    };
    const responsiveScreenshots = async (mode) => {
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        for (const width of [1440, 768, 390, 320]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.locator("#historyPanel").evaluate((element) => { element.scrollTop = 0; });
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          const controls = await page.locator(".changes-controls button, .changes-controls select, .changes-navigation button, .changes-navigation select").evaluateAll((elements) =>
            elements.filter((element) => element.checkVisibility()).map((element) => {
              const { x, y, width, height } = element.getBoundingClientRect();
              return { id: element.id || element.textContent, x, y, width, height };
            }));
          expect(controls.length).toBeGreaterThanOrEqual(6);
          for (const [index, control] of controls.entries()) {
            expect(control.width, control.id).toBeGreaterThanOrEqual(44);
            expect(control.height, control.id).toBeGreaterThanOrEqual(28);
            expect(control.x).toBeGreaterThanOrEqual(0);
            expect(control.x + control.width).toBeLessThanOrEqual(width);
            for (const other of controls.slice(index + 1)) {
              expect(control.x < other.x + other.width && control.x + control.width > other.x &&
                control.y < other.y + other.height && control.y + control.height > other.y, `${control.id} overlaps ${other.id}`).toBe(false);
            }
          }
          await screenshot(`comparison-${mode}-${theme}-${width}.png`);
        }
      }
      await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
      await page.setViewportSize({ width: 1440, height: 1100 });
    };
    await responsiveScreenshots("content");
    await screenshot("comparison-content-desktop.png");
    const rowIdentity = await page.locator(".comparison-row").first().evaluate((row) => { row.dataset.proof = "preserved"; return row.dataset.rowId; });
    await page.locator("#nextChange").click();
    await expect(page.locator(".comparison-row").first()).toHaveAttribute("data-row-id", rowIdentity);
    await expect(page.locator(".comparison-row").first()).toHaveAttribute("data-proof", "preserved");
    await page.locator(".comparison-expand").first().click();
    await expect(page.locator("#changeDetail")).toContainText("Context 10.");
    await page.locator("#historyPanel").evaluate((element) => { element.scrollTop = 0; });
    await page.setViewportSize({ width: 390, height: 1000 });
    await screenshot("comparison-content-mobile.png");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator(".comparison-row").first().evaluate((row) => {
      const [before, after] = [...row.children].map((cell) => cell.getBoundingClientRect());
      return after.top >= before.bottom;
    })).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await expect(page.locator(".comparison-source")).toBeVisible();
    await expect(page.locator(".comparison-source .comparison-gutter").first()).toContainText("1");
    await responsiveScreenshots("source");
    await page.locator("#historyPanel").evaluate((element) => { element.scrollTop = 0; });
    await screenshot("comparison-source-desktop.png");
    await page.setViewportSize({ width: 390, height: 1000 });
    await screenshot("comparison-source-mobile.png");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator(".comparison-unchanged .comparison-after").first()).toBeHidden();
    await expect(page.locator(".comparison-unchanged .comparison-before").first()).toContainText("Unchanged · Before");
    await page.setViewportSize({ width: 1440, height: 1100 });
    const nextRound = await completeRound(2);
    expect(nextRound.roundId).not.toBe(round.roundId);
    const preserved = (await reviewApi(review, comparisonRoute)).json();
    expect(preserved.rows).toEqual(firstComparison.rows);
    expect(preserved.changes).toEqual(firstComparison.changes);
    await page.locator("#seeChanges").click();
    await page.locator("#roundPicker").selectOption(round.roundId);
    await page.getByRole("button", { name: "Content", exact: true }).click();
    await expect(page.locator(".comparison-after h1")).toHaveText("Release readiness and rollout");
  });

test("only a real view change retries same-render capture and forwards captured provenance", async ({ page, review }) => {
  test.setTimeout(45000);
  let version = "Before";
  const captures = [];
  let sentView;
  await page.addInitScript(() => {
    window.addEventListener("message", (event) => {
      if (event.data?.type === "eh:captureSnapshot") window.lastCaptureEnvelope = event.data;
    });
  });
  await page.route("**/api/page/*/send", async (route) => {
    sentView = route.request().postDataJSON().history.view;
    await route.continue();
  });
  await page.route("**/api/session/*/history/*/capture", async (route) => {
    captures.push(route.request().postDataJSON());
    await route.continue();
  });
  const upstream = http.createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><nav role="tablist" id="sections">
      <button role="tab" id="product" aria-controls="product-panel" aria-selected="true">Product</button>
      <button role="tab" id="screens" aria-controls="screens-panel" aria-selected="false">Screens</button></nav>
      <section role="tabpanel" id="product-panel"><p>${version} product</p></section>
      <section role="tabpanel" id="screens-panel" hidden><p>${version} screens</p></section>
      <script>for (const tab of document.querySelectorAll('[role="tab"]')) tab.onclick = () => {
        for (const item of document.querySelectorAll('[role="tab"]')) {
          item.setAttribute('aria-selected', String(item === tab));
          document.getElementById(item.getAttribute('aria-controls')).hidden = item !== tab;
        }
      };</script>`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const target = `http://127.0.0.1:${upstream.address().port}/review`;
    const session = await openReview(page, review, target);
    const frame = await waitForSdk(page);
    await frame.locator("#screens").click();
    await page.locator("#commentsButton").click();
    await page.locator("#note").fill("Improve Screens");
    await page.locator("#send").click();
    await expect(page.locator("#note")).toHaveValue("");
    expect(sentView.status).toBe("identified");
    expect(sentView.tabs[0].tabId).toBe("screens");
    await page.locator("#drawerClose").click();
    const batch = (await reviewApi(review, `/api/poll?target=${encodeURIComponent(target)}`)).json();
    version = "After";
    await page.reload();
    await waitForSdk(page);
    await expect(frame.locator("#product-panel")).toHaveText("After product");
    const acknowledged = await fetch(`http://127.0.0.1:${review.port}/api/poll?target=${encodeURIComponent(target)}&ack=${encodeURIComponent(batch.batch_id)}`, {
      headers: { "x-doc-review-token": review.token },
    });
    await acknowledged.body.cancel();
    await expect(frame.locator("#product-panel")).toHaveText("After product");
    let round;
    await expect.poll(async () => {
      round = (await reviewApi(review, `/api/session/${session.sessionId}/history`)).json().rounds[0];
      return round?.targets[0]?.capture?.error || "";
    }, { timeout: 15000 }).toContain("Return to Screens");
    expect(captures).toHaveLength(1);
    expect(captures[0].view.tabs[0].tabId).toBe("product");
    const renderPath = await page.locator("#frame").getAttribute("src");
    await page.locator("#seeChanges").click();
    await expect(page.locator("#historyError")).toContainText("Return to Screens");
    await page.locator("#latestVersion").click();
    await frame.locator("body").evaluate(() => {
      document.querySelector("#product-panel p").append(" — ordinary content mutation");
      parent.postMessage({
        ...window.lastCaptureEnvelope, type: "eh:snapshot", requestId: "already-finished",
        snapshot: { version: 1, blocks: [], limitations: [] },
      }, "*");
    });
    await page.waitForTimeout(1300);
    expect(captures).toHaveLength(1);
    await expect(frame.locator("#product")).toHaveAttribute("aria-selected", "true");
    await frame.locator("#screens").click();
    await expect.poll(async () => {
      round = (await reviewApi(review, `/api/session/${session.sessionId}/history`)).json().rounds[0];
      return round?.targets[0]?.resultRevisionId;
    }, { timeout: 15000 }).toBeTruthy();
    expect(captures).toHaveLength(2);
    expect(captures[1].view.tabs[0].tabId).toBe("screens");
    expect(captures[1].renderId).toBe(captures[0].renderId);
    expect(await page.locator("#frame").getAttribute("src")).toBe(renderPath);
    await page.locator("#seeChanges").click();
    await page.locator("#historyDiagnostics > summary").click();
    await expect(page.locator("#historyViewCoverage")).toHaveText("Matching visible view: Screens.");
    await expect(page.locator("#historyViewCoverage")).toHaveAttribute("data-status", "matched");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("held recovery keeps drafts and first SDK configuration uses the served render policy", async ({ page, review }) => {
  let stalePagePolicy = false;
  await page.addInitScript(() => {
    window.reviewConfigurations = [];
    window.addEventListener("message", (event) => {
      if (event.data?.type === "eh:configureReview") window.reviewConfigurations.push(event.data);
    });
  });
  await page.route("**/api/page/*?session=*", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (stalePagePolicy) {
      json.feedbackOnly = false;
      json.savePolicy = "writable";
      json.executionMode = "static";
    }
    await route.fulfill({ response, json });
  });
  const file = writeFile(review, "recovery-draft.html", `<!doctype html><p id="copy">Keep this original draft</p>
    <script>document.body.dataset.executed = "yes";</script>`);
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await frame.locator("#copy").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await frame.locator("#commentAction").click();
  await page.locator("#composeText").fill("Preserve this while recovering");
  const before = await page.locator("#frame").getAttribute("src");
  await page.locator("#reviewDetails").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(page.locator("#composeText")).toHaveValue("Preserve this while recovering");
  await page.locator("#reviewDetails").click();
  await page.locator("#executionStatic").click();
  await expect(page.locator("#reloadNotice")).toBeVisible();
  expect(await page.locator("#frame").getAttribute("src")).toBe(before);
  await expect(frame.locator("body")).toHaveAttribute("data-executed", "yes");
  expect(await frame.locator("body").evaluate(() => window.reviewConfigurations.at(-1).savePolicy)).toBe("feedback-only");
  await expect(page.locator("#composeText")).toHaveValue("Preserve this while recovering");
  stalePagePolicy = true;
  await page.locator("#safeReload").click();
  await expect(frame.locator("body")).not.toHaveAttribute("data-executed", "yes");
  await waitForSdk(page);
  await expect.poll(() => frame.locator("body").evaluate(() => window.reviewConfigurations[0]?.savePolicy)).toBe("feedback-only");
  await expect(page.locator("#composeText")).toHaveValue("Preserve this while recovering");
  await expect(page.locator("#composeError")).toContainText("original excerpt");
  const recoveryRender = await page.locator("#frame").getAttribute("src");
  await page.locator("#reviewDetails").click();
  await page.locator("#executionAuto").click();
  await expect(page.locator("#reloadNotice")).toBeVisible();
  expect(await page.locator("#frame").getAttribute("src")).toBe(recoveryRender);
  await expect(frame.locator("body")).not.toHaveAttribute("data-executed", "yes");
  await page.locator("#keepCurrent").click();
  await enterEditMode(page);
  expect(await frame.locator("body").evaluate(() => window.reviewConfigurations.at(-1).savePolicy)).toBe("feedback-only");
  await expect(page.locator("#composeText")).toHaveValue("Preserve this while recovering");
});

test("static edits and Revert carry source hash and frame identity after script removal", async ({ page, review }) => {
  const edits = [];
  const saves = [];
  let savedHash;
  let reverted;
  await page.route("**/api/page/*/edit", async (route) => {
    edits.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.route("**/api/page/*/revert", async (route) => {
    reverted = route.request().postDataJSON();
    await route.continue();
  });
  await page.route("**/api/page/*/save", async (route) => {
    saves.push(route.request().postDataJSON());
    const response = await route.fetch();
    savedHash = (await response.json()).hash;
    await route.fulfill({ response });
  });
  const original = '<!doctype html><p id="copy">Original</p><script>document.body.dataset.executed = "yes";</script>';
  const file = writeFile(review, "revoked-revert.html", original);
  const session = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await expect(frame.locator("body")).toHaveAttribute("data-executed", "yes");
  const staticSource = '<!doctype html><p id="copy">Original</p>';
  fs.writeFileSync(file, staticSource);
  await expect(frame.locator("body")).not.toHaveAttribute("data-executed", "yes");
  await enterEditMode(page);
  await frame.locator("#copy").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" changed");
  await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("Original changed");
  await expect.poll(() => edits.length).toBeGreaterThan(0);
  const identity = edits.at(-1);
  expect(identity.sessionId).toBe(session.sessionId);
  expect(identity.renderId).toBeTruthy();
  expect(identity.generation).toBeGreaterThan(0);
  expect(saves.at(-1)).toMatchObject({
    sessionId: session.sessionId, renderId: identity.renderId, generation: identity.generation,
    baseHash: expect.any(String),
  });
  await page.locator("#commentsButton").click();
  await page.locator("#revert").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revert all", exact: true }).click();
  await expect.poll(() => reverted).toEqual({
    sessionId: session.sessionId, renderId: identity.renderId, generation: identity.generation,
    baseHash: savedHash,
  });
  expect(savedHash).toBeTruthy();
  expect(reverted.baseHash).not.toBe(saves.at(-1).baseHash);
  await expect.poll(() => fs.readFileSync(file, "utf8")).toBe(staticSource);
});
