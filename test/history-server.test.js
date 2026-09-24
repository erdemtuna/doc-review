import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { fixture, responseFor, editContent } from "./fixtures/agent-loop.js";
import { list } from "./fixtures/review.js";

const semantic = (text) => ({ version: 1, blocks: [{
  id: "p1", tag: "p", selector: "#copy", text, attributes: {}, runs: [{ text, marks: [] }], path: [],
}], limitations: [] });
const html = (text) => `<!doctype html><html><body><p id="copy">${text}</p></body></html>`;
const refFor = (opened) => ({ reviewId: opened.review.reviewId, entryKey: opened.review.entryKey });
async function setup(t, source = html("Before"), name = "review.html") {
  const f = await fixture(t), file = f.file(name, source), ref = refFor(await f.open(file));
  return { f, file, ref };
}
async function frame(f, ref, pageKey = ref.entryKey) {
  const { sessionId } = await f.ok({ operation: "read-review", ...ref }, "/api/conversation/session");
  const api = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${f.server.port}${route}`, {
      method: "POST", headers: { "x-doc-review-token": f.server.token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  if (pageKey !== ref.entryKey) await api(`/api/session/${sessionId}/goto`, { key: pageKey });
  const render = await api(`/api/session/${sessionId}/render`, { key: pageKey, generation: 1 });
  const document = await fetch(`http://127.0.0.1:${f.server.port}${render.path}`);
  assert.equal(document.status, 200); await document.text();
  const ready = await api(`/api/session/${sessionId}/render/${render.renderId}/ready`, {
    capability: render.capability, generation: 1, pageKey,
  });
  return { sessionId, renderId: render.renderId, generation: 1, expectedSourceHash: ready.sourceHash };
}
const capture = (f, ref, frame, text, submissionId = null, fields = {}) => f.call({
  ...ref, pageKey: ref.entryKey, submissionId, ...frame, semantic: semantic(text), ...fields,
}, "/api/conversation/capture");
const compare = (f, ref, submissionId, mode = "source", pageKey = ref.entryKey) => f.ok({
  ...ref, submissionId, pageKey, mode,
}, "/api/conversation/comparison");
const comparisons = async (f, ref, submissionId) =>
  (await list(f.server, ref, "comparisons", { submissionId })).items;
async function note(f, ref, pageKeys = [ref.entryKey]) {
  await f.send(ref, [], [], { pageKeys, overallNote: { body: "Refine the source", intent: "request-change" } });
  return (await f.poll(ref)).submission;
}
const complete = (f, work) => f.ok(responseFor(work, { overallOutcome: "applied", resultNote: "Source updated." }));

test("note-only Send freezes its baseline and response source separately from delayed rendered capture", async (t) => {
  const { f, file, ref } = await setup(t);
  assert.equal((await capture(f, ref, await frame(f, ref), "Before")).status, 200);
  const work = await note(f, ref);
  fs.writeFileSync(file, html("After"));
  await complete(f, work);
  const source = await compare(f, ref, work.submissionId);
  assert.equal(source.available, true);
  assert.equal(source.counts.modified, 1);
  assert.equal((await compare(f, ref, work.submissionId, "content")).available, false);
  assert.equal((await capture(f, ref, await frame(f, ref), "After", work.submissionId)).status, 200);
  assert.equal((await comparisons(f, ref, work.submissionId))[0].status, "ready");
  const completed = await compare(f, ref, work.submissionId);
  assert.deepEqual(completed.changes, source.changes);
  assert.equal(completed.sourceHash, source.sourceHash);
  assert.equal(completed.afterCapturedAt, source.afterCapturedAt, "late Content must retain the response-time Source capture");
  fs.writeFileSync(file, html("Still newer"));
  assert.deepEqual(await compare(f, ref, work.submissionId), completed);
  await f.restart();
  assert.deepEqual(await compare(f, ref, work.submissionId), completed);
});

test("stale capture cannot attribute old DOM to current source; missing Content does not discard a valid Send", async (t) => {
  const { f, file, ref } = await setup(t);
  const before = await frame(f, ref);
  fs.writeFileSync(file, html("Concurrent revision"));
  const stale = await capture(f, ref, before, "Before");
  assert.equal(stale.status, 409);
  const work = await note(f, ref);
  const baseline = (await comparisons(f, ref, work.submissionId))[0].baselineRevisionId;
  assert.match(f.server.store.revisions.readSource(baseline), /Concurrent revision/);
  assert.equal(f.server.store.revisions.get(baseline).semantic, undefined);
  assert.equal(work.overallNote.body, "Refine the source");
});

