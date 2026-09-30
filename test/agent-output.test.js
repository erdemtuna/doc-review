import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fixture, responseFor, scopeArgs, editContent } from "./fixtures/agent-loop.js";
import * as c from "../lib/contracts/index.js";
import { readAgent, serializeAgent } from "../lib/agent-output.js";
import { Conversations } from "../lib/conversation-store.js";

const actual = JSON.parse(fs.readFileSync(new URL("./fixtures/agent-real-data.json", import.meta.url), "utf8"));
const ref = (opened) => ({ reviewId: opened.review.reviewId, entryKey: opened.review.entryKey });
const success = (result) => {
  assert.equal(result.code, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout) <= c.AGENT_OUTPUT_BYTES);
  return result.body;
};
const digest = (text) => createHash("sha256").update(text).digest("hex");

test("actual comment, SKILL transition and review report meet final public payload targets", async (t) => {
  const f = await fixture(t);
  const scope = ref(await f.open(f.file("actual.md", actual.edit.before)));
  await f.send(scope, [await f.thread(scope, { body: actual.comment, intent: "request-change" })]);
  const short = await f.cli("poll", ...scopeArgs(scope), "--timeout", "5");
  const work = success(short).submission;
  assert.ok(Buffer.byteLength(short.stdout) <= 4096, `short: ${Buffer.byteLength(short.stdout)}`);
  assert.equal(work.inventory.items.find((item) => item.kind === "message").body.text, actual.comment);
  success(await f.respond(scope, responseFor(work, { resultNote: actual.report })));
  const status = await f.cli("status", ...scopeArgs(scope));
  const result = success(status).latestSubmission.result;
  assert.ok(Buffer.byteLength(status.stdout) <= 2048, `status: ${Buffer.byteLength(status.stdout)}`);
  assert.equal(result.body.utf8Bytes, 8370);
  assert.equal(success(await f.run(result.body.command)).text, actual.report);

  const edit = await f.mutate(scope, "record-edit", { pageKey: scope.entryKey, content: actual.edit });
  await f.send(scope, [], [{ pageKey: scope.entryKey, editId: edit.value.editId, version: 1 }]);
  const polled = await f.cli("poll", ...scopeArgs(scope), "--timeout", "5");
  const manifest = success(polled).submission;
  assert.ok(Buffer.byteLength(polled.stdout) <= 6144, `edit: ${Buffer.byteLength(polled.stdout)}`);
  const delivered = manifest.inventory.items.find((item) => item.kind === "edit");
  assert.equal(delivered.captureTruncated, false);
  assert.equal(delivered.source.value.state, "pending");
  for (const name of ["before", "after", "before_html", "after_html"]) {
    const info = delivered.content.fields.find((field) => field.name === name);
    assert.equal(info.utf8Bytes, Buffer.byteLength(actual.edit[name]));
    assert.equal(info.sha256, digest(actual.edit[name]));
    const exported = success(await f.cli("content", ...scopeArgs(scope), "--submission", manifest.submissionId,
      "--field", `submission/edits/0/content/${name}`, "--output-file", `${name}.txt`));
    assert.deepEqual(fs.readFileSync(exported.path), Buffer.from(actual.edit[name]));
  }
  success(await f.respond(scope, responseFor(manifest)));
  await f.restart();
  fs.unlinkSync(path.join(f.root, "actual.md"));
  const oldRef = success(await f.run(`${delivered.content.command} --output-file retained-edit.json`));
  assert.deepEqual(JSON.parse(fs.readFileSync(oldRef.path, "utf8")), actual.edit, "immutable edit ref survives lifecycle changes");
  const history = success(await f.cli("history", ...scopeArgs(scope), "--before", manifest.submissionId, "--limit", "1"));
  assert.equal(history.items[0].result.body.text, actual.report);
  t.diagnostic(JSON.stringify({ shortBytes: Buffer.byteLength(short.stdout), editBytes: Buffer.byteLength(polled.stdout), statusBytes: Buffer.byteLength(status.stdout) }));
});

