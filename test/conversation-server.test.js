import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { start } from "../lib/server.js";
import { Store, atomicWrite } from "../lib/state.js";
import { statePath, targetKey, SERVER_PROTOCOL } from "../lib/paths.js";
import { acquireServerLock } from "../lib/server-lock.js";
import * as contract from "../lib/contracts/index.js";

const rid = () => crypto.randomUUID();
const edit = (before, after, extra = {}) => ({
  label: "Paragraph", kind: "edited", before, after,
  before_html: `<p>${before}</p>`, after_html: `<p>${after}</p>`,
  truncated: false, truncated_fields: [], staged_assets: [], ...extra,
});
const selection = { kind: "selection", anchor: { quote: "Original", prefix: "", suffix: "" } };
const semantic = (text) => ({ version: 1, blocks: [{ id: "p1", tag: "p", selector: "p", text, path: [], attributes: {}, runs: [{ text, marks: [] }] }], limitations: [] });
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-producer-"));
  process.env.DOC_REVIEW_STATE_DIR = path.join(root, "state");
  let server = await start(0, options);
  t.after(async () => { await server.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const call = async (body, route = "/api/conversation", token = server.token) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
      method: "POST", headers: { "x-doc-review-token": token, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) contract.failureSchema.parse(result);
    return { status: response.status, body: result };
  };
  const ok = async (body, route) => {
    const result = await call(body, route);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const file = (name = `${rid()}.html`, html = "<p>Original</p>") => {
    const target = path.join(root, name);
    fs.writeFileSync(target, html);
    return target;
  };
  const open = async (target = file()) => {
    const accepted = contract.acceptedMutationSchema.parse(await ok({ operation: "open", requestId: rid(), target }));
    return { reviewId: accepted.receipt.reviewId, entryKey: accepted.receipt.entryKey };
  };
  const read = (ref, operation = "read-review", extra = {}) => ok({ operation, ...ref, ...extra });
  const request = async (ref, operation, fields = {}) => ({
    operation, ...ref, requestId: rid(), expectedVersion: (await read(ref)).version, ...fields,
  });
  const mutate = async (ref, operation, fields = {}) => {
    const result = await ok(await request(ref, operation, fields));
    return contract.acceptedMutationSchema.parse(result).receipt;
  };
  const thread = (ref, fields = {}) => mutate(ref, "create-thread", {
    pageKey: ref.entryKey, target: selection, body: "Explain this", intent: "discuss", ...fields,
  });
  const send = (ref, messages = [], edits = [], extra = {}) => mutate(ref, "send", {
    pageKeys: [ref.entryKey], messages: messages.map((receipt) => ({
      threadId: receipt.value.threadId, messageId: receipt.value.messageId, version: 1,
    })), edits, ...extra,
  });
  const note = (ref, extra = {}) => send(ref, [], [], { overallNote: { body: "Thoughts?", intent: "discuss" }, ...extra });
  const poll = async (ref) => contract.pollResponseSchema.parse(await read(ref, "poll"));
  const response = (work, fields = {}) => ({
    operation: "respond", reviewId: work.reviewId, entryKey: work.entryKey, requestId: rid(),
    submissionId: work.submissionId, expectedVersion: work.version,
    responses: work.messages.map(({ message }) => ({
      threadId: message.threadId, messageId: message.messageId, messageVersion: message.version,
      body: "Here is the answer.", outcome: "answered",
    })),
    editOutcomes: work.edits.map((item) => ({
      editId: item.editId, editVersion: item.version,
      outcome: item.source.state === "saved" ? "already-saved" : "deferred", reason: "Preserved exact human work.",
    })),
    resultNote: "Answered the review.",
    ...(work.overallNote ? { overallOutcome: "answered" } : {}), ...fields,
  });
  const list = (ref, collection, extra = {}, query = {}) => ok({
    operation: "list", scope: { ...ref, collection, pageKey: null, threadId: null, submissionId: null, status: "all", ...extra }, query,
  });
  const restart = async () => { await server.dispose(); server = await start(); };
  return { root, get server() { return server; }, call, ok, file, open, read, request, mutate, thread, send, note, poll, response, list, restart };
}
test("saved staged previews remain translatable in subsequent independently proven edits", async (t) => {
  const f = await fixture(t);
  const file = f.file("retained-preview.html", "<p>Original</p><p>Other</p>");
  const ref = await f.open(file);
  const asset = await f.ok({ ...ref, pageKey: ref.entryKey, type: "image/png", base64: "aW1hZ2U=" }, "/api/conversation/asset");
  const imageHtml = `<p>Original<img src="${asset.preview_src}"></p>`;
  const first = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey,
    content: edit("Original", "Original", { after_html: imageHtml, staged_assets: [asset] }) });
  const save = async (record, html) => f.mutate(ref, "save-edit", {
    pageKey: ref.entryKey, editId: record.value.editId, editVersion: 1,
    expectedSourceHash: (await f.read(ref, "read-page", { pageKey: ref.entryKey })).page.sourceHash, html,
  });
  await save(first, `${imageHtml}<p>Other</p>`);
  const second = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: edit("Other", "Exact next edit") });
  await save(second, `${imageHtml}<p>Exact next edit</p>`);
  assert.match(fs.readFileSync(file, "utf8"), /src="assets\/paste_.*Exact next edit/);
  const records = (await f.list(ref, "edits")).items;
  assert.equal(records.every((item) => item.source.state === "saved"), true);
  const rejectedEdit = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: edit("Exact next edit", "New") });
  const invalid = await f.request(ref, "save-edit", { pageKey: ref.entryKey, editId: rejectedEdit.value.editId, editVersion: 1,
    expectedSourceHash: (await f.read(ref, "read-page", { pageKey: ref.entryKey })).page.sourceHash,
    html: `${imageHtml}<p>New</p><p>Unrecorded</p>` });
  rejected(await f.call(invalid), "SAVE_EVIDENCE_CONFLICT");
});

const rejected = (result, code) => {
  assert.equal(result.body.ok, false, JSON.stringify(result));
  assert.equal(result.body.error.code, code, JSON.stringify(result));
};

