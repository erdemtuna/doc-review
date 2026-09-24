import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as c from "../lib/contracts/index.js";
import { fixture, responseFor, scopeArgs, editContent } from "./fixtures/agent-loop.js";

const ref = (opened) => ({ reviewId: opened.review.reviewId, entryKey: opened.review.entryKey });
const success = (result, decoder = c.acceptedMutationSchema) => {
  assert.equal(result.code, 0, result.stderr);
  return decoder.parse(result.body);
};

test("CLI Discuss loop preserves source, replies inline, pages context, and returns handled evidence", async (t) => {
  const f = await fixture(t);
  const file = f.file();
  const original = fs.readFileSync(file);
  const opened = await f.open(file), scope = ref(opened);
  const message = await f.thread(scope);
  await f.send(scope, [message]);
  const work = await f.poll(scope);
  assert.equal(work.submission.messages[0].message.intent, "discuss");
  assert.equal(work.pages[0].target.path, file);
  await f.thread(scope, { body: "Newer unsent question" });
  const answer = responseFor(work.submission, { resultNote: "x".repeat(250000) });
  const result = success(await f.respond(scope, answer));
  assert.equal(result.receipt.reviewId, scope.reviewId);
  assert.deepEqual(fs.readFileSync(file), original);
  const context = success(await f.cli("context", ...scopeArgs(scope), "--thread", message.value.threadId), c.contextPageSchema);
  assert.equal(context.items[0].response.body, answer.responses[0].body);
  const status = success(await f.cli("status", ...scopeArgs(scope)), c.agentStatusSchema);
  assert.equal(status.status.work, null);
  assert.equal(status.status.pendingMessageCount, 1, "completion leaves newer unsent content intact");
  assert.equal(status.latestSubmission.state, "handled");
  assert.equal(status.latestSubmission.result.effect, "reply-only");
  assert.equal(status.latestSubmission.result.body.length, 250000, "large stdout is flushed, not truncated");
  assert.equal(status.latestSubmission.comparisonStatus, "not-requested");
  assert.deepEqual(success(await f.respond(scope, answer)), result);
});

test("a saved human HTML edit reports What changed without new source work or comparison", async (t) => {
  const f = await fixture(t), file = f.file(), scope = ref(await f.open(file));
  const recorded = await f.mutate(scope, "record-edit", { pageKey: scope.entryKey, content: editContent("Original", "Human wording") });
  const page = await f.read(scope, "read-page", { pageKey: scope.entryKey });
  await f.mutate(scope, "save-edit", {
    pageKey: scope.entryKey, editId: recorded.value.editId, editVersion: 1,
    expectedSourceHash: page.page.sourceHash, html: "<p>Human wording</p>",
  });
  await f.send(scope, [], [{ pageKey: scope.entryKey, editId: recorded.value.editId, version: 1 }]);
  const { submission } = await f.poll(scope);
  assert.equal(submission.edits[0].source.state, "saved");
  const modified = fs.statSync(file).mtimeMs;
  success(await f.respond(scope, responseFor(submission, { resultNote: "The human edit was already saved." })));
  const status = success(await f.cli("status", ...scopeArgs(scope)), c.agentStatusSchema);
  assert.equal(status.latestSubmission.result.title, "What changed");
  assert.equal(status.latestSubmission.result.effect, "reply-only");
  assert.equal(status.latestSubmission.comparisonStatus, "not-requested");
  assert.equal(fs.statSync(file).mtimeMs, modified);
  assert.equal(fs.readFileSync(file, "utf8"), "<p>Human wording</p>");
});

test("large exact edit handoffs flush complete immutable JSON through the actual CLI pipe", async (t) => {
  const f = await fixture(t), scope = ref(await f.open(f.file("long.md", "Original")));
  const exact = "a".repeat(200000);
  const recorded = await f.mutate(scope, "record-edit", {
    pageKey: scope.entryKey, content: editContent("Original", exact, { after_html: exact }),
  });
  await f.send(scope, [], [{ pageKey: scope.entryKey, editId: recorded.value.editId, version: 1 }]);
  const { submission } = await f.poll(scope);
  assert.equal(submission.edits[0].content.after, exact);
  assert.equal(submission.edits[0].content.after_html, exact);
  assert.equal(submission.edits[0].content.truncated, false);
});

