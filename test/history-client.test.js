import test from "node:test";
import assert from "node:assert/strict";
import { createCaptureRequests, sameRender, draftCount, canJumpToCurrent, excerpt, changeKind, pendingCaptureTarget, defaultHistoryRound, comparisonFreshness } from "../lib/history-client.js";

const identity = { key: "page-a", renderId: "render-a", generation: 1 };

test("capture replies are correlated and bound to the current render", async () => {
  const sent = [];
  let current = identity;
  const captures = createCaptureRequests({ send: (message) => sent.push(message), current: () => current });
  const first = captures.request();
  const second = captures.request();
  assert.equal(captures.size, 2);
  assert.equal(sent[0].requireStable, true);
  assert.equal(captures.receive({ requestId: "unrequested", snapshot: {} }), false);
  captures.receive({ requestId: sent[1].requestId, snapshot: { blocks: ["second"] }, capturedAt: 1234 });
  const captured = await second;
  assert.deepEqual(captured.semantic, { blocks: ["second"] });
  assert.equal(captured.semanticCapturedAt, 1234);
  current = { ...identity, generation: 2 };
  captures.receive({ requestId: sent[0].requestId, snapshot: {} });
  await assert.rejects(first, /page changed/);
  assert.equal(captures.size, 0);
});

test("timeout is a capture failure, not a successful flush", async () => {
  const captures = createCaptureRequests({ send: () => {}, current: () => identity, timeout: 10 });
  await assert.rejects(captures.request(), /did not confirm a stable capture/);
  assert.equal(captures.size, 0);
});

test("navigation cancellation and SDK errors preserve an explicit failure", async () => {
  let message;
  const captures = createCaptureRequests({ send: (value) => { message = value; }, current: () => identity });
  const first = captures.request();
  captures.cancel();
  await assert.rejects(first, /page changed/);
  const second = captures.request();
  captures.receive({ requestId: message.requestId, error: "Page is changing" });
  await assert.rejects(second, /Page is changing/);
  assert.equal(captures.size, 0);
});

test("loading frames cannot be captured", async () => {
  const captures = createCaptureRequests({ send: () => assert.fail("must not send"), current: () => ({ ...identity, loading: true }) });
  await assert.rejects(captures.request(), /not ready/);
});

test("historical or removed changes cannot jump to live content", () => {
  const item = { kind: "modified", confidence: "exact", navigation: { selector: "#heading" } };
  assert.equal(canJumpToCurrent(item, identity, identity), true);
  assert.equal(canJumpToCurrent(item, { ...identity, renderId: "old" }, identity), false);
  assert.equal(canJumpToCurrent({ ...item, kind: "removed" }, identity, identity), false);
  assert.equal(canJumpToCurrent({ ...item, unresolved: true }, identity, identity), false);
  assert.equal(canJumpToCurrent({ ...item, confidence: "context" }, identity, identity), false);
  assert.equal(canJumpToCurrent({ after: {} }, identity, identity), false);
  assert.equal(sameRender(null, identity), false);
});

test("drafts are counted without being committed and excerpts remain plain text", () => {
  assert.equal(draftCount({ compose: {}, commentUi: { edit: { draft: "pending" } } }), 2);
  assert.equal(draftCount({}, " overall note "), 1);
  assert.equal(excerpt({ text: "<script>not markup</script>" }), "<script>not markup</script>");
  assert.equal(changeKind({ type: "removed" }), "removed");
});