test("receipt identities are scoped by review or canonical open entry, with separate operation namespaces", async (t) => {
  const f = await fixture(t);
  const requestId = '__proto__:["open","review"]|shared';
  const targets = [f.file("scope-a.html"), f.file("scope-b.html")];
  const opens = targets.map((target) => ({ operation: "open", target, requestId }));
  const opened = await Promise.all(opens.map((request) => f.ok(request)));
  const refs = opened.map(({ receipt }) => ({ reviewId: receipt.reviewId, entryKey: receipt.entryKey }));
  assert.notEqual(refs[0].reviewId, refs[1].reviewId);
  const mutations = await Promise.all(refs.map((ref) => f.request(ref, "create-thread", {
    requestId, pageKey: ref.entryKey, target: selection, body: "Independent request", intent: "discuss",
  })));
  const accepted = await Promise.all(mutations.map((request) => f.ok(request)));
  for (let index = 0; index < refs.length; index++) {
    assert.equal(accepted[index].receipt.reviewId, refs[index].reviewId);
    assert.deepEqual(await f.read(refs[index], "receipt", { requestId }), { state: "accepted", receipt: accepted[index].receipt });
    assert.deepEqual(await f.ok({ operation: "open-receipt", target: targets[index], requestId }),
      { state: "accepted", receipt: opened[index].receipt });
    assert.deepEqual(await f.ok(opens[index]), opened[index]);
    rejected(await f.call({ ...mutations[index], body: "Changed within the same review" }), "REQUEST_CONFLICT");
    rejected(await f.call(await f.request(refs[index], "end", { requestId, confirmUnsentReadOnly: true })), "REQUEST_CONFLICT");
  }
  const canonicalAlias = `${path.dirname(targets[0])}${path.sep}.${path.sep}${path.basename(targets[0])}`;
  rejected(await f.call({ ...opens[0], target: canonicalAlias }), "REQUEST_CONFLICT");
  rejected(await f.call({ operation: "open-receipt", target: canonicalAlias, requestId }), "REQUEST_CONFLICT");
  const unrelatedTarget = f.file("scope-unused.html");
  const unrelated = await f.open(unrelatedTarget);
  assert.deepEqual(await f.read(unrelated, "receipt", { requestId }), { state: "not-found", requestId });
  assert.deepEqual(await f.ok({ operation: "open-receipt", target: unrelatedTarget, requestId }), { state: "not-found", requestId });

  await f.mutate(refs[0], "end", { confirmUnsentReadOnly: true });
  const fresh = await f.open(targets[0]);
  assert.notEqual(fresh.reviewId, refs[0].reviewId);
  assert.deepEqual(await f.read(fresh, "receipt", { requestId }), { state: "not-found", requestId });
  const freshRequest = await f.request(fresh, "create-thread", {
    requestId, pageKey: fresh.entryKey, target: selection, body: "Same ID, new review", intent: "discuss",
  });
  const freshAccepted = await f.ok(freshRequest);
  await f.restart();
  for (let index = 0; index < refs.length; index++) {
    assert.deepEqual(await f.ok(opens[index]), opened[index]);
    assert.deepEqual(await f.ok(mutations[index]), accepted[index]);
    assert.deepEqual(await f.read(refs[index], "receipt", { requestId }), { state: "accepted", receipt: accepted[index].receipt });
  }
  assert.deepEqual(await f.ok(freshRequest), freshAccepted);
  const scopedKeys = Object.keys(f.server.store.data.conversations.requests).map((key) => JSON.parse(key))
    .filter((parts) => parts[2] === requestId);
  assert.deepEqual(scopedKeys.sort(), [
    ["open", refs[0].entryKey, requestId], ["open", refs[1].entryKey, requestId],
    ["review", refs[0].reviewId, requestId], ["review", refs[1].reviewId, requestId], ["review", fresh.reviewId, requestId],
  ].sort());
});

test("submission versions advance only on delivery and terminal transitions, with stable replay after restart", async (t) => {
  const f = await fixture(t);
  const ref = await f.open();
  const sent = await f.note(ref);
  const queued = (await f.read(ref, "submission", { submissionId: sent.value.submissionId })).submission;
  assert.equal(queued.version, 1);
  const abandon = { operation: "abandon", ...ref, requestId: rid(), submissionId: queued.submissionId,
    expectedVersion: queued.version, confirmExternalWorkMayContinue: true, reason: "Queued version must expire on pickup" };
  const delivered = (await f.poll(ref)).submission;
  assert.equal(delivered.version, 2);
  assert.deepEqual((await f.poll(ref)).submission, delivered);
  rejected(await f.call(abandon), "VERSION_CONFLICT");
  const response = f.response(delivered);
  rejected(await f.call({ ...response, expectedVersion: queued.version }), "VERSION_CONFLICT");
  await f.mutate(ref, "end", { confirmUnsentReadOnly: true });
  assert.equal((await f.read(ref, "submission", { submissionId: delivered.submissionId })).submission.version, 2);
  const accepted = await f.ok(response);
  const completed = contract.submissionReadSchema.parse(await f.read(ref, "submission", { submissionId: delivered.submissionId }));
  assert.equal(completed.submission.version, 3);
  assert.equal(completed.submission.state, "handled");
  await f.restart();
  assert.deepEqual(await f.ok(response), accepted);
  assert.deepEqual(await f.read(ref, "submission", { submissionId: delivered.submissionId }), completed);
  for (const pickup of [false, true]) {
    const other = await f.open();
    const pending = await f.note(other);
    const work = pickup ? (await f.poll(other)).submission :
      (await f.read(other, "submission", { submissionId: pending.value.submissionId })).submission;
    const abandonRequest = { operation: "abandon", ...other, requestId: rid(), submissionId: work.submissionId,
      expectedVersion: work.version, confirmExternalWorkMayContinue: true, reason: "Deliberate terminal transition" };
    const receipt = await f.ok(abandonRequest);
    const abandoned = contract.submissionReadSchema.parse(await f.read(other, "submission", { submissionId: work.submissionId }));
    assert.equal(abandoned.submission.version, pickup ? 3 : 2);
    assert.equal(abandoned.submission.state, "abandoned");
    assert.equal(abandoned.result, null);
    await f.mutate(other, "end", { confirmUnsentReadOnly: true });
    await f.restart();
    assert.deepEqual(await f.ok(abandonRequest), receipt);
    assert.equal((await f.poll(other)).state, "ended");
    assert.deepEqual(await f.read(other, "submission", { submissionId: work.submissionId }), abandoned);
  }
});

test("edit paging is an actionable unsubmitted list; deferred and abandoned edits remain only in submission history", async (t) => {
  const f = await fixture(t);
  for (const terminal of ["deferred", "abandoned-queued", "abandoned-delivered"]) {
    const ref = await f.open();
    const submitted = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: edit("Original", "Selected") });
    const unsent = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: edit("Original", "Keep pending") });
    const before = await f.list(ref, "edits");
    assert.equal(before.totalCount, 2);
    const exactEdit = before.items.find((item) => item.editId === submitted.value.editId);
    const sent = await f.send(ref, [], [{ pageKey: ref.entryKey, editId: exactEdit.editId, version: exactEdit.version }]);
    const assertPending = async (expectedIds) => {
      const page = contract.directEditPageSchema.parse(await f.list(ref, "edits", { pageKey: ref.entryKey }, { limit: 1 }));
      const all = [...page.items];
      if (page.nextCursor) all.push(...(await f.list(ref, "edits", { pageKey: ref.entryKey }, { limit: 1, cursor: page.nextCursor })).items);
      assert.equal(page.totalCount, expectedIds.length);
      assert.deepEqual(all.map((item) => item.editId).sort(), [...expectedIds].sort());
      assert.equal((await f.read(ref, "status")).pendingEditCount, expectedIds.length);
      assert.equal((await f.read(ref, "read-page", { pageKey: ref.entryKey })).pendingEditCount, expectedIds.length);
      assert.equal((await f.list(ref, "pages")).items[0].pendingEditCount, expectedIds.length);
    };
    await assertPending([unsent.value.editId]);
    const work = terminal === "abandoned-queued"
      ? (await f.read(ref, "submission", { submissionId: sent.value.submissionId })).submission
      : (await f.poll(ref)).submission;
    if (terminal === "deferred") await f.ok(f.response(work));
    else await f.ok({ operation: "abandon", ...ref, requestId: rid(), submissionId: work.submissionId,
      expectedVersion: work.version, confirmExternalWorkMayContinue: true, reason: "Retain rather than resend" });
    await assertPending([unsent.value.editId]);
    const archived = await f.read(ref, "submission", { submissionId: work.submissionId });
    assert.deepEqual(archived.submission.edits, [exactEdit]);
    if (terminal === "deferred") assert.equal(archived.result.editOutcomes[0].outcome, "deferred");
    else assert.equal(archived.submission.state, "abandoned");
    rejected(await f.call(await f.request(ref, "record-edit", {
      pageKey: ref.entryKey, editId: exactEdit.editId, editVersion: exactEdit.version, content: exactEdit.content,
    })), "MESSAGE_IMMUTABLE");
    const deliberate = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: exactEdit.content });
    assert.notEqual(deliberate.value.editId, exactEdit.editId);
    await f.restart();
    await assertPending([unsent.value.editId, deliberate.value.editId]);
    const history = await f.list(ref, "history");
    assert.equal(history.items[0].submissionId, work.submissionId);
    assert.deepEqual(await f.read(ref, "submission", { submissionId: work.submissionId }), archived);
  }
});