test("escaped Unicode chunks reconstruct exactly, reject cross-scope/version cursors, and never replace existing artifacts", async (t) => {
  const f = await fixture(t), scope = ref(await f.open(f.file("unicode.md", "Original")));
  const exact = '😀"\\\r\né\t'.repeat(13000);
  const edited = editContent("Original", exact, { after_html: exact, truncated: true, truncated_fields: ["after", "after_html"] });
  const e = await f.mutate(scope, "record-edit", { pageKey: scope.entryKey, content: edited });
  await f.send(scope, [], [{ pageKey: scope.entryKey, editId: e.value.editId, version: 1 }]);
  const work = (await f.poll(scope)).submission;
  const edit = work.inventory.items.find((item) => item.kind === "edit");
  assert.equal(edit.captureTruncated, true);
  assert.deepEqual(edit.truncatedFields, edited.truncated_fields);
  const args = ["content", ...scopeArgs(scope), "--submission", work.submissionId, "--field", "submission/edits/0/content/after"];
  let first, text = "", next;
  do {
    const chunk = success(await f.cli(...args, ...(next ? ["--cursor", next] : [])));
    first ??= chunk;
    assert.equal(chunk.offset, Buffer.byteLength(text));
    assert.equal(chunk.returnedBytes, Buffer.byteLength(chunk.text));
    assert.doesNotMatch(chunk.text, /[\uD800-\uDBFF]$/);
    text += chunk.text; next = chunk.nextCursor;
  } while (next);
  assert.equal(text, exact);
  assert.equal(first.sha256, digest(exact));
  assert.equal(first.utf8Bytes, Buffer.byteLength(exact));
  const wrongField = await f.cli("content", ...scopeArgs(scope), "--submission", work.submissionId,
    "--field", "submission/edits/0/content/after_html", "--cursor", first.nextCursor);
  assert.equal(wrongField.body.error.code, "INVALID_CURSOR");
  assert.equal((await f.cli(...args, "--version", "999")).body.error.code, "VERSION_CONFLICT");
  const other = ref(await f.open(f.file()));
  assert.equal((await f.cli("content", ...scopeArgs(other), "--submission", work.submissionId, "--field", ".")).code, 1);
  const output = success(await f.cli(...args, "--output-file", "exact.txt"));
  assert.deepEqual(fs.readFileSync(output.path), Buffer.from(exact));
  assert.equal((await f.cli(...args, "--output-file", output.path)).body.error.code, "REQUEST_CONFLICT");
  const original = path.join(f.root, "unicode.md"), bytes = fs.readFileSync(original);
  assert.equal((await f.cli(...args, "--output-file", original)).body.error.code, "REQUEST_CONFLICT");
  assert.deepEqual(fs.readFileSync(original), bytes);
  assert.ok(fs.readdirSync(f.root).every((name) => !name.endsWith(".tmp")));
});

test("many small records page completely and templates cover all pages with invalid blanks and stable retry files", async (t) => {
  const f = await fixture(t), scope = ref(await f.open(f.file()));
  const messages = [];
  for (let i = 0; i < 90; i++) messages.push(await f.thread(scope, { body: `Question ${i}` }));
  await f.send(scope, messages, [], { overallNote: { intent: "discuss", body: "Summarize all questions." } });
  const work = (await f.poll(scope)).submission;
  assert.equal(work.inventory.totalCount, 91);
  assert.equal(work.inventory.complete, false);
  const inventory = [...work.inventory.items];
  let next = work.inventory.nextCursor;
  while (next) {
    const page = success(await f.cli("submission", ...scopeArgs(scope), "--submission", work.submissionId, "--cursor", next)).inventory;
    inventory.push(...page.items); next = page.nextCursor;
  }
  assert.equal(inventory.length, 91);
  assert.equal(new Set(inventory.filter((i) => i.kind === "message").map((i) => i.messageId)).size, 90);
  const receipt = success(await f.run(work.handoff.templateCommand));
  const original = fs.readFileSync(receipt.path), template = JSON.parse(original);
  assert.equal(template.responses.length, 90);
  assert.equal(template.overallOutcome, "");
  assert.throws(() => c.completeResponseSchema.parse(template));
  assert.equal((await f.run(work.handoff.templateCommand)).body.error.code, "REQUEST_CONFLICT");
  assert.deepEqual(fs.readFileSync(receipt.path), original);
  template.responses.forEach((r) => { r.body = "Answered."; r.outcome = "answered"; });
  template.overallOutcome = "answered"; template.resultNote = "All questions answered.";
  fs.writeFileSync(receipt.path, JSON.stringify(template));
  const accepted = success(await f.run(work.handoff.responseCommand));
  assert.deepEqual(success(await f.run(work.handoff.responseCommand)), accepted);
  await f.send(scope, [], [], { overallNote: { body: "Next question", intent: "discuss" } });
  const second = (await f.poll(scope)).submission;
  const secondReceipt = success(await f.run(second.handoff.templateCommand));
  assert.notEqual(secondReceipt.path, receipt.path);
  const other = ref(await f.open(f.file()));
  await f.send(other, [await f.thread(other)]);
  const parallel = success(await f.run((await f.poll(other)).submission.handoff.templateCommand));
  assert.notEqual(parallel.path, secondReceipt.path);
});

