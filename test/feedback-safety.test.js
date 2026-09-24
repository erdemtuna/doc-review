import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fixture, responseFor, editContent, scopeArgs } from "./fixtures/agent-loop.js";

async function opened(t) {
  const f = await fixture(t), file = f.file();
  const { review } = await f.open(file);
  return { f, file, ref: { reviewId: review.reviewId, entryKey: review.entryKey } };
}
async function attempt(f, ref, operation, fields = {}) {
  return f.call({ operation, ...ref, requestId: crypto.randomUUID(),
    expectedVersion: (await f.read(ref)).version, ...fields });
}

test("message boundary preserves exact text and rejects presentation geometry rather than persisting it", async (t) => {
  const { f, ref } = await opened(t);
  const target = { kind: "selection", anchor: { quote: "Original", prefix: "", suffix: "" } };
  for (const fields of [
    { target, body: " \n " },
    { body: "Thought", target: { ...target, anchor: { ...target.anchor, rects: [{ left: 1, top: 2 }] } } },
    { body: "Thought", target: { ...target, viewport: { width: 800, height: 600 } } },
  ]) {
    const result = await attempt(f, ref, "create-thread", { pageKey: ref.entryKey, intent: "discuss", ...fields });
    assert.equal(result.body.error.code, "INVALID_INPUT");
  }
  const saved = await f.thread(ref, { target, body: "  Exact thought.  " });
  await f.send(ref, [saved]);
  const work = (await f.poll(ref)).submission;
  assert.equal(work.messages[0].message.body, "  Exact thought.  ");
  assert.deepEqual(work.messages[0].target, target);
  assert.doesNotMatch(JSON.stringify(work), /rects|viewport|generation|relation|clip|horizontal/);
});

test("obsolete acknowledgement cannot destroy queued work and handling preserves later messages and formatting", async (t) => {
  const { f, ref } = await opened(t);
  const original = await f.thread(ref);
  await f.send(ref, [original]);
  const retired = await fetch(`http://127.0.0.1:${f.server.port}/api/poll?ack=stale`, {
    headers: { "x-doc-review-token": f.server.token },
  });
  assert.equal(retired.status, 410);
  const work = (await f.poll(ref)).submission;
  assert.equal(work.messages[0].message.messageId, original.value.messageId);
  const later = await f.mutate(ref, "reply", { threadId: original.value.threadId, body: "Late thought", intent: "discuss" });
  assert.equal((await attempt(f, ref, "record-edit", {
    pageKey: ref.entryKey, content: editContent("Original", "New"),
  })).body.error.code, "WORK_OUTSTANDING");
  await f.ok(responseFor(work));
  const edit = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey,
    content: editContent("Original", "New head", { after_html: "<p>New <strong>head</strong></p>" }) });
  await f.send(ref, [later], [{ pageKey: ref.entryKey, editId: edit.value.editId, version: 1 }]);
  const next = (await f.poll(ref)).submission;
  assert.deepEqual(next.messages.map(({ message }) => message.body), ["Late thought"]);
  assert.equal(next.edits[0].content.after_html, "<p>New <strong>head</strong></p>");
});

test("an unsent message can be reworded with exact version, missing and empty updates rejected", async (t) => {
  const { f, ref } = await opened(t);
  const saved = await f.thread(ref, { body: "First thoughts" });
  const fields = { threadId: saved.value.threadId, messageId: saved.value.messageId, messageVersion: 1,
    body: "Sharper thoughts", intent: "request-change" };
  assert.equal((await attempt(f, ref, "update-message", { ...fields, messageId: "missing" })).body.error.code, "NOT_FOUND");
  assert.equal((await attempt(f, ref, "update-message", { ...fields, body: " " })).body.error.code, "INVALID_INPUT");
  await f.mutate(ref, "update-message", fields);
  assert.equal((await attempt(f, ref, "update-message", fields)).body.error.code, "VERSION_CONFLICT");
  await f.mutate(ref, "send", { pageKeys: [ref.entryKey], edits: [],
    messages: [{ threadId: saved.value.threadId, messageId: saved.value.messageId, version: 2 }] });
  const work = (await f.poll(ref)).submission;
  assert.equal(work.messages[0].message.body, "Sharper thoughts");
  assert.equal(work.messages[0].message.intent, "request-change");
});