test("restart rejects unscoped receipt keys, foreign scope and corrupted lifecycle versions without repair", async (t) => {
  const f = await fixture(t);
  const ref = await f.open();
  await f.note(ref);
  const work = (await f.poll(ref)).submission;
  const response = f.response(work);
  const accepted = await f.ok(response);
  const disk = fs.readFileSync(statePath(), "utf8");
  for (const corrupt of [
    (data) => {
      const key = JSON.stringify(["review", ref.reviewId, response.requestId]);
      data.conversations.requests[response.requestId] = data.conversations.requests[key];
      delete data.conversations.requests[key];
    },
    (data) => {
      const key = JSON.stringify(["review", ref.reviewId, response.requestId]);
      data.conversations.requests[key].receipt.entryKey = "foreign-entry";
    },
    (data) => { data.conversations.reviews[ref.reviewId].submissions[work.submissionId].version--; },
    (data) => {
      const record = data.conversations.requests[JSON.stringify(["review", ref.reviewId, response.requestId])];
      record.canonicalPayload = contract.canonicalJson({ ...response, expectedVersion: response.expectedVersion - 1 });
    },
  ]) {
    const data = JSON.parse(disk);
    corrupt(data);
    const bytes = JSON.stringify(data);
    fs.writeFileSync(statePath(), bytes);
    assert.throws(() => new Store(), /receipt scope|lifecycle version|Submission version changed/);
    assert.equal(fs.readFileSync(statePath(), "utf8"), bytes);
  }
  fs.writeFileSync(statePath(), disk);
  await f.restart();
  assert.deepEqual(await f.ok(response), accepted);
});

test("real producers: open/join, immutable instructions, complete atomic response, retained unsent and exact retries", async (t) => {
  const f = await fixture(t);
  const target = f.file();
  const ref = await f.open(target);
  assert.deepEqual(await f.open(target), ref);
  const first = await f.thread(ref);
  const stale = await f.request(ref, "reply", { threadId: first.value.threadId, body: "Stale", intent: "discuss" });
  const queued = await f.send(ref, [first]);
  rejected(await f.call(stale), "VERSION_CONFLICT");
  rejected(await f.call(await f.request(ref, "update-message", {
    threadId: first.value.threadId, messageId: first.value.messageId, messageVersion: 1, body: "Replace", intent: "request-change",
  })), "MESSAGE_IMMUTABLE");
  const newer = await f.mutate(ref, "reply", { threadId: first.value.threadId, body: "Unsent followup", intent: "discuss" });
  const work = (await f.poll(ref)).submission;
  assert.equal(work.submissionId, queued.value.submissionId);
  const request = f.response(work);
  rejected(await f.call({ ...request, responses: [] }), "RESPONSE_COVERAGE");
  rejected(await f.call({ ...request, responses: [{ ...request.responses[0], outcome: "applied" }] }), "RESPONSE_COVERAGE");
  const accepted = await f.ok(request);
  assert.deepEqual(await f.ok(request), accepted);
  rejected(await f.call({ ...request, resultNote: "Changed identity" }), "REQUEST_CONFLICT");
  const result = contract.submissionReadSchema.parse(await f.read(ref, "submission", { submissionId: work.submissionId }));
  assert.equal(result.result.title, "Agent response");
  assert.equal(result.result.responses.length, 1);
  assert.equal(result.receipt.receiptId, accepted.receipt.receiptId);
  assert.equal((await f.read(ref, "status")).pendingMessageCount, 1);
  const context = contract.contextPageSchema.parse(await f.list(ref, "context", { threadId: first.value.threadId }));
  assert.equal(context.items[1].reviewer.messageId, newer.value.messageId);
  assert.equal(context.items[1].response, null);
  const history = contract.submissionHistoryPageSchema.parse(await f.list(ref, "history"));
  assert.equal(history.items[0].comparisonStatus, "not-requested");
});

test("Send and End both orders, shared tabs, stable read-only link, late completion after restart, fresh review exclusion", async (t) => {
  const f = await fixture(t);
  const target = f.file();
  const ref = await f.open(target);
  const tabs = await Promise.all([1, 2].map(() => f.ok({ operation: "read-review", ...ref }, "/api/conversation/session")));
  const pending = await f.thread(ref);
  const sent = await f.send(ref, [pending]);
  const unsent = await f.mutate(ref, "reply", { threadId: pending.value.threadId, body: "Do not transfer", intent: "discuss" });
  const endRequest = await f.request(ref, "end", { confirmUnsentReadOnly: true });
  const ended = await f.ok(endRequest);
  assert.deepEqual(await f.ok(endRequest), ended);
  for (const tab of tabs) {
    const response = await fetch(`http://127.0.0.1:${f.server.port}/api/session/${tab.sessionId}/page`, { headers: { "x-doc-review-token": f.server.token } });
    assert.equal((await response.json()).review.state, "ended");
  }
  rejected(await f.call(await f.request(ref, "reply", { threadId: pending.value.threadId, body: "late", intent: "discuss" })), "REVIEW_ENDED");
  const next = await f.open(target);
  assert.notEqual(next.reviewId, ref.reviewId);
  assert.equal((await f.read(next, "status")).pendingMessageCount, 0);
  rejected(await f.call(await f.request(next, "send", {
    pageKeys: [next.entryKey], messages: [], edits: [], overallNote: { body: "New", intent: "discuss" },
  })), "WORK_OUTSTANDING");
  await f.restart();
  const link = await fetch(`http://127.0.0.1:${f.server.port}/r/${ref.reviewId}`);
  assert.equal(link.status, 200);
  assert.match(await link.text(), /s_[a-f0-9]+/);
  const work = (await f.poll(ref)).submission;
  assert.equal(work.submissionId, sent.value.submissionId);
  await f.ok(f.response(work));
  await f.restart();
  assert.equal((await f.read(ref)).state, "ended");
  assert.equal((await f.poll(ref)).state, "ended");
  assert.equal((await f.read(ref, "submission", { submissionId: work.submissionId })).result.body, "Answered the review.");
  assert.equal((await f.list(ref, "context", { threadId: pending.value.threadId })).items.at(-1).reviewer.messageId, unsent.value.messageId);
  await f.note(next);

  const endFirst = await f.open(f.file());
  const sendRequest = await f.request(endFirst, "send", {
    pageKeys: [endFirst.entryKey], messages: [], edits: [], overallNote: { body: "late", intent: "discuss" },
  });
  await f.mutate(endFirst, "end", { confirmUnsentReadOnly: true });
  rejected(await f.call(sendRequest), "REVIEW_ENDED");
});

