import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Store } from "../lib/state.js";
import { statePath } from "../lib/paths.js";

const fixture = path.join(process.cwd(), `.history-state-test-${crypto.randomUUID()}`);
fs.mkdirSync(fixture);
test.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
let index = 0;

function setup() {
  process.env.DOC_REVIEW_STATE_DIR = path.join(fixture, `state-${++index}`);
  const store = new Store();
  const page = store.openUrl(`http://localhost:3000/page-${index}`);
  return { store, key: page.key };
}

function revision(store, key, text = "Before") {
  return store.revisions.put({
    documentId: key,
    semantic: {
      capturedAt: 100,
      snapshot: { version: 1, blocks: [{ id: "p", tag: "p", text, path: "main > p" }] },
    },
  }).revisionId;
}

function send(store, key, { baselineRevisionId = revision(store, key), targets, commentId = crypto.randomUUID() } = {}) {
  store.addComment(key, { id: commentId, kind: "selection", quote: "Before", feedback: "Revise" });
  const batch = {
    status: "feedback",
    pages: [{ file: store.page(key).url, comments: structuredClone(store.page(key).comments), edits: [] }],
  };
  const record = store.setBatch(key, {
    batch,
    cleanup: [{ key, ids: [commentId], staged: [], sentAt: Date.now() }],
    history: { targets: targets || [{ key, baselineRevisionId }] },
  });
  return { record, roundId: record.round_id, commentId, baselineRevisionId };
}

function ack(store, key, record) {
  store.markBatchDelivered(key);
  return store.acknowledgeBatch(key, record.batch_id);
}

function complete(store, key, roundId, text = "After") {
  const claim = store.claimCapture(key, roundId, key, { ownerSessionId: "s_one", generation: 1 });
  const revisionId = revision(store, key, text);
  return { ...store.recordCaptureResult(key, roundId, key, { ...claim, revisionId }), claim, revisionId };
}

for (const finalized of ["captured", "unavailable"]) {
  test(`a ${finalized} target cannot gain a new source endpoint while another target is pending`, () => {
    const { store, key } = setup();
    const other = store.openUrl(`http://localhost:3000/other-${index}`);
    const { record, roundId } = send(store, key, {
      targets: [
        { key, baselineRevisionId: revision(store, key) },
        { key: other.key, baselineRevisionId: revision(store, other.key) },
      ],
    });
    ack(store, key, record);
    if (finalized === "captured") complete(store, key, roundId);
    else {
      const capture = store.getRound(key, roundId).targets[0].capture;
      store.markCaptureUnavailable(key, roundId, key, {
        captureId: capture.captureId, reason: "Explicitly finished", final: true,
      });
    }
    const before = store.getRound(key, roundId);
    assert.equal(before.completedAt, undefined);
    const source = store.revisions.put({ documentId: key, source: { text: "A later observation" } });
    assert.throws(() => store.recordSourceResult(key, roundId, key, { revisionId: source.revisionId }),
      (error) => error.code === "CAPTURE_FINALIZED");
    assert.throws(() => store.recordSourceResult(key, roundId, key, { unavailable: "A later failure" }),
      (error) => error.code === "CAPTURE_FINALIZED");
    assert.deepEqual(store.getRound(key, roundId), before);
  });
}

test("Send freezes references, actual delivered wording is archived, and ack only requests capture", () => {
  const { store, key } = setup();
  const { record, roundId, baselineRevisionId, commentId } = send(store, key);
  store.reviseComment(key, commentId, "Queued amendment");
  store.markBatchDelivered(key);
  store.reviseComment(key, commentId, "Delivered correction", { replacementId: "correction" });
  store.setPristine(key, "External change", { keepEdits: true });
  assert.equal(store.getRound(key, roundId).targets[0].baselineRevisionId, baselineRevisionId);
  assert.equal(store.getRound(key, roundId).deliveredFeedback.pages[0].comments[0].feedback, "Queued amendment");
  const result = store.acknowledgeBatch(key, record.batch_id);
  assert.equal(result.roundId, roundId);
  const round = store.getRound(key, roundId);
  assert.equal(round.feedbackStatus, "acknowledged");
  assert.equal(round.captureStatus, "pending");
  assert.equal(round.targets[0].capture.status, "pending");
  assert.equal(round.completedAt, undefined);
  assert.equal(store.page(key).comments[0].id, "correction");
  assert.equal(store.data.receipts[record.batch_id].batch.pages[0].comments[0].feedback, "Queued amendment");
});