test("history cursors retain their high-water across later submissions and ended reviews remain readable offline", async (t) => {
  const f = await fixture(t), scope = ref(await f.open(f.file()));
  for (let i = 0; i < 3; i++) {
    await f.send(scope, [], [], { overallNote: { intent: "discuss", body: `Prior note ${i}` } });
    success(await f.respond(scope, responseFor((await f.poll(scope)).submission)));
  }
  const first = success(await f.cli("history", ...scopeArgs(scope), "--limit", "1"));
  await f.send(scope, [], [], { overallNote: { intent: "discuss", body: "Newer note" } });
  const current = (await f.poll(scope)).submission;
  success(await f.respond(scope, responseFor(current)));
  const older = success(await f.cli("history", ...scopeArgs(scope), "--cursor", first.nextCursor));
  assert.equal(older.totalCount, 3);
  assert.equal(older.items.length, 2);
  await f.mutate(scope, "end", { confirmUnsentReadOnly: true });
  await f.restart();
  assert.equal(success(await f.cli("submission", ...scopeArgs(scope), "--submission", first.items[0].submissionId)).state, "handled");
  await f.stop();
  assert.equal(success(await f.cli("status", ...scopeArgs(scope))).source, "disk");
});

test("oversized metadata is an explicit bounded failure, never a success-shaped empty page", () => {
  assert.throws(() => serializeAgent({ error: '"'.repeat(20000) }), { code: "INPUT_TOO_LARGE" });
  const scope = { reviewId: "r".repeat(20000), entryKey: "entry" };
  const review = { ...scope, version: 1, state: "open", createdAt: 0, endedAt: null };
  const conversations = new Conversations({ data: { conversations: { reviews: {
    [scope.reviewId]: { review, submissions: {}, messages: {}, edits: {}, pages: {}, sequence: 0 },
  } } } });
  assert.throws(() => readAgent(conversations, { operation: "history", ...scope }, "doc-review"), { code: "INPUT_TOO_LARGE" });
});

test("undeliverable receipt identities fail BEFORE mutation acceptance, not after a persisted success", async (t) => {
  const f = await fixture(t), file = f.file();
  const requestId = '"'.repeat(9000);
  const opened = await f.cli(file, "--no-browser", "--request-id", requestId);
  assert.equal(opened.body.error.code, "INPUT_TOO_LARGE");
  assert.ok(Buffer.byteLength(opened.stdout) <= c.AGENT_OUTPUT_BYTES);
  const missing = await f.ok({ operation: "open-receipt", target: file, requestId });
  assert.equal(missing.state, "not-found");
  const scope = ref(await f.open(file));
  await f.send(scope, [await f.thread(scope)]);
  const work = (await f.poll(scope)).submission;
  const failed = await f.respond(scope, responseFor(work, { requestId }));
  assert.equal(failed.body.error.code, "INPUT_TOO_LARGE");
  assert.ok(Buffer.byteLength(failed.stdout) <= c.AGENT_OUTPUT_BYTES);
  assert.equal((await f.read(scope, "receipt", { requestId })).state, "not-found");
  assert.equal((await f.read(scope, "submission", { submissionId: work.submissionId })).submission.state, "delivered");
});