test("checked change and mixed exact pending edits retain formatting, moves, deletion, and asset identity", async (t) => {
  const f = await fixture(t);
  const file = f.file("article.md", "Original\n\nMove me\n\nDelete me\n");
  const scope = ref(await f.open(file));
  const discussion = await f.thread(scope);
  const change = await f.thread(scope, { intent: "request-change", body: "Use the supplied exact edits." });
  const asset = await f.ok({
    ...scope, pageKey: scope.entryKey, type: "image/png", base64: "iVBORw0KGgo=",
  }, "/api/conversation/asset");
  const contents = [
    editContent("Original", "Exact wording", { after_html: `<p><strong>Exact wording</strong><img src="${asset.preview_src}"></p>`, staged_assets: [asset] }),
    { kind: "moved", label: "Paragraph", before: "Move me", moved_after: "", moved_before: "Exact wording",
      truncated: false, truncated_fields: [], staged_assets: [] },
    { kind: "deleted", label: "Paragraph", before: "Delete me", before_html: "<p>Delete me</p>", truncated: false, truncated_fields: [], staged_assets: [] },
  ];
  const edits = [];
  for (const content of contents) {
    const recorded = await f.mutate(scope, "record-edit", { pageKey: scope.entryKey, content });
    edits.push({ pageKey: scope.entryKey, editId: recorded.value.editId, version: 1 });
  }
  await f.send(scope, [discussion, change], edits, { overallNote: { body: "Summarize the choice.", intent: "discuss" } });
  const { submission } = await f.poll(scope);
  assert.deepEqual(submission.edits.map((edit) => edit.content), contents);
  assert.ok(submission.edits.every((edit) => edit.source.state === "pending"));
  const assetSource = submission.edits[0].assets[0].path;
  fs.copyFileSync(assetSource, path.join(f.root, "image.png"));
  const exactSource = "Move me\n\n**Exact wording** ![](image.png)\n";
  fs.writeFileSync(file, exactSource);
  const answer = responseFor(submission);
  answer.responses[1].outcome = "applied";
  answer.editOutcomes.forEach((outcome) => { outcome.outcome = "applied"; });
  answer.resultNote = "Preserved exact wording, formatting and image; moved and deleted the selected paragraphs.";
  success(await f.respond(scope, answer));
  assert.equal(fs.readFileSync(file, "utf8"), exactSource);
  const saved = c.submissionReadSchema.parse(await f.read(scope, "submission", { submissionId: submission.submissionId }));
  assert.equal(saved.result.effect, "changes-reported");
  assert.equal(saved.result.responses[0].outcome, "answered");
  assert.equal(saved.result.responses[1].outcome, "applied");
  assert.equal(saved.result.overallOutcome, "answered");
  assert.ok(fs.existsSync(assetSource), "response does not discard authoritative staged assets");
});