test("Send freezes queued wording; corrections after Send and delivery remain separate messages", async (t) => {
  const { f, ref } = await opened(t);
  const original = await f.thread(ref, { body: "Delete this", intent: "request-change" });
  await f.send(ref, [original]);
  const update = { threadId: original.value.threadId, messageId: original.value.messageId, messageVersion: 1,
    body: "Do not delete", intent: "discuss" };
  assert.equal((await attempt(f, ref, "update-message", update)).body.error.code, "MESSAGE_IMMUTABLE");
  const queuedCorrection = await f.mutate(ref, "reply", { threadId: original.value.threadId, body: "Shorten instead", intent: "request-change" });
  const delivered = (await f.poll(ref)).submission;
  assert.equal(delivered.messages[0].message.body, "Delete this");
  assert.equal((await attempt(f, ref, "update-message", update)).body.error.code, "MESSAGE_IMMUTABLE");
  const later = await f.mutate(ref, "reply", { threadId: original.value.threadId, body: "Keep it and add an example", intent: "request-change" });
  await f.ok(responseFor(delivered));
  await f.send(ref, [queuedCorrection, later]);
  const corrected = (await f.poll(ref)).submission;
  assert.deepEqual(corrected.messages.map(({ message }) => message.body), ["Shorten instead", "Keep it and add an example"]);
  assert.equal(new Set(corrected.messages.map(({ message }) => message.messageId)).size, 2);
});

test("stale source saves are refused; accepted save evidence supplies the next exact baseline", async (t) => {
  const { f, ref, file } = await opened(t);
  const recorded = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: editContent("Original", "Changed") });
  const page = await f.read(ref, "read-page", { pageKey: ref.entryKey });
  const save = { pageKey: ref.entryKey, editId: recorded.value.editId, editVersion: 1, html: "<p>Changed</p>" };
  assert.equal((await attempt(f, ref, "save-edit", { ...save, expectedSourceHash: "0".repeat(40) })).body.error.code, "SAVE_EVIDENCE_CONFLICT");
  assert.equal(fs.readFileSync(file, "utf8"), "<p>Original</p>");
  await f.mutate(ref, "save-edit", { ...save, expectedSourceHash: page.page.sourceHash });
  assert.equal(fs.readFileSync(file, "utf8"), "<p>Changed</p>");
  const next = await f.read(ref, "read-page", { pageKey: ref.entryKey });
  assert.notEqual(next.page.sourceHash, page.page.sourceHash);
  const later = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: editContent("Changed", "Late") });
  assert.equal((await attempt(f, ref, "save-edit", { ...save, editId: later.value.editId,
    html: "<p>Late</p>", expectedSourceHash: page.page.sourceHash })).body.error.code, "SAVE_EVIDENCE_CONFLICT");
  assert.equal(fs.readFileSync(file, "utf8"), "<p>Changed</p>");
});

test("End releases the exact-review waiting agent while retaining read-only sessions and unsent feedback", async (t) => {
  const { f, ref } = await opened(t);
  const pending = await f.thread(ref, { body: "Unsent thought" });
  const attached = await f.ok({ operation: "read-review", ...ref }, "/api/conversation/session");
  const waiting = f.cli("poll", ...scopeArgs(ref), "--timeout", "5");
  await f.mutate(ref, "end", { confirmUnsentReadOnly: true });
  assert.equal((await waiting).body.state, "ended");
  const bootstrap = await fetch(`http://127.0.0.1:${f.server.port}/api/session/${attached.sessionId}/page`, {
    headers: { "x-doc-review-token": f.server.token },
  });
  assert.equal(bootstrap.status, 200);
  assert.equal((await bootstrap.json()).review.state, "ended");
  const context = await f.cli("context", ...scopeArgs(ref), "--thread", pending.value.threadId);
  assert.equal(context.body.items[0].reviewer.body, "Unsent thought");
  assert.equal(context.body.items[0].reviewer.submissionId, null);
  assert.equal((await attempt(f, ref, "reply", {
    threadId: pending.value.threadId, body: "Too late", intent: "discuss",
  })).body.error.code, "REVIEW_ENDED");
});

test("poll --timeout rejects malformed values instead of waiting forever", async (t) => {
  const f = await fixture(t);
  for (const args of [["--timeout", "nope"], ["--timeout=abc"], ["--timeout", "0"], ["--timeout"]]) {
    const result = await f.cli("poll", "--review", "review", "--entry", "entry", ...args);
    assert.equal(result.code, 1);
    assert.equal(result.body.error.code, "INVALID_INPUT");
    assert.match(result.stderr, /--timeout/);
  }
});

test("poll rejects obsolete target and acknowledgement-only commands", async (t) => {
  const f = await fixture(t);
  for (const args of [["poll", "x.html", "--ack"], ["poll", "x.html", "--ack", "--timeout", "1"],
    ["poll", "x.html", "--ack=b_legacy"]]) {
    const result = await f.cli(...args);
    assert.equal(result.code, 1);
    assert.equal(result.body.error.code, "INVALID_INPUT");
    assert.match(result.stderr, /retired/);
  }
});
