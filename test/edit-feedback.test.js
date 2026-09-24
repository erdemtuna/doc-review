import assert from "node:assert/strict";
import test from "node:test";
import { fixture, editContent, responseFor } from "./fixtures/agent-loop.js";
import { limitEditFields, MAX_EDIT_CHARACTERS } from "../lib/edit-limits.js";
import { directEditContentSchema } from "../lib/contracts/index.js";

function bounded(before, after, extra = {}) {
  const limited = limitEditFields({ before, after, after_html: after, ...extra });
  return directEditContentSchema.parse({
    label: "Paragraph", kind: "edited", ...limited.fields,
    truncated: limited.truncated, truncated_fields: limited.truncated_fields, staged_assets: [],
  });
}

test("long feedback is bounded by the producer, explicitly flagged, immutable across delivery and restart", { timeout: 30000 }, async (t) => {
  const f = await fixture(t), opened = await f.open(f.file("long.md", "# Original"));
  const ref = { reviewId: opened.review.reviewId, entryKey: opened.review.entryKey }, edits = [];
  for (const length of [6000, MAX_EDIT_CHARACTERS, MAX_EDIT_CHARACTERS + 1, 250000]) {
    const text = "x".repeat(length), content = bounded("Original", text);
    const record = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content });
    edits.push({ pageKey: ref.entryKey, editId: record.value.editId, version: 1 });
    assert.equal(content.after, text.slice(0, MAX_EDIT_CHARACTERS));
    assert.equal(content.truncated, length > MAX_EDIT_CHARACTERS);
    assert.deepEqual(content.truncated_fields, length > MAX_EDIT_CHARACTERS ? ["after", "after_html"] : []);
  }
  const invalid = await f.call({ operation: "record-edit", ...ref, pageKey: ref.entryKey,
    requestId: "unbounded", expectedVersion: (await f.read(ref)).version, content: editContent("Original", "x".repeat(250000)) });
  assert.equal(invalid.body.error.code, "INPUT_TOO_LARGE", "server never silently truncates");
  await f.send(ref, [], edits);
  const work = (await f.poll(ref)).submission;
  assert.equal(work.edits[0].content.after.length, 6000);
  assert.equal(work.edits[1].content.truncated, false);
  assert.deepEqual(work.edits[2].content.truncated_fields, ["after", "after_html"]);
  const applied = responseFor(work);
  applied.editOutcomes[2].outcome = "applied";
  assert.equal((await f.call(applied)).body.error.code, "SAVE_EVIDENCE_CONFLICT");
  await f.restart();
  assert.deepEqual((await f.poll(ref)).submission, work);
  const obsolete = await f.cli("poll", opened.review.entryKey, "--timeout", "5");
  assert.equal(obsolete.code, 1);
  assert.equal(obsolete.body.error.code, "INVALID_INPUT");
});

test("explicit edit replacement clears shortened flags while preserving the producer's exact original metadata", async (t) => {
  const f = await fixture(t), opened = await f.open(f.file("shortening.md", "# Original"));
  const ref = { reviewId: opened.review.reviewId, entryKey: opened.review.entryKey };
  const long = "x".repeat(MAX_EDIT_CHARACTERS + 1);
  const first = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: bounded("Original", long) });
  await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, editId: first.value.editId, editVersion: 1,
    content: bounded("Original", "Short", { after_html: "<b>Short</b>" }) });
  const second = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: bounded(long, long) });
  await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, editId: second.value.editId, editVersion: 1,
    content: bounded(long, "Short") });
  await f.send(ref, [], [first, second].map(({ value }) => ({ pageKey: ref.entryKey, editId: value.editId, version: 2 })));
  const edits = (await f.poll(ref)).submission.edits;
  assert.equal(edits.length, 2);
  assert.equal(edits[0].content.before, "Original");
  assert.equal(edits[0].content.after_html, "<b>Short</b>");
  assert.equal(edits[0].content.truncated, false);
  assert.deepEqual(edits[0].content.truncated_fields, []);
  assert.equal(edits[1].content.before.length, MAX_EDIT_CHARACTERS);
  assert.equal(edits[1].content.truncated, true);
  assert.deepEqual(edits[1].content.truncated_fields, ["before"]);
});