test("superseded delivered rounds remain archived and stale ack cannot start newer captures", () => {
  const { store, key } = setup();
  const first = send(store, key);
  store.markBatchDelivered(key);
  const second = send(store, key);
  assert.equal(store.getRound(key, first.roundId).feedbackStatus, "superseded");
  assert.ok(store.getRound(key, first.roundId).deliveredFeedback);
  assert.equal(store.acknowledgeBatch(key, first.record.batch_id).acknowledged, false);
  assert.equal(store.getRound(key, second.roundId).targets[0].capture, null);
  assert.equal(store.getRound(key, second.roundId).feedbackStatus, "queued");
});

test("capture ownership, stale requests, idempotent results and immutable endpoints", () => {
  const { store, key } = setup();
  const { record, roundId } = send(store, key);
  ack(store, key, record);
  const claim = store.claimCapture(key, roundId, key, { ownerSessionId: "s_one", generation: 1 });
  assert.throws(() => store.claimCapture(key, roundId, key, { ownerSessionId: "s_two", generation: 1 }),
    (err) => err.code === "CAPTURE_CONFLICT");
  const revisionId = revision(store, key, "After");
  assert.throws(() => store.recordCaptureResult(key, roundId, key, { ...claim, generation: 2, revisionId }),
    (err) => err.code === "CAPTURE_CONFLICT");
  assert.equal(store.recordCaptureResult(key, roundId, key, { ...claim, revisionId }).accepted, true);
  assert.equal(store.recordCaptureResult(key, roundId, key, { ...claim, revisionId }).duplicate, true);
  assert.throws(() => store.claimCapture(key, roundId, key, { ownerSessionId: "s_one", generation: 1 }),
    (err) => err.code === "CAPTURE_FINALIZED");
  assert.equal(store.getRound(key, roundId).targets[0].resultRevisionId, revisionId);
  assert.ok(store.getRound(key, roundId).completedAt);
});

test("restart invalidates browser ownership but preserves round, feedback and capture intent", () => {
  const { store, key } = setup();
  const { record, roundId } = send(store, key);
  ack(store, key, record);
  const old = store.claimCapture(key, roundId, key, { ownerSessionId: "old", generation: 4 });
  const restarted = new Store();
  const pending = restarted.getRound(key, roundId).targets[0].capture;
  assert.equal(pending.status, "pending");
  assert.equal(pending.ownerSessionId, null);
  assert.notEqual(pending.captureId, old.captureId);
  assert.ok(restarted.getRound(key, roundId).deliveredFeedback);
  const revisionId = revision(restarted, key, "New");
  assert.throws(() => restarted.recordCaptureResult(key, roundId, key, { ...old, revisionId }), /stale/);
  complete(restarted, key, roundId);
});

test("transient unavailable capture preserves feedback archive and allows an explicit retry", () => {
  const { store, key } = setup();
  const { record, roundId } = send(store, key);
  ack(store, key, record);
  const claim = store.claimCapture(key, roundId, key, { ownerSessionId: "one", generation: 1 });
  store.markCaptureUnavailable(key, roundId, key, { ...claim, reason: "page_changing" });
  const failed = store.getRound(key, roundId);
  assert.equal(failed.captureStatus, "failed");
  assert.equal(failed.completedAt, undefined);
  assert.ok(failed.deliveredFeedback);
  complete(store, key, roundId);
  assert.equal(store.getRound(key, roundId).captureStatus, "ready");
});

test("inactive live targets keep explicit missing baselines and multi-page completion is separate", () => {
  const { store, key } = setup();
  const other = store.openUrl("http://localhost:3000/other");
  const { record, roundId } = send(store, key, {
    targets: [{ key, baselineRevisionId: revision(store, key) }, { key: other.key, baselineUnavailable: "inactive_at_send" }],
  });
  ack(store, key, record);
  complete(store, key, roundId);
  assert.equal(store.getRound(key, roundId).completedAt, undefined);
  const claim = store.claimCapture(key, roundId, other.key, { ownerSessionId: "other", generation: 2 });
  store.markCaptureUnavailable(key, roundId, other.key, { ...claim, reason: "user_skipped", final: true });
  const round = store.getRound(key, roundId);
  assert.equal(round.captureStatus, "partial");
  assert.ok(round.completedAt);
  assert.equal(round.targets[1].baselineUnavailable, "inactive_at_send");
  assert.equal(round.targets[1].baselineRevisionId, undefined);
});