test("abandon before pickup/after delivery including End; completion and abandonment both orders", async (t) => {
  const f = await fixture(t);
  for (const delivered of [false, true]) {
    const ref = await f.open(f.file());
    const sent = await f.note(ref);
    const work = delivered ? (await f.poll(ref)).submission :
      (await f.read(ref, "submission", { submissionId: sent.value.submissionId })).submission;
    await f.mutate(ref, "end", { confirmUnsentReadOnly: true });
    const abandon = { operation: "abandon", ...ref, requestId: rid(), expectedVersion: work.version,
      submissionId: work.submissionId, confirmExternalWorkMayContinue: true, reason: "I accept the continuing external-edit risk." };
    const accepted = await f.ok(abandon);
    assert.deepEqual(await f.ok(abandon), accepted);
    assert.equal((await f.poll(ref)).state, "ended");
    rejected(await f.call(f.response({ ...work, state: "delivered" })), "SUBMISSION_ABANDONED");
    const record = await f.read(ref, "submission", { submissionId: work.submissionId });
    assert.equal(record.submission.state, "abandoned");
    assert.equal(record.result, null);
    const replacement = await f.open(f.server.store.data.pages[ref.entryKey].file);
    await f.note(replacement);
  }
  const ref = await f.open();
  await f.note(ref);
  const work = (await f.poll(ref)).submission;
  await f.ok(f.response(work));
  rejected(await f.call({ operation: "abandon", ...ref, requestId: rid(), expectedVersion: work.version,
    submissionId: work.submissionId, confirmExternalWorkMayContinue: true, reason: "too late" }), "ALREADY_HANDLED");
});

test("concurrent tabs serialize Send/End, sends, and response/abandonment", async (t) => {
  const f = await fixture(t);
  for (const first of ["send", "end"]) {
    const ref = await f.open();
    const send = await f.request(ref, "send", { pageKeys: [ref.entryKey], messages: [], edits: [], overallNote: { body: "Race", intent: "discuss" } });
    const end = { ...await f.request(ref, "end", { confirmUnsentReadOnly: true }) };
    const operations = first === "send" ? [send, end] : [end, send];
    const results = await Promise.all(operations.map((request) => f.call(request)));
    assert.equal(results.filter((result) => result.status === 200).length, 1);
    assert.ok(["VERSION_CONFLICT", "REVIEW_ENDED"].includes(results.find((result) => result.status !== 200).body.error.code));
  }
  const ref = await f.open();
  const send = await f.request(ref, "send", { pageKeys: [ref.entryKey], messages: [], edits: [], overallNote: { body: "Race", intent: "discuss" } });
  const results = await Promise.all([send, { ...send, requestId: rid() }].map((request) => f.call(request)));
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  const work = (await f.poll(ref)).submission;
  const race = await Promise.all([f.response(work), { operation: "abandon", ...ref, requestId: rid(),
    expectedVersion: work.version, submissionId: work.submissionId, confirmExternalWorkMayContinue: true, reason: "Race" }].map((request) => f.call(request)));
  assert.equal(race.filter((result) => result.status === 200).length, 1);
});

test("overlapping pages and note-only exclusion guard all direct write routes without preventing preparation", async (t) => {
  const f = await fixture(t);
  const shared = f.file();
  const a = await f.open();
  const b = await f.open();
  const pageKey = targetKey(shared);
  await f.mutate(a, "join-page", { target: shared });
  await f.mutate(b, "join-page", { target: shared });
  await f.note(a, { pageKeys: [pageKey] });
  await f.thread(b, { pageKey });
  rejected(await f.call(await f.request(b, "send", { pageKeys: [pageKey], messages: [], edits: [], overallNote: { body: "Overlap", intent: "discuss" } })), "WORK_OUTSTANDING");
  rejected(await f.call(await f.request(b, "record-edit", { pageKey, content: edit("Original", "Changed") })), "WORK_OUTSTANDING");
  for (const route of ["save", "edit", "revert", "asset"]) {
    rejected(await f.call({}, `/api/page/${pageKey}/${route}`), "WORKFLOW_REMOVED");
  }
  const unrelated = await f.open();
  await f.note(unrelated);
  const sent = (await f.poll(a)).submission;
  await f.ok({ operation: "abandon", ...a, requestId: rid(), expectedVersion: sent.version,
    submissionId: sent.submissionId, confirmExternalWorkMayContinue: true, reason: "Release" });
  await f.mutate(b, "record-edit", { pageKey, content: edit("Original", "Changed") });
});

test("a streamed durable edit checks exclusion after reading its entire body", async (t) => {
  const f = await fixture(t);
  const target = f.file();
  const ref = await f.open(target);
  let notify;
  const reading = new Promise((resolve) => { notify = resolve; });
  const body = JSON.stringify(await f.request(ref, "record-edit", {
    pageKey: ref.entryKey, content: edit("Original", "Stale"),
    expectedVersion: (await f.read(ref)).version + 1,
  }));
  f.server.server.once("request", (req) => req.once("data", notify));
  let request;
  const result = new Promise((resolve, reject) => {
    request = http.request({
      hostname: "127.0.0.1", port: f.server.port, path: "/api/conversation", method: "POST",
      headers: { "x-doc-review-token": f.server.token, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (response) => {
      let raw = "";
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(raw) }));
    });
    request.on("error", reject);
    request.write(body.slice(0, 10));
  });
  await reading;
  await f.note(ref);
  request.end(body.slice(10));
  rejected(await result, "WORK_OUTSTANDING");
  assert.deepEqual((await f.list(ref, "edits")).items, []);
});

test("persist failure never publishes partial completion, receipt, message changes or lifecycle", async (t) => {
  let fail = false;
  const f = await fixture(t, { storeOptions: { write: (file, text) => {
    if (fail) throw new Error("injected persistence failure");
    atomicWrite(file, text);
  } } });
  const ref = await f.open();
  const thread = await f.thread(ref);
  await f.send(ref, [thread]);
  const work = (await f.poll(ref)).submission;
  const request = f.response(work);
  const before = structuredClone(f.server.store.data);
  const disk = fs.readFileSync(statePath(), "utf8");
  fail = true;
  rejected(await f.call(request), "STATE_PERSIST_FAILED");
  assert.deepEqual(f.server.store.data, before);
  assert.equal(fs.readFileSync(statePath(), "utf8"), disk);
  assert.equal((await f.read(ref, "receipt", { requestId: request.requestId })).state, "not-found");
  fail = false;
  const accepted = await f.ok(request);
  await f.restart();
  assert.deepEqual(await f.ok(request), accepted);
});

test("queued delivery and abandonment publication failures retain original outstanding work", async (t) => {
  let fail = false;
  const f = await fixture(t, { storeOptions: { write: (file, text) => {
    if (fail) throw new Error("injected state failure");
    atomicWrite(file, text);
  } } });
  const ref = await f.open();
  const sent = await f.note(ref);
  const queued = (await f.read(ref, "submission", { submissionId: sent.value.submissionId })).submission;
  fail = true;
  rejected(await f.call({ operation: "poll", ...ref }), "STATE_PERSIST_FAILED");
  assert.equal((await f.read(ref, "submission", { submissionId: queued.submissionId })).submission.state, "queued");
  const abandon = { operation: "abandon", ...ref, requestId: rid(), submissionId: queued.submissionId,
    expectedVersion: queued.version, confirmExternalWorkMayContinue: true, reason: "Explicit release" };
  rejected(await f.call(abandon), "STATE_PERSIST_FAILED");
  assert.equal((await f.read(ref, "status")).blockers.length, 1);
  assert.equal((await f.read(ref, "receipt", { requestId: abandon.requestId })).state, "not-found");
  fail = false;
  await f.ok(abandon);
  assert.equal((await f.poll(ref)).state, "waiting");
  assert.equal((await f.read(ref, "status")).blockers.length, 0);
});