test("automatic result capture requires acknowledgement and readiness, not a gratuitous reload", () => {
  const target = { key: "page-a", capture: { status: "pending" } };
  const round = { feedbackStatus: "acknowledged", sentAt: 100, targets: [target] };
  assert.equal(pendingCaptureTarget(round, "page-a", 101), target);
  assert.equal(pendingCaptureTarget(round, "page-a", 50), target);
  assert.equal(pendingCaptureTarget(round, "page-a", 0), null);
  assert.equal(pendingCaptureTarget(round, "other-page", 101), null);
  assert.equal(pendingCaptureTarget({ ...round, feedbackStatus: "delivered" }, "page-a", 101), null);
  for (const status of ["claimed", "running", "ready", "unavailable"]) {
    assert.equal(pendingCaptureTarget({ ...round, targets: [{ ...target, capture: { status } }] }, "page-a", 101), null);
  }
  assert.ok(pendingCaptureTarget({ ...round, targets: [{ ...target, capture: { status: "failed" } }] }, "page-a", 101));
  assert.equal(pendingCaptureTarget({ ...round, targets: [{ ...target, resultRevisionId: "done" }] }, "page-a", 101), null);
});

test("per-request timeout overrides the normal budget and ignores a late response", async () => {
  const sent = [];
  const captures = createCaptureRequests({ send: (message) => sent.push(message), current: () => identity, timeout: 1000 });
  const expired = captures.request({ timeout: 5 });
  await assert.rejects(expired, { code: "CAPTURE_TIMEOUT" });
  const next = captures.request();
  assert.equal(captures.receive({ requestId: sent[0].requestId, snapshot: { stale: true } }), false);
  assert.equal(captures.size, 1);
  captures.receive({ requestId: sent[1].requestId, snapshot: { current: true } });
  assert.deepEqual((await next).semantic, { current: true });
});

test("request-scoped cancellation leaves other captures intact and preserves SDK error codes", async () => {
  const sent = [];
  const captures = createCaptureRequests({ send: (message) => sent.push(message), current: () => identity });
  const controller = new AbortController();
  const cancelled = captures.request({ signal: controller.signal });
  const other = captures.request();
  controller.abort();
  await assert.rejects(cancelled, { code: "CAPTURE_CANCELLED" });
  assert.equal(captures.size, 1);
  captures.receive({ requestId: sent[1].requestId, error: { code: "CAPTURE_UNSTABLE", message: "Still changing" } });
  await assert.rejects(other, { code: "CAPTURE_UNSTABLE", message: "Still changing" });
  assert.equal(captures.size, 0);
  await assert.rejects(captures.request({ signal: controller.signal }), { code: "CAPTURE_CANCELLED" });
  assert.equal(sent.length, 2);
});

test("synchronous transport errors clean up the pending capture", async () => {
  const captures = createCaptureRequests({ send: () => { throw new Error("Window closed"); }, current: () => identity });
  await assert.rejects(captures.request(), /Window closed/);
  assert.equal(captures.size, 0);
});

test("history defaults to the newest completed round, retaining pending fallback", () => {
  const pending = { roundId: "new", captureStatus: "pending" };
  const completed = { roundId: "done", completedAt: 123 };
  assert.equal(defaultHistoryRound([pending, completed]), completed);
  assert.equal(defaultHistoryRound([pending]), pending);
  assert.equal(defaultHistoryRound([]), null);
});

test("currentness distinguishes source evidence from live DOM proof", () => {
  const current = { key: "page", kind: "file", ready: true, sourceHash: "new" };
  assert.match(comparisonFreshness({ sourceHash: "old" }, "page", current), /newer or different/);
  assert.match(comparisonFreshness({ sourceHash: "new" }, "page", current), /Runtime DOM changes are not verified/);
  assert.match(comparisonFreshness({}, "page", { ...current, pendingReload: true }), /unverified/);
  assert.match(comparisonFreshness({}, "other", current), /Different page/);
  assert.match(comparisonFreshness({ capturedSessionId: "session", capturedGeneration: 2 }, "page",
    { ...current, kind: "url", sessionId: "session", generation: 2 }), /current DOM is not verified/);
  assert.match(comparisonFreshness({ capturedSessionId: "session", capturedGeneration: 1 }, "page",
    { ...current, kind: "url", sessionId: "session", generation: 2 }), /different or unverified/);
});