test("incomplete/malformed responses, blanket permission, truncated application and old acknowledgement fail without clearing work", async (t) => {
  const f = await fixture(t);
  const file = f.file(), scope = ref(await f.open(file));
  const message = await f.thread(scope);
  const edit = await f.mutate(scope, "record-edit", {
    pageKey: scope.entryKey, content: editContent("Original", "Partial", { truncated: true, truncated_fields: ["after"] }),
  });
  await f.send(scope, [message], [{ pageKey: scope.entryKey, editId: edit.value.editId, version: 1 }],
    { overallNote: { body: "Change the title only.", intent: "request-change" } });
  const { submission } = await f.poll(scope);
  const valid = responseFor(submission);
  for (const [body, code] of [
    [{ ...valid, responses: [] }, "RESPONSE_COVERAGE"],
    [{ ...valid, responses: valid.responses.map((item) => ({ ...item, outcome: "applied" })) }, "RESPONSE_COVERAGE"],
    [{ ...valid, editOutcomes: valid.editOutcomes.map((item) => ({ ...item, outcome: "applied" })) }, "SAVE_EVIDENCE_CONFLICT"],
    [{ ...valid, unknown: true }, "INVALID_INPUT"],
    [{ ...valid, expectedVersion: 1 }, "VERSION_CONFLICT"],
  ]) {
    const result = await f.respond(scope, body);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(c.failureSchema.parse(result.body).error.code, code);
    assert.equal((await f.read(scope, "submission", { submissionId: submission.submissionId })).submission.state, "delivered");
  }
  fs.writeFileSync(path.join(f.root, "invalid.json"), '{"operation":');
  const malformed = await f.cli("respond", ...scopeArgs(scope), "--response-file", "invalid.json");
  assert.equal(malformed.body.error.code, "MALFORMED_JSON");
  for (const args of [["poll", file], ["status", file], ["poll", ...scopeArgs(scope), "--ack", submission.submissionId]]) {
    const result = await f.cli(...args);
    assert.equal(result.code, 1);
    assert.equal(result.body.error.code, "INVALID_INPUT");
  }
  const obsolete = await fetch(`http://127.0.0.1:${f.server.port}/api/poll?target=${encodeURIComponent(file)}&ack=${submission.submissionId}`, {
    headers: { "x-doc-review-token": f.server.token },
  });
  assert.ok(obsolete.status >= 400, "old HTTP acknowledgement cannot complete conversation work");
  await obsolete.text();
  assert.equal((await f.read(scope, "submission", { submissionId: submission.submissionId })).submission.state, "delivered");
  success(await f.respond(scope, valid));
  assert.equal(fs.readFileSync(file, "utf8"), "<p>Original</p>");
});

for (const when of ["before pickup", "during handling"]) {
  test(`End ${when} permits late completion after restart, without attaching a fresh review`, async (t) => {
    const f = await fixture(t);
    const file = f.file(), scope = ref(await f.open(file));
    await f.send(scope, [await f.thread(scope)]);
    let work = when === "during handling" ? await f.poll(scope) : null;
    await f.mutate(scope, "end", { confirmUnsentReadOnly: true });
    const fresh = ref(await f.open(file));
    assert.notEqual(fresh.reviewId, scope.reviewId);
    let status = success(await f.cli("status", ...scopeArgs(fresh)), c.agentStatusSchema);
    assert.equal(status.status.blockers[0].reviewId, scope.reviewId);
    await f.restart();
    work ??= await f.poll(scope);
    const answer = responseFor(work.submission);
    const accepted = success(await f.respond(scope, answer));
    await f.restart();
    assert.deepEqual(success(await f.respond(scope, answer)), accepted);
    assert.equal((await f.poll(scope)).state, "ended");
    status = success(await f.cli("status", ...scopeArgs(fresh)), c.agentStatusSchema);
    assert.equal(status.status.review.state, "open");
    assert.deepEqual(status.status.blockers, []);
    assert.equal((await f.poll(fresh, "0.1")).state, "timeout");
  });
}

test("abandonment before/after pickup terminates ended waits and rejects late completion without retries", async (t) => {
  const f = await fixture(t);
  for (const delivered of [false, true]) {
    const scope = ref(await f.open(f.file()));
    const sent = await f.send(scope, [await f.thread(scope)]);
    const submission = delivered ? (await f.poll(scope)).submission :
      (await f.read(scope, "submission", { submissionId: sent.value.submissionId })).submission;
    await f.mutate(scope, "end", { confirmUnsentReadOnly: true });
    await f.ok({ operation: "abandon", ...scope, submissionId: submission.submissionId, expectedVersion: submission.version,
      requestId: randomUUID(), confirmExternalWorkMayContinue: true, reason: "Stop waiting, not source cancellation." });
    const late = await f.respond(scope, responseFor(submission));
    assert.equal(late.code, 1);
    assert.equal(late.body.error.code, "SUBMISSION_ABANDONED");
    assert.doesNotMatch(late.stderr, /retrying/);
    assert.equal((await f.poll(scope)).state, "ended");
    const status = success(await f.cli("status", ...scopeArgs(scope)), c.agentStatusSchema);
    assert.equal(status.latestSubmission.state, "abandoned");
  }
});