test("same-review accepted direct save permits its verified hash in the original frame, never stale or borrowed evidence", async (t) => {
  const { f, file, ref } = await setup(t, "<p>Before</p>");
  const original = await frame(f, ref);
  const other = refFor(await f.open(f.file("other-entry.html")));
  await f.mutate(other, "join-page", { target: file });
  const foreign = await frame(f, other, ref.entryKey);
  const edit = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: editContent("Before", "Human save") });
  await f.mutate(ref, "save-edit", { pageKey: ref.entryKey, editId: edit.value.editId, editVersion: 1,
    expectedSourceHash: original.expectedSourceHash, html: "<p>Human save</p>" });
  const hash = (await f.read(ref, "read-page", { pageKey: ref.entryKey })).page.sourceHash;
  assert.equal((await capture(f, ref, original, "Stale")).status, 409);
  const borrowed = await f.call({ ...other, pageKey: ref.entryKey, submissionId: null, ...foreign,
    expectedSourceHash: hash, semantic: semantic("Borrowed") }, "/api/conversation/capture");
  assert.equal(borrowed.body.error.code, "SAVE_EVIDENCE_CONFLICT");
  assert.equal((await capture(f, ref, { ...original, expectedSourceHash: hash }, "Human save")).status, 200);
  const work = await note(f, ref);
  const baseline = (await comparisons(f, ref, work.submissionId))[0].baselineRevisionId;
  assert.equal(f.server.store.revisions.readSemantic(baseline).blocks[0].text, "Human save");
  fs.writeFileSync(file, "<p>External write</p>");
  assert.equal((await capture(f, ref, { ...original, expectedSourceHash: hash }, "Human save")).status, 409);
});

test("history and comparison boundaries require authentication, exact review and submission membership", async (t) => {
  const { f, ref } = await setup(t);
  const work = await note(f, ref);
  const unauthorized = await fetch(`http://127.0.0.1:${f.server.port}/api/conversation/comparison`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...ref, submissionId: work.submissionId, pageKey: ref.entryKey, mode: "source" }),
  });
  assert.equal(unauthorized.status, 401);
  const other = refFor(await f.open(f.file("other.html")));
  const wrong = await f.call({ ...other, submissionId: work.submissionId, pageKey: ref.entryKey, mode: "source" },
    "/api/conversation/comparison");
  assert.equal(wrong.body.error.code, "NOT_FOUND");
  const foreignFrame = await frame(f, other);
  assert.equal((await capture(f, ref, foreignFrame, "Other")).body.error.code, "SCOPE_MISMATCH");
});