test("failed ack and result persistence never publish cleanup or endpoint changes", () => {
  const { store, key } = setup();
  const { record, roundId } = send(store, key);
  store.markBatchDelivered(key);
  const goodWrite = store.write;
  const before = fs.readFileSync(statePath(), "utf8");
  store.write = () => { throw new Error("disk full"); };
  assert.throws(() => store.acknowledgeBatch(key, record.batch_id), /disk full/);
  assert.ok(store.batch(key));
  assert.equal(store.page(key).comments.length, 1);
  assert.equal(fs.readFileSync(statePath(), "utf8"), before);
  store.write = goodWrite;
  store.acknowledgeBatch(key, record.batch_id);
  const claim = store.claimCapture(key, roundId, key, { ownerSessionId: "one", generation: 1 });
  const revisionId = revision(store, key, "After");
  store.write = () => { throw new Error("disk full"); };
  assert.throws(() => store.recordCaptureResult(key, roundId, key, { ...claim, revisionId }), /disk full/);
  assert.equal(store.getRound(key, roundId).targets[0].resultRevisionId, null);
  assert.ok(store.getRound(key, roundId).deliveredFeedback);
});

test("retention keeps five completed rounds plus active and unsent-pinned revisions", () => {
  const { store, key } = setup();
  const first = send(store, key);
  ack(store, key, first.record);
  complete(store, key, first.roundId, "After 1");
  store.addComment(key, { id: "pinned", feedback: "Still discussing this", revisionId: first.baselineRevisionId });
  for (let i = 2; i <= 7; i++) {
    const sent = send(store, key, { baselineRevisionId: revision(store, key, `Before ${i}`) });
    ack(store, key, sent.record);
    complete(store, key, sent.roundId, `After ${i}`);
  }
  assert.equal(store.listHistory(key).filter((round) => round.completedAt).length, 6);
  assert.ok(store.getRound(key, first.roundId));
  store.removeComment(key, "pinned");
  assert.equal(store.listHistory(key).filter((round) => round.completedAt).length, 5);
  const pending = send(store, key);
  ack(store, key, pending.record);
  assert.equal(store.listHistory(key).length, 6);
  store.collectHistoryGarbage({ olderThan: Date.now() + 1000 });
  assert.ok(store.revisions.get(pending.baselineRevisionId));
});

test("missing or old source cannot silently prune unsent feedback and pending batches", () => {
  const { store } = setup();
  const file = path.join(fixture, "gone.html");
  fs.writeFileSync(file, "<p>Text</p>");
  const page = store.openPage(file, "<p>Text</p>");
  store.addComment(page.key, { id: "keep", feedback: "Not handled" });
  store.setBatch(page.key, { batch: { status: "feedback", pages: [] }, cleanup: [{ key: page.key, ids: ["keep"] }] });
  store.data.pages[page.key].updatedAt = 0;
  store.data.batches[page.key].updatedAt = 0;
  fs.unlinkSync(file);
  store.save();
  const restarted = new Store();
  assert.ok(restarted.page(page.key));
  assert.ok(restarted.batch(page.key));
});

test("note-only history includes its target in acknowledgement capture keys", () => {
  const { store, key } = setup();
  const record = store.setBatch(key, {
    batch: { status: "feedback", pages: [], overall_note: "Please revise" },
    cleanup: [],
    history: { targets: [{ key, baselineUnavailable: "explicit_send_without_comparison" }] },
  });
  const result = ack(store, key, record);
  assert.deepEqual(result.keys, [key]);
  const capture = store.getRound(key, record.round_id).targets[0].capture;
  store.markCaptureUnavailable(key, record.round_id, key, { captureId: capture.captureId, reason: "not_open" });
  assert.equal(store.getRound(key, record.round_id).completedAt, undefined);
  complete(store, key, record.round_id);
  assert.equal(store.getRound(key, record.round_id).captureStatus, "partial");
});