test("exact Send replay precedes End and newer work; producer rejects duplicate response coverage", async (t) => {
  const f = await fixture(t);
  const target = f.file();
  const ref = await f.open(target);
  const a = await f.thread(ref);
  const b = await f.thread(ref);
  const request = await f.request(ref, "send", { pageKeys: [ref.entryKey],
    messages: [a, b].map((receipt) => ({ threadId: receipt.value.threadId, messageId: receipt.value.messageId, version: 1 })), edits: [] });
  const accepted = await f.ok(request);
  await f.mutate(ref, "end", { confirmUnsentReadOnly: true });
  assert.deepEqual(await f.ok(request), accepted);
  const work = (await f.poll(ref)).submission;
  const response = f.response(work);
  rejected(await f.call({ ...response, responses: [response.responses[0], response.responses[0]] }), "RESPONSE_COVERAGE");
  await f.ok(response);
  const next = await f.open(target);
  await f.note(next);
  assert.deepEqual(await f.ok(request), accepted);
  rejected(await f.call({ ...request, messages: [request.messages[0]] }), "REQUEST_CONFLICT");
  assert.equal((await f.poll(ref)).state, "ended");
  assert.equal((await f.poll(next)).state, "work");
});

test("cumulative saved edits, repeated exact versions and unsaved absent edits have independent evidence", async (t) => {
  const f = await fixture(t);
  const target = f.file("cumulative.html", "<p>A</p><p>B</p><p>C</p>");
  const ref = await f.open(target);
  const a = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: edit("A", "AA") });
  const b = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: edit("B", "BB") });
  const absent = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: edit("C", "NEVER") });
  const save = async (receipt, version, html) => f.mutate(ref, "save-edit", {
    pageKey: ref.entryKey, editId: receipt.value.editId, editVersion: version,
    expectedSourceHash: (await f.read(ref, "read-page", { pageKey: ref.entryKey })).page.sourceHash, html,
  });
  await save(a, 1, "<p>AA</p><p>B</p><p>C</p>");
  await save(b, 1, "<p>AA</p><p>BB</p><p>C</p>");
  await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, editId: a.value.editId, editVersion: 1, content: edit("A", "AAA") });
  await save(a, 2, "<p>AAA</p><p>BB</p><p>C</p>");
  const edits = contract.directEditPageSchema.parse(await f.list(ref, "edits")).items;
  const ea = edits.find((item) => item.editId === a.value.editId);
  const eb = edits.find((item) => item.editId === b.value.editId);
  assert.equal(ea.source.state, "saved");
  assert.equal(eb.source.state, "saved");
  assert.equal(ea.source.evidence.sourceHash, eb.source.evidence.sourceHash);
  assert.equal(edits.find((item) => item.editId === absent.value.editId).source.state, "pending");
  await f.send(ref, [], [ea, eb].map((item) => ({ pageKey: item.pageKey, editId: item.editId, version: item.version })));
  const work = (await f.poll(ref)).submission;
  assert.equal(work.edits[0].content.before_html, "<p>A</p>");
  const accepted = await f.ok(f.response(work));
  const result = await f.read(ref, "submission", { submissionId: work.submissionId });
  assert.equal(result.result.title, "What changed");
  assert.equal(result.result.effect, "reply-only");
  assert.equal((await f.list(ref, "history")).items[0].comparisonStatus, "not-requested");
  assert.equal((await f.read(ref, "status")).pendingEditCount, 1);
  await f.restart();
  assert.equal((await f.read(ref, "receipt", { requestId: accepted.receipt.requestId })).state, "accepted");
});

test("source changes invalidate saved evidence; fake saved content and broad unrelated HTML changes fail", async (t) => {
  const f = await fixture(t);
  const target = f.file("evidence.html", "<p>A</p><p>B</p>");
  const ref = await f.open(target);
  const a = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: edit("A", "AA") });
  const page = await f.read(ref, "read-page", { pageKey: ref.entryKey });
  const request = await f.request(ref, "save-edit", { pageKey: ref.entryKey, editId: a.value.editId, editVersion: 1,
    expectedSourceHash: page.page.sourceHash, html: "<p>A</p><p>B</p>" });
  rejected(await f.call(request), "SAVE_EVIDENCE_CONFLICT");
  rejected(await f.call({ ...request, html: "x".repeat(8 * 1024 * 1024 + 1) }), "SNAPSHOT_TOO_LARGE");
  rejected(await f.call({ ...request, html: "<p>AA</p><p>Unrecorded</p>" }), "SAVE_EVIDENCE_CONFLICT");
  await f.ok({ ...request, html: "<p>AA</p><p>B</p>" });
  fs.writeFileSync(target, "<p>Externally changed</p><p>B</p>");
  rejected(await f.call(await f.request(ref, "send", { pageKeys: [ref.entryKey], messages: [],
    edits: [{ pageKey: ref.entryKey, editId: a.value.editId, version: 1 }] })), "SAVE_EVIDENCE_CONFLICT");
});

test("one cumulative save proves multiple recorded blocks without refreshing absent records", async (t) => {
  const f = await fixture(t);
  const target = f.file("batched.html", "<p>A</p><p>B</p><p>C</p>");
  const ref = await f.open(target);
  const records = [];
  for (const [before, after] of [["A", "AA"], ["B", "BB"], ["C", "absent"]]) {
    records.push(await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: edit(before, after) }));
  }
  await f.mutate(ref, "save-edit", {
    pageKey: ref.entryKey, editId: records[1].value.editId, editVersion: 1,
    expectedSourceHash: (await f.read(ref, "read-page", { pageKey: ref.entryKey })).page.sourceHash,
    html: "<p>AA</p><p>BB</p><p>C</p>",
  });
  const all = (await f.list(ref, "edits")).items;
  assert.equal(all.filter((item) => item.source.state === "saved").length, 2);
  assert.equal(all.find((item) => item.editId === records[2].value.editId).source.state, "pending");
  await f.send(ref, [], all.filter((item) => item.source.state === "saved").map((item) => ({
    pageKey: item.pageKey, editId: item.editId, version: item.version,
  })));
  assert.equal((await f.poll(ref)).submission.edits.length, 2);
});

test("ended review observer receives late-result invalidation and reconnect hint; reads do not form an event loop", async (t) => {
  const f = await fixture(t);
  const ref = await f.open();
  await f.note(ref);
  const work = (await f.poll(ref)).submission;
  await f.mutate(ref, "end", { confirmUnsentReadOnly: true });
  const tab = await f.ok({ operation: "read-review", ...ref }, "/api/conversation/session");
  const abort = new AbortController();
  const response = await fetch(`http://127.0.0.1:${f.server.port}/events/${tab.sessionId}`, { signal: abort.signal });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: invalidate/);
  const late = reader.read();
  await f.read(ref, "status");
  assert.equal(await Promise.race([late.then(() => "event"), new Promise((resolve) => setTimeout(() => resolve("quiet"), 40))]), "quiet");
  await f.ok(f.response(work));
  assert.match(new TextDecoder().decode((await late).value), /event: invalidate/);
  abort.abort();
  await reader.cancel().catch((error) => { assert.equal(error.name, "AbortError"); });
});