test("concurrent exact and conflicting CLI responses allow only compatible persisted results", async (t) => {
  const f = await fixture(t), scope = ref(await f.open(f.file()));
  await f.send(scope, [await f.thread(scope)]);
  const { submission } = await f.poll(scope), answer = responseFor(submission);
  fs.writeFileSync(path.join(f.root, "response.json"), JSON.stringify(answer));
  const run = () => f.cli("respond", ...scopeArgs(scope), "--response-file", "response.json", "--timeout", "5");
  const exact = await Promise.all([run(), run()]);
  assert.deepEqual(success(exact[0]), success(exact[1]));
  const changed = await f.respond(scope, { ...answer, resultNote: "Contradictory result." }, "changed.json");
  assert.equal(changed.body.error.code, "REQUEST_CONFLICT");
  const fresh = await f.respond(scope, { ...answer, requestId: randomUUID() }, "fresh.json");
  assert.equal(fresh.body.error.code, "ALREADY_HANDLED");
  const history = await f.read(scope, "submission", { submissionId: submission.submissionId });
  assert.equal(history.result.responses.length, 1);
  await f.send(scope, [await f.thread(scope)]);
  const next = responseFor((await f.poll(scope)).submission);
  const alternatives = [next, { ...next, requestId: randomUUID(), resultNote: "A conflicting response." }];
  const raced = await Promise.all(alternatives.map((body, i) => f.respond(scope, body, `race-${i}.json`)));
  assert.deepEqual(raced.map((item) => item.code).sort(), [0, 1]);
  assert.equal(raced.find((item) => item.code === 1).body.error.code, "ALREADY_HANDLED");
  const winner = raced.findIndex((item) => item.code === 0);
  const persisted = await f.read(scope, "submission", { submissionId: next.submissionId });
  assert.equal(persisted.result.body, alternatives[winner].resultNote);
  assert.equal(persisted.result.responses.length, 1);
});

test("offline status reads validated new state without startup, cleanup, or legacy fallback", async (t) => {
  const f = await fixture(t), scope = ref(await f.open(f.file()));
  await f.send(scope, [await f.thread(scope)]);
  await f.stop();
  const storePath = path.join(f.state, "conversation-state.json");
  const bytes = fs.readFileSync(storePath), modified = fs.statSync(storePath).mtimeMs;
  const legacy = path.join(f.state, "state.json");
  fs.writeFileSync(legacy, '{"pages":{},"batches":{}}');
  const status = success(await f.cli("status", ...scopeArgs(scope)), c.agentStatusSchema);
  assert.equal(status.source, "disk");
  assert.equal(status.status.work.state, "queued");
  assert.equal(fs.existsSync(path.join(f.state, "server.json")), false);
  assert.deepEqual(fs.readFileSync(storePath), bytes);
  assert.equal(fs.statSync(storePath).mtimeMs, modified);
  for (const content of ["not json", JSON.stringify({ ...JSON.parse(bytes), schemaVersion: 999 })]) {
    fs.writeFileSync(storePath, content);
    const result = await f.cli("status", ...scopeArgs(scope));
    assert.equal(result.code, 1);
    assert.equal(result.body.error.code, "INTERNAL_ERROR");
    assert.equal(fs.readFileSync(storePath, "utf8"), content);
    assert.equal(fs.existsSync(path.join(f.state, "server.json")), false);
  }
  fs.unlinkSync(storePath);
  const missing = await f.cli("status", ...scopeArgs(scope));
  assert.equal(missing.body.error.code, "NOT_FOUND");
  assert.equal(fs.existsSync(storePath), false);
});