test("failed Send publication leaves existing feedback and round state untouched", () => {
  const { store, key } = setup();
  const first = send(store, key);
  const before = fs.readFileSync(statePath(), "utf8");
  const baselineRevisionId = revision(store, key, "Second");
  store.write = () => { throw new Error("state unavailable"); };
  assert.throws(() => store.setBatch(key, {
    batch: { status: "feedback", pages: [] }, cleanup: [],
    history: { targets: [{ key, baselineRevisionId }] },
  }), /state unavailable/);
  assert.equal(fs.readFileSync(statePath(), "utf8"), before);
  assert.equal(store.getRound(key, first.roundId).feedbackStatus, "queued");
  assert.equal(store.listHistory(key).length, 1);
  assert.equal(store.page(key).comments.length, 1);
});

test("returned history and capture values cannot mutate durable in-memory ownership", () => {
  const { store, key } = setup();
  const { record, roundId } = send(store, key);
  ack(store, key, record);
  const claim = store.claimCapture(key, roundId, key, { ownerSessionId: "owner", generation: 1 });
  claim.ownerSessionId = "intruder";
  const listed = store.listHistory(key);
  listed[0].targets[0].capture.ownerSessionId = "intruder";
  assert.equal(store.getRound(key, roundId).targets[0].capture.ownerSessionId, "owner");
});

test("server integration may pass history as a third argument without changing legacy batches", () => {
  const { store, key } = setup();
  const record = store.setBatch(key, {
    batch: { status: "feedback", pages: [] }, cleanup: [],
  }, {
    history: { targets: [{ key, baselineUnavailable: "explicit_skip", ownerSessionId: "baseline_owner" }] },
  });
  assert.equal(store.getRound(key, record.round_id).targets[0].ownerSessionId, "baseline_owner");
  assert.equal(ack(store, key, record).roundId, record.round_id);
});

test("ack source capture freezes separately from delayed semantic result and preserves failures", () => {
  const { store, key } = setup();
  const { record, roundId } = send(store, key);
  ack(store, key, record);
  store.recordSourceResult(key, roundId, key, { unavailable: "file not readable yet" });
  assert.equal(store.getRound(key, roundId).targets[0].sourceResultUnavailable, "file not readable yet");
  const source = store.revisions.put({ documentId: key, source: { text: "At ack", capturedAt: 200 } });
  assert.equal(store.recordSourceResult(key, roundId, key, { revisionId: source.revisionId }).accepted, true);
  assert.equal(store.recordSourceResult(key, roundId, key, { revisionId: source.revisionId }).duplicate, true);
  assert.equal(store.getRound(key, roundId).completedAt, undefined);
  complete(store, key, roundId, "Later rendered result");
  const round = store.getRound(key, roundId);
  assert.equal(round.targets[0].sourceResultRevisionId, source.revisionId);
  assert.notEqual(round.targets[0].resultRevisionId, source.revisionId);
  const later = store.revisions.put({ documentId: key, source: { text: "Later source", capturedAt: 300 } });
  assert.throws(() => store.recordSourceResult(key, roundId, key, { revisionId: later.revisionId }),
    (error) => error.code === "CAPTURE_FINALIZED" && error.status === 409);
});

test("source-only before coverage and explicit source-only completion are partial, not full content", () => {
  const { store, key } = setup();
  const before = store.revisions.put({
    documentId: key, source: { text: "Before" }, limitations: ["semantic_before_unavailable"],
  });
  const { record, roundId } = send(store, key, { baselineRevisionId: before.revisionId });
  ack(store, key, record);
  const source = store.revisions.put({ documentId: key, source: { text: "After" } });
  store.recordSourceResult(key, roundId, key, { revisionId: source.revisionId });
  const capture = store.getRound(key, roundId).targets[0].capture;
  store.markCaptureUnavailable(key, roundId, key, {
    captureId: capture.captureId, reason: "explicit_source_only", final: true,
  });
  const round = store.getRound(key, roundId);
  assert.equal(round.captureStatus, "partial");
  assert.ok(round.completedAt);
  assert.equal(round.targets[0].baselineCoverage.semantic, false);
});
