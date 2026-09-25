import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, responseFor, editContent } from "./fixtures/agent-loop.js";
import { statePath } from "../lib/paths.js";
import { failureSchema } from "../lib/contracts/index.js";

const reference = (opened) => ({ reviewId: opened.review.reviewId, entryKey: opened.review.entryKey });

test("stale and duplicate complete responses cannot clear a newer submission", async (t) => {
  const f = await fixture(t), ref = reference(await f.open(f.file()));
  const original = await f.thread(ref, { body: "First" });
  await f.send(ref, [original]);
  const first = (await f.poll(ref)).submission, body = responseFor(first);
  const receipt = await f.ok(body);
  const followup = await f.mutate(ref, "reply", { threadId: original.value.threadId, body: "Second", intent: "discuss" });
  await f.send(ref, [followup]);
  const second = (await f.poll(ref)).submission;
  assert.notEqual(second.submissionId, first.submissionId);
  assert.deepEqual(await f.ok(body), receipt);
  assert.deepEqual((await f.poll(ref)).submission, second);
  const changed = await f.call({ ...body, resultNote: "Changed replay" });
  assert.equal(changed.body.error.code, "REQUEST_CONFLICT");
  await f.ok(responseFor(second));
  assert.equal((await f.read(ref, "submission", { submissionId: first.submissionId })).submission.state, "handled");
  assert.equal((await f.read(ref, "submission", { submissionId: second.submissionId })).submission.state, "handled");
});

test("concurrent pollers receive one immutable submission after delivery is durable", async (t) => {
  const f = await fixture(t), ref = reference(await f.open(f.file()));
  await f.send(ref, [await f.thread(ref)]);
  const [left, right] = await Promise.all([f.read(ref, "poll"), f.read(ref, "poll")]);
  assert.deepEqual(left.submission, right.submission);
  assert.equal(left.submission.version, 2);
  const persisted = JSON.parse(fs.readFileSync(statePath(), "utf8")).conversations.reviews[ref.reviewId];
  assert.deepEqual(persisted.submissions[left.submission.submissionId], left.submission);
});

test("queued submissions survive restart and corrections are new unsent messages, never in-place revisions", async (t) => {
  const f = await fixture(t), ref = reference(await f.open(f.file()));
  const original = await f.thread(ref, { body: "Original queued wording" });
  const sent = await f.send(ref, [original]);
  await f.restart();
  const update = await f.call({
    operation: "update-message", ...ref, requestId: "immutable-queued", expectedVersion: (await f.read(ref)).version,
    threadId: original.value.threadId, messageId: original.value.messageId, messageVersion: 1,
    body: "Replacement", intent: "discuss",
  });
  assert.equal(update.body.error.code, "MESSAGE_IMMUTABLE");
  const corrected = await f.mutate(ref, "reply", { threadId: original.value.threadId, body: "Correction", intent: "discuss" });
  const delivered = (await f.poll(ref)).submission;
  assert.equal(delivered.submissionId, sent.value.submissionId);
  assert.equal(delivered.messages[0].message.body, "Original queued wording");
  await f.ok(responseFor(delivered));
  await f.send(ref, [corrected]);
  assert.equal((await f.poll(ref)).submission.messages[0].message.body, "Correction");
});

test("delivered work survives restart and completion preserves newer unsent corrections", async (t) => {
  const f = await fixture(t), ref = reference(await f.open(f.file()));
  const original = await f.thread(ref);
  await f.send(ref, [original]);
  const delivered = (await f.poll(ref)).submission;
  await f.restart();
  assert.deepEqual((await f.poll(ref)).submission, delivered);
  const correction = await f.mutate(ref, "reply", { threadId: original.value.threadId, body: "Newer correction", intent: "request-change" });
  await f.ok(responseFor(delivered));
  await f.send(ref, [correction]);
  const next = (await f.poll(ref)).submission;
  assert.equal(next.messages.length, 1);
  assert.equal(next.messages[0].message.body, "Newer correction");
  assert.equal(next.messages[0].message.intent, "request-change");
});

test("obsolete batches are untouched, never imported or acknowledged through public routes", async (t) => {
  const f = await fixture(t);
  const obsolete = path.join(f.state, "state.json");
  const bytes = '{"pages":{},"batches":{"old":{"batch_id":"old"}}}';
  fs.writeFileSync(obsolete, bytes);
  await f.restart();
  const ref = reference(await f.open(f.file()));
  await f.send(ref, [await f.thread(ref)]);
  for (const route of ["/api/poll?ack=old", "/api/status", "/api/session"]) {
    const response = await fetch(`http://127.0.0.1:${f.server.port}${route}`, {
      headers: { "x-doc-review-token": f.server.token },
    });
    assert.equal(response.status, 410);
    assert.equal(failureSchema.parse(await response.json()).error.code, "WORKFLOW_REMOVED");
  }
  assert.equal(fs.readFileSync(obsolete, "utf8"), bytes);
  assert.equal((await f.poll(ref)).submission.state, "delivered");
});

test("failed response persistence preserves pending work and staged assets; successful handling retains referenced assets", async (t) => {
  const f = await fixture(t), ref = reference(await f.open(f.file("image.md", "# Image")));
  const asset = await f.ok({ ...ref, pageKey: ref.entryKey, type: "image/png", base64: "aW1hZ2U=" }, "/api/conversation/asset");
  const recorded = await f.mutate(ref, "record-edit", {
    pageKey: ref.entryKey, content: editContent("Image", "Image", {
      after_html: `<p>Image<img src="${asset.preview_src}"></p>`, staged_assets: [asset],
    }),
  });
  await f.send(ref, [], [{ pageKey: ref.entryKey, editId: recorded.value.editId, version: 1 }]);
  const work = (await f.poll(ref)).submission, response = responseFor(work);
  const staged = work.edits[0].assets[0].path;
  const before = fs.readFileSync(statePath(), "utf8"), write = f.server.store.write;
  f.server.store.write = () => { throw new Error("injected response persistence failure"); };
  const failed = await f.call(response);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, "STATE_PERSIST_FAILED");
  assert.equal(fs.readFileSync(statePath(), "utf8"), before);
  assert.ok(fs.existsSync(staged));
  f.server.store.write = write;
  await f.ok(response);
  await f.restart();
  assert.equal((await f.read(ref, "submission", { submissionId: work.submissionId })).submission.state, "handled");
  assert.equal(fs.readFileSync(staged, "utf8"), "image");
});