test("external HTML writes preserve real unsent conversation edit records", async (t) => {
  const { f, file, ref } = await setup(t);
  await f.mutate(ref, "record-edit", { pageKey: ref.entryKey, content: editContent("Before", "My pending wording") });
  const edits = (await list(f.server, ref, "edits")).items;
  fs.writeFileSync(file, html("External source"));
  const deadline = Date.now() + 5000;
  while (!f.server.store.page(ref.entryKey).pristine.includes("External source") && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.match(f.server.store.page(ref.entryKey).pristine, /External source/);
  assert.deepEqual((await list(f.server, ref, "edits")).items, edits);
});

test("invalid semantic capture is rejected without publishing work or a baseline", async (t) => {
  const { f, ref } = await setup(t);
  const invalid = semantic("Before"); invalid.blocks[0].tag = "script";
  const result = await capture(f, ref, await frame(f, ref), "Before", null, { semantic: invalid });
  assert.equal(result.status, 400);
  assert.equal((await f.read(ref, "status")).work, null);
  assert.equal((await list(f.server, ref, "history")).totalCount, 0);
});

test("multi-page Send retains active Content and an inactive page's Source without dropping feedback", async (t) => {
  const { f, ref } = await setup(t);
  const other = f.file("other.html", html("Other before"));
  const joined = await f.mutate(ref, "join-page", { target: other });
  const key = joined.value.pageKey;
  assert.equal((await capture(f, ref, await frame(f, ref), "Before")).status, 200);
  const a = await f.thread(ref);
  const b = await f.thread(ref, { pageKey: key, body: "Other feedback" });
  await f.send(ref, [a, b], [], { pageKeys: [ref.entryKey, key] });
  const work = (await f.poll(ref)).submission;
  const rows = await comparisons(f, ref, work.submissionId);
  assert.equal(rows.length, 2);
  const before = rows.find((row) => row.pageKey === ref.entryKey).baselineRevisionId;
  const inactive = rows.find((row) => row.pageKey === key).baselineRevisionId;
  assert.equal(f.server.store.revisions.readSemantic(before).blocks[0].text, "Before");
  assert.match(f.server.store.revisions.readSource(inactive), /Other before/);
  assert.equal(work.messages.length, 2);
});

test("known tab mismatch and missing identity cannot freeze a misleading rendered result", async (t) => {
  const { f, file, ref } = await setup(t);
  const view = (tabId, label) => ({ version: 1, status: "identified",
    tabs: [{ groupId: "id:sections", tabId, panelId: `${tabId}-panel`, label }] });
  assert.equal((await capture(f, ref, await frame(f, ref), "Before", null, { view: view("product", "Product") })).status, 200);
  const work = await note(f, ref);
  fs.writeFileSync(file, html("After")); await complete(f, work);
  const current = await frame(f, ref);
  for (const fields of [{ view: view("screens", "Screens") }, {}]) {
    const result = await capture(f, ref, current, "Screens", work.submissionId, fields);
    assert.equal(result.body.error.code, "VERSION_CONFLICT");
    assert.equal((await compare(f, ref, work.submissionId, "content")).available, false);
    assert.equal((await f.read(ref, "submission", { submissionId: work.submissionId })).submission.state, "handled");
  }
  assert.equal((await capture(f, ref, current, "After", work.submissionId, { view: view("product", "Product") })).status, 200);
  assert.equal((await compare(f, ref, work.submissionId, "content")).viewComparison.status, "matched");
});

test("a scripted baseline can capture an updated static source without renewed approval", async (t) => {
  const { f, file, ref } = await setup(t, `${html("Before")}<script>window.interactive=true</script>`);
  assert.equal((await capture(f, ref, await frame(f, ref), "Before")).status, 200);
  const work = await note(f, ref);
  const baseline = (await comparisons(f, ref, work.submissionId))[0].baselineRevisionId;
  assert.equal(f.server.store.revisions.get(baseline).semantic.provenance.feedbackOnlyEdits, true);
  fs.writeFileSync(file, html("After")); await complete(f, work);
  assert.equal((await capture(f, ref, await frame(f, ref), "After", work.submissionId)).status, 200);
  assert.equal((await compare(f, ref, work.submissionId, "content")).available, true);
});

test("Markdown captures exact preview Content separately from the true file Source", async (t) => {
  const { f, ref } = await setup(t, "# Original source\n\nOriginal body.\n", "preview.md");
  assert.equal((await capture(f, ref, await frame(f, ref), "Human preview edit")).status, 200);
  const work = await note(f, ref);
  const baseline = (await comparisons(f, ref, work.submissionId))[0].baselineRevisionId;
  assert.match(f.server.store.revisions.readSource(baseline), /Original body/);
  assert.equal(f.server.store.revisions.readSemantic(baseline).blocks[0].text, "Human preview edit");
});

test("unavailable rendered capture is independent of handled response and retained source comparison", async (t) => {
  const { f, file, ref } = await setup(t);
  const before = await frame(f, ref);
  assert.equal((await capture(f, ref, before, "Before")).status, 200);
  const work = await note(f, ref);
  fs.writeFileSync(file, html("After")); await complete(f, work);
  const failed = await capture(f, ref, { ...before, renderId: "gone" }, "After", work.submissionId);
  assert.equal(failed.status, 409);
  assert.equal((await f.read(ref, "submission", { submissionId: work.submissionId })).submission.state, "handled");
  assert.equal((await compare(f, ref, work.submissionId)).available, true);
  assert.equal((await compare(f, ref, work.submissionId, "content")).available, false);
  await f.restart();
  assert.equal((await compare(f, ref, work.submissionId)).available, true);
});

test("live captures use exact current same-review frames; concurrent duplicate rendered results cannot replace endpoints", async (t) => {
  let text = "Live before", fetches = 0;
  const app = http.createServer((_request, response) => {
    fetches++; response.writeHead(200, { "content-type": "text/html" }); response.end(html(text));
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(async () => { app.closeAllConnections(); await new Promise((resolve) => app.close(resolve)); });
  const f = await fixture(t), ref = refFor(await f.open(`http://127.0.0.1:${app.address().port}/review`));
  assert.equal((await capture(f, ref, await frame(f, ref), text)).status, 200);
  const work = await note(f, ref);
  text = "Live after"; await complete(f, work);
  assert.equal(fetches, 1, "handling never invents a server-rendered browser observation");
  const current = await frame(f, ref), sibling = await frame(f, ref);
  await f.mutate(ref, "end", { confirmUnsentReadOnly: true });
  const results = await Promise.all([
    capture(f, ref, current, text, work.submissionId),
    capture(f, ref, sibling, text, work.submissionId),
  ]);
  assert.deepEqual(results.map(({ status }) => status).sort(), [200, 409]);
  assert.equal((await compare(f, ref, work.submissionId, "content")).available, true);
  assert.equal((await compare(f, ref, work.submissionId)).available, false);
});