test("source-write/state-write failure leaves no acceptance/evidence and has explicit reconciliation", async (t) => {
  let fail = false;
  const f = await fixture(t, { storeOptions: { write: (file, text) => {
    if (fail) throw new Error("state disk unavailable after source write");
    atomicWrite(file, text);
  } } });
  const target = f.file();
  const ref = await f.open(target);
  const recorded = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: edit("Original", "Changed") });
  const source = await f.read(ref, "read-page", { pageKey: ref.entryKey });
  const request = await f.request(ref, "save-edit", { pageKey: ref.entryKey, editId: recorded.value.editId, editVersion: 1,
    expectedSourceHash: source.page.sourceHash, html: "<p>Changed</p>" });
  fail = true;
  rejected(await f.call(request), "STATE_PERSIST_FAILED");
  assert.equal(fs.readFileSync(target, "utf8"), "<p>Changed</p>");
  assert.equal((await f.list(ref, "edits")).items[0].source.state, "pending");
  assert.equal((await f.read(ref, "receipt", { requestId: request.requestId })).state, "not-found");
  fail = false;
  rejected(await f.call(request), "SAVE_EVIDENCE_CONFLICT");
  // A deliberate restoration of the known original source permits the exact retry.
  fs.writeFileSync(target, "<p>Original</p>");
  await f.ok(request);
  assert.equal((await f.list(ref, "edits")).items[0].source.state, "saved");
});

test("review-local revert cannot undo another review's writes; ownership turnover uses current baseline", async (t) => {
  const f = await fixture(t);
  const target = f.file("shared.html", "<p>A</p>");
  const a = await f.open(target);
  const b = await f.open();
  await f.mutate(b, "join-page", { target });
  const key = a.entryKey;
  const save = async (ref, before, after) => {
    const recorded = await f.mutate(ref, "record-edit", { pageKey: key, content: edit(before, after) });
    await f.mutate(ref, "save-edit", { pageKey: key, editId: recorded.value.editId, editVersion: 1,
      expectedSourceHash: (await f.read(ref, "read-page", { pageKey: key })).page.sourceHash, html: `<p>${after}</p>` });
  };
  await save(a, "A", "AA");
  const oldRevert = (await f.read(a, "read-page", { pageKey: key })).revert;
  await save(b, "AA", "BB");
  rejected(await f.call(await f.request(a, "revert", { pageKey: key, baselineRevisionId: oldRevert.baselineRevisionId,
    expectedSourceHash: (await f.read(a, "read-page", { pageKey: key })).page.sourceHash })), "SAVE_EVIDENCE_CONFLICT");
  const revert = (await f.read(b, "read-page", { pageKey: key })).revert;
  await f.mutate(b, "revert", { pageKey: key, baselineRevisionId: revert.baselineRevisionId, expectedSourceHash: revert.sourceHash });
  assert.equal(fs.readFileSync(target, "utf8"), "<p>AA</p>");
});

test("Markdown/scripted/URL edits remain source-pending; exact move/delete/truncation/assets retained", async (t) => {
  const f = await fixture(t);
  for (const target of [f.file("doc.md", "# Original"), f.file("script.html", "<p>Original</p><script>void 0</script>"), "http://localhost:4567/no-server-needed"]) {
    const ref = await f.open(target);
    const recorded = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: edit("Original", "Changed") });
    assert.equal((await f.read(ref, "read-page", { pageKey: ref.entryKey })).savePolicy, "feedback-only");
    rejected(await f.call(await f.request(ref, "save-edit", { pageKey: ref.entryKey, editId: recorded.value.editId,
      editVersion: 1, expectedSourceHash: "not-writable", html: "<p>Changed</p>" })), "SAVE_EVIDENCE_CONFLICT");
    await f.send(ref, [], [{ pageKey: ref.entryKey, editId: recorded.value.editId, version: 1 }]);
    const work = (await f.poll(ref)).submission;
    rejected(await f.call(f.response(work, { editOutcomes: [{ editId: recorded.value.editId, editVersion: 1,
      outcome: "already-saved", reason: "Cannot trust file type" }] })), "SAVE_EVIDENCE_CONFLICT");
  }
  const staticFile = f.file("new-execution.html");
  const staticReview = await f.open(staticFile);
  const executable = edit("Original", "Changed", { after_html: '<p onclick="void 0">Changed</p>' });
  const executableEdit = await f.mutate(staticReview, "record-edit", { pageKey: staticReview.entryKey, content: executable });
  rejected(await f.call(await f.request(staticReview, "save-edit", {
    pageKey: staticReview.entryKey, editId: executableEdit.value.editId, editVersion: 1,
    expectedSourceHash: (await f.read(staticReview, "read-page", { pageKey: staticReview.entryKey })).page.sourceHash,
    html: executable.after_html,
  })), "SAVE_EVIDENCE_CONFLICT");
  assert.equal(fs.readFileSync(staticFile, "utf8"), "<p>Original</p>");
  const ref = await f.open(f.file("blocks.html", "<p>A</p><p>B</p><p>C</p>"));
  const content = edit("A", "A", { kind: "moved", moved_after: "B", moved_before: "C" });
  const moved = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content });
  await f.mutate(ref, "save-edit", { pageKey: ref.entryKey, editId: moved.value.editId, editVersion: 1,
    expectedSourceHash: (await f.read(ref, "read-page", { pageKey: ref.entryKey })).page.sourceHash, html: "<p>B</p><p>A</p><p>C</p>" });
  const deletedContent = { label: "C", kind: "deleted", before: "C", before_html: "<p>C</p>", truncated: false, truncated_fields: [], staged_assets: [] };
  const deleted = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: deletedContent });
  await f.mutate(ref, "save-edit", { pageKey: ref.entryKey, editId: deleted.value.editId, editVersion: 1,
    expectedSourceHash: (await f.read(ref, "read-page", { pageKey: ref.entryKey })).page.sourceHash, html: "<p>B</p><p>A</p>" });
  const truncatedContent = edit("B", "incomplete", { truncated: true, truncated_fields: ["after"] });
  const truncated = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: truncatedContent });
  await f.send(ref, [], [moved, deleted, truncated].map((receipt) => ({ pageKey: ref.entryKey, editId: receipt.value.editId, version: 1 })));
  const work = (await f.poll(ref)).submission;
  assert.deepEqual(work.edits.map((item) => item.content), [content, deletedContent, truncatedContent]);
  rejected(await f.call(f.response(work, { editOutcomes: work.edits.map((item) => ({
    editId: item.editId, editVersion: item.version, outcome: "applied", reason: "unsafe",
  })) })), "SAVE_EVIDENCE_CONFLICT");
});

test("staged assets survive submission, completion, restart and old age thresholds", async (t) => {
  const f = await fixture(t);
  const target = f.file("image.html", "<p>Original</p>");
  const ref = await f.open(target);
  const asset = await f.ok({ ...ref, pageKey: ref.entryKey, type: "image/png", base64: Buffer.from("fixture-image").toString("base64") }, "/api/conversation/asset");
  const content = edit("Original", "", { after_html: `<p><img src="${asset.preview_src}"></p>`, staged_assets: [asset] });
  const recorded = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content });
  await f.mutate(ref, "save-edit", { pageKey: ref.entryKey, editId: recorded.value.editId, editVersion: 1,
    expectedSourceHash: (await f.read(ref, "read-page", { pageKey: ref.entryKey })).page.sourceHash, html: content.after_html });
  assert.match(fs.readFileSync(target, "utf8"), /assets\/paste_/);
  await f.send(ref, [], [{ pageKey: ref.entryKey, editId: recorded.value.editId, version: 1 }]);
  const work = (await f.poll(ref)).submission;
  const assetPath = work.edits[0].assets[0].path;
  assert.equal(fs.readFileSync(assetPath, "utf8"), "fixture-image");
  await f.ok(f.response(work));
  fs.utimesSync(assetPath, new Date(0), new Date(0));
  f.server.store.collectHistoryGarbage({ olderThan: Date.now() + 1000 });
  await f.restart();
  assert.equal(fs.readFileSync(assetPath, "utf8"), "fixture-image");
  assert.equal(fs.readFileSync(path.join(path.dirname(target), "assets", asset.id), "utf8"), "fixture-image");
});

test("real frame captures freeze Send baselines and late rendered results for files and localhost", async (t) => {
  const f = await fixture(t);
  let upstreamText = "Original";
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<p>${upstreamText}</p>`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const file = f.file("captured.html");
  for (const target of [file, `http://127.0.0.1:${upstream.address().port}/view`]) {
    const ref = await f.open(target);
    const tab = await f.ok({ operation: "read-review", ...ref }, "/api/conversation/session");
    const frame = async (generation) => {
      const render = await f.ok({ key: ref.entryKey, generation }, `/api/session/${tab.sessionId}/render`);
      const served = await fetch(`http://127.0.0.1:${f.server.port}${render.path}`);
      assert.equal(served.status, 200);
      await served.text();
      const ready = await f.ok({ capability: render.capability, generation, pageKey: ref.entryKey },
        `/api/session/${tab.sessionId}/render/${render.renderId}/ready`);
      return { sessionId: tab.sessionId, renderId: render.renderId, generation, expectedSourceHash: ready.sourceHash };
    };
    const initial = await frame(1);
    assert.equal(initial.expectedSourceHash, (await f.read(ref, "read-page", { pageKey: ref.entryKey })).page.sourceHash);
    const baseline = await f.ok({ ...ref, pageKey: ref.entryKey, submissionId: null, ...initial, semantic: semantic("Original") }, "/api/conversation/capture");
    assert.ok(f.server.store.revisions.readSemantic(baseline.revisionId));
    await f.note(ref, { overallNote: { body: "Revise this", intent: "request-change" } });
    const work = (await f.poll(ref)).submission;
    await f.mutate(ref, "end", { confirmUnsentReadOnly: true });
    if (target === file) fs.writeFileSync(file, "<p>Changed</p>");
    else upstreamText = "Changed";
    await f.ok(f.response(work, { overallOutcome: "applied" }));
    const second = await frame(2);
    const capture = { ...ref, pageKey: ref.entryKey, submissionId: work.submissionId, ...second, semantic: semantic("Changed") };
    const comparison = contract.comparisonReferenceSchema.parse(await f.ok(capture, "/api/conversation/capture"));
    assert.equal(comparison.status, "ready");
    assert.equal(comparison.baselineRevisionId, baseline.revisionId);
    const content = await f.ok({ ...ref, pageKey: ref.entryKey, submissionId: work.submissionId, mode: "content" }, "/api/conversation/comparison");
    assert.equal(content.available, true);
    assert.ok(content.changes.length);
    rejected(await f.call(capture, "/api/conversation/capture"), "VERSION_CONFLICT");
    rejected(await f.call({ ...capture, submissionId: null }, "/api/conversation/capture"), "REVIEW_ENDED");
    f.server.store.collectHistoryGarbage({ olderThan: Date.now() + 1000 });
    assert.ok(f.server.store.revisions.readSemantic(comparison.resultRevisionId));
  }
});

test("result capture is independent, reply-only has no new revision, referenced history outlives five rounds", async (t) => {
  const f = await fixture(t);
  const target = f.file();
  const ref = await f.open(target);
  for (let index = 0; index < 7; index++) {
    await f.note(ref, { overallNote: { body: "Make an authorized change", intent: "request-change" } });
    const work = (await f.poll(ref)).submission;
    fs.writeFileSync(target, `<p>Result ${index}</p>`);
    await f.ok(f.response(work, { overallOutcome: "applied", resultNote: `Changed ${index}` }));
  }
  const history = contract.submissionHistoryPageSchema.parse(await f.list(ref, "history"));
  assert.equal(history.totalCount, 7);
  assert.ok(history.items.every((item) => item.comparisonStatus === "partial"));
  const refs = await f.list(ref, "comparisons", { submissionId: history.items[0].submissionId });
  const comparison = await f.ok({ ...ref, submissionId: history.items[0].submissionId, pageKey: ref.entryKey, mode: "source" }, "/api/conversation/comparison");
  assert.ok(comparison.changes.length);
  f.server.store.collectHistoryGarbage({ olderThan: Date.now() + 1000 });
  assert.ok(f.server.store.revisions.readSource(refs.items[0].baselineRevisionId));
  await f.note(ref, { overallNote: { body: "change", intent: "request-change" } });
  const work = (await f.poll(ref)).submission;
  const put = f.server.store.revisions.put;
  f.server.store.revisions.put = () => { throw new Error("injected snapshot failure"); };
  const accepted = await f.ok(f.response(work, { overallOutcome: "applied", resultNote: "Durable despite failed capture" }));
  f.server.store.revisions.put = put;
  assert.equal((await f.read(ref, "submission", { submissionId: work.submissionId })).receipt.receiptId, accepted.receipt.receiptId);
  const record = f.server.store.data.conversations.reviews[ref.reviewId];
  record.review.createdAt = 0;
  for (const item of Object.values(record.submissions)) item.createdAt = 0;
  f.server.store.data.pages[ref.entryKey].updatedAt = 0;
  f.server.store.save();
  fs.unlinkSync(target);
  await f.restart();
  assert.equal((await f.list(ref, "history")).totalCount, 8);
  assert.ok(f.server.store.revisions.readSource(refs.items[0].baselineRevisionId));
});

test("strict boundaries, wrong-scope identities, thread guards and bounded high-water paging", async (t) => {
  const f = await fixture(t);
  rejected(await f.call("{"), "MALFORMED_JSON");
  rejected(await f.call(" ".repeat(contract.CONTRACT_LIMITS.requestBytes + 1)), "INPUT_TOO_LARGE");
  rejected(await f.call({ operation: "open", requestId: rid(), target: f.file(), unknown: true }), "INVALID_INPUT");
  rejected(await f.call({ operation: "open", requestId: rid(), target: "https://example.com/not-local" }), "INVALID_INPUT");
  rejected(await f.call({}, "/api/conversation", "bad-token"), "UNAUTHORIZED");
  const ref = await f.open();
  const other = await f.open();
  const thread = await f.thread(ref);
  rejected(await f.call(await f.request(other, "reply", { threadId: thread.value.threadId, body: "borrow", intent: "discuss" })), "NOT_FOUND");
  rejected(await f.call(await f.request(ref, "set-thread-status", { threadId: thread.value.threadId, status: "resolved" })), "THREAD_BUSY");
  const deleted = await f.thread(ref);
  await f.mutate(ref, "delete-thread", { threadId: deleted.value.threadId });
  await f.send(ref, [thread]);
  rejected(await f.call(await f.request(ref, "delete-thread", { threadId: thread.value.threadId })), "MESSAGE_IMMUTABLE");
  await f.ok(f.response((await f.poll(ref)).submission));
  await f.mutate(ref, "set-thread-status", { threadId: thread.value.threadId, status: "resolved" });
  await f.mutate(ref, "set-thread-status", { threadId: thread.value.threadId, status: "open" });
  for (let i = 0; i < 53; i++) await f.thread(ref, { body: `Thread ${i}` });
  const first = contract.threadPageSchema.parse(await f.list(ref, "threads"));
  assert.equal(first.items.length, 50);
  await f.thread(ref, { body: "Added after high water" });
  const second = await f.list(ref, "threads", {}, { cursor: first.nextCursor });
  assert.equal(second.items.length, 4);
  assert.equal(second.highWater, first.highWater);
  const scope = { ...ref, collection: "threads", pageKey: null, threadId: null, submissionId: null, status: "all" };
  rejected(await f.call({ operation: "list", scope, query: { limit: 101 } }), "INVALID_INPUT");
  rejected(await f.call({ operation: "list", scope: { ...scope, ...other }, query: { cursor: first.nextCursor } }), "INVALID_CURSOR");
});

test("fresh default store preserves obsolete state/assets and incompatible live owner lock", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-obsolete-"));
  process.env.DOC_REVIEW_STATE_DIR = root;
  const legacy = path.join(root, "state.json");
  fs.writeFileSync(legacy, "{not even valid old JSON");
  for (const relative of [path.join("history", "revisions", "old.json"), path.join("pasted", "old", "image.png")]) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "obsolete owned bytes");
    fs.utimesSync(file, new Date(0), new Date(0));
  }
  const server = await start();
  t.after(async () => { await server.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.ok(fs.existsSync(path.join(root, "conversation-state.json")));
  server.store.collectHistoryGarbage({ olderThan: Date.now() + 1000 });
  assert.equal(fs.readFileSync(legacy, "utf8"), "{not even valid old JSON");
  assert.equal(fs.readFileSync(path.join(root, "history", "revisions", "old.json"), "utf8"), "obsolete owned bytes");
  assert.equal(fs.readFileSync(path.join(root, "pasted", "old", "image.png"), "utf8"), "obsolete owned bytes");
  const lockBefore = fs.readFileSync(path.join(root, "server.lock"), "utf8");
  const record = JSON.parse(fs.readFileSync(path.join(root, "server.json"), "utf8"));
  record.protocol = SERVER_PROTOCOL - 1;
  fs.writeFileSync(path.join(root, "server.json"), JSON.stringify(record));
  assert.throws(() => acquireServerLock(), { code: "SERVER_LOCKED" });
  assert.equal(fs.readFileSync(path.join(root, "server.lock"), "utf8"), lockBefore);
});

test("new state corruption/unsupported schemas fail explicitly rather than importing or resetting", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-corrupt-"));
  process.env.DOC_REVIEW_STATE_DIR = root;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const raw of ["{", JSON.stringify({ pages: {} }), JSON.stringify({ schemaVersion: 999, conversations: {} })]) {
    fs.writeFileSync(statePath(), raw);
    assert.throws(() => new Store());
    assert.equal(fs.readFileSync(statePath(), "utf8"), raw);
  }
  fs.unlinkSync(statePath());
  fs.mkdirSync(statePath());
  assert.throws(() => new Store());
});

test("persisted submitted content and ownership cannot be silently repaired on restart", async (t) => {
  const f = await fixture(t);
  const ref = await f.open();
  const message = await f.thread(ref);
  await f.send(ref, [message]);
  const disk = fs.readFileSync(statePath(), "utf8");
  const corrupted = JSON.parse(disk);
  corrupted.conversations.reviews[ref.reviewId].messages[message.value.messageId].body = "Altered after Send";
  fs.writeFileSync(statePath(), JSON.stringify(corrupted));
  assert.throws(() => new Store(), /immutable submitted message/);
  assert.equal(JSON.parse(fs.readFileSync(statePath(), "utf8")).conversations.reviews[ref.reviewId].messages[message.value.messageId].body,
    "Altered after Send");
  fs.writeFileSync(statePath(), disk);
});

test("default home startup, without DOC_REVIEW_STATE_DIR, leaves obsolete owned files untouched", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-default-home-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, ".doc-review");
  fs.mkdirSync(path.join(directory, "history", "blobs"), { recursive: true });
  fs.mkdirSync(path.join(directory, "pasted", "old"), { recursive: true });
  const oldFiles = [path.join(directory, "state.json"), path.join(directory, "history", "blobs", "old.json"),
    path.join(directory, "pasted", "old", "image.png")];
  for (const file of oldFiles) fs.writeFileSync(file, "obsolete bytes");
  const code = `
    import assert from "node:assert/strict";
    import path from "node:path";
    import { stateDir } from ${JSON.stringify(new URL("../lib/paths.js", import.meta.url).href)};
    assert.equal(stateDir(), path.join(process.env.TEST_HOME, ".doc-review"));
    const { start } = await import(${JSON.stringify(new URL("../lib/server.js", import.meta.url).href)});
    const review = await start();
    try { review.store.collectHistoryGarbage({ olderThan: Date.now() + 1000 }); }
    finally { await review.dispose(); }
  `;
  const env = { ...process.env, USERPROFILE: root, HOME: root, TEST_HOME: root };
  delete env.DOC_REVIEW_STATE_DIR;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.ok(fs.existsSync(path.join(directory, "conversation-state.json")));
  for (const file of oldFiles) assert.equal(fs.readFileSync(file, "utf8"), "obsolete bytes");
});

test("single JSON store growth diagnostic uses real writes, reads and bounded producer pages", async (t) => {
  const f = await fixture(t);
  const ref = await f.open();
  const store = f.server.store;
  const startTime = performance.now();
  for (let index = 1; index <= 300; index++) {
    store.conversations.mutate({
      operation: "create-thread", ...ref, requestId: rid(), expectedVersion: store.data.conversations.reviews[ref.reviewId].review.version,
      pageKey: ref.entryKey, target: selection, body: `Thread ${index}: ${"diagnostic text ".repeat(20)}`, intent: "discuss",
    });
    if (index % 10 === 0) {
      store.conversations.mutate({
        operation: "send", ...ref, requestId: rid(), expectedVersion: store.data.conversations.reviews[ref.reviewId].review.version,
        pageKeys: [ref.entryKey], messages: [], edits: [], overallNote: { body: "Diagnostic change", intent: "request-change" },
      });
      const work = store.conversations.read({ operation: "poll", ...ref }).submission;
      fs.writeFileSync(store.data.pages[ref.entryKey].file, `<p>Diagnostic source ${index}</p>`);
      store.conversations.mutate(f.response(work, { overallOutcome: "applied" }));
      store.conversations.captureResults(ref);
    }
    if (![50, 150, 300].includes(index)) continue;
    const beforeWrite = performance.now();
    store.save();
    const writeMs = performance.now() - beforeWrite;
    const beforeRead = performance.now();
    new Store();
    const readMs = performance.now() - beforeRead;
    const beforePage = performance.now();
    const page = store.conversations.list({ operation: "list",
      scope: { ...ref, collection: "threads", pageKey: null, threadId: null, submissionId: null, status: "all" }, query: {} });
    const pageMs = performance.now() - beforePage;
    assert.equal(page.items.length, 50);
    console.log(JSON.stringify({ diagnostic: "conversation-growth", threads: index, submissions: index / 10,
      revisions: fs.readdirSync(path.join(store.revisions.root, "revisions")).length, bytes: fs.statSync(statePath()).size,
      writeMs: +writeMs.toFixed(2), readMs: +readMs.toFixed(2), pageMs: +pageMs.toFixed(2),
      payloadBytes: Buffer.byteLength(JSON.stringify(page)), elapsedMs: +(performance.now() - startTime).toFixed(2) }));
  }
});
