import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fixture, editContent, responseFor } from "./fixtures/agent-loop.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const scope = (opened) => ({ reviewId: opened.review.reviewId, entryKey: opened.review.entryKey });
const upload = (f, ref, fields = {}) => f.ok({
  ...ref, pageKey: ref.entryKey, type: "image/png", base64: PNG.toString("base64"), ...fields,
}, "/api/conversation/asset");

async function frame(f, ref) {
  const attached = await f.ok({ operation: "read-review", ...ref }, "/api/conversation/session");
  const result = await fetch(`http://127.0.0.1:${f.server.port}/api/session/${attached.sessionId}/render`, {
    method: "POST", headers: { "x-doc-review-token": f.server.token, "content-type": "application/json" },
    body: JSON.stringify({ key: ref.entryKey, generation: 1 }),
  });
  assert.equal(result.status, 200);
  const render = await result.json();
  const html = await fetch(`http://127.0.0.1:${f.server.port}${render.path}`);
  assert.equal(html.status, 200);
  await html.text();
  return render;
}

test("pasted images are staged first and copied beside HTML only after an exactly related save", async (t) => {
  const f = await fixture(t), file = f.file("My Spec.html", "<p>Hi</p>");
  const ref = scope(await f.open(file));
  let first;
  await t.test("a PNG is staged, then its relative source and bytes are proven by the recorded save", async () => {
    first = await upload(f, ref);
    assert.equal(fs.existsSync(path.join(f.root, "assets", first.id)), false);
    const html = `<p>Hi<img src="${first.preview_src}"></p>`;
    const recorded = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey,
      content: editContent("Hi", "Hi", { after_html: html, staged_assets: [first] }) });
    await f.mutate(ref, "save-edit", { pageKey: ref.entryKey, editId: recorded.value.editId, editVersion: 1,
      expectedSourceHash: (await f.read(ref, "read-page", { pageKey: ref.entryKey })).page.sourceHash, html });
    assert.equal(fs.readFileSync(file, "utf8"), `<p>Hi<img src="assets/${first.id}"></p>`);
    assert.deepEqual(fs.readFileSync(path.join(f.root, "assets", first.id)), PNG);
  });
  await t.test("a second paste never overwrites the first", async () => {
    const second = await upload(f, ref);
    assert.notEqual(second.id, first.id);
    assert.deepEqual(fs.readFileSync(path.join(f.root, "assets", first.id)), PNG);
    assert.deepEqual(fs.readFileSync(path.join(f.state, "conversation-pasted", ref.entryKey, second.id)), PNG);
  });
  await t.test("non-image MIME types and malformed bytes are refused", async () => {
    for (const fields of [{ type: "text/html" }, { base64: "invalid!!" }, { base64: "" }]) {
      const result = await f.call({ ...ref, pageKey: ref.entryKey, type: "image/png", base64: PNG.toString("base64"), ...fields },
        "/api/conversation/asset");
      assert.equal(result.status, 400);
      assert.equal(result.body.error.code, "INVALID_INPUT");
    }
  });
  await t.test("a moved edit keeps exact landing-spot fields through submission and completion", async () => {
    const moved = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey,
      content: editContent("Hi", "Hi", { kind: "moved", moved_after: "Footer", moved_before: "End" }) });
    await f.send(ref, [], [{ pageKey: ref.entryKey, editId: moved.value.editId, version: 1 }]);
    const work = (await f.poll(ref)).submission;
    assert.equal(work.edits[0].content.moved_after, "Footer");
    assert.equal(work.edits[0].content.moved_before, "End");
    await f.ok(responseFor(work));
  });
});

test("localhost images are staged, page-scoped, previewed, delivered and retained after completion", async (t) => {
  const app = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<p>Original</p>");
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(async () => { app.closeAllConnections(); await new Promise((resolve) => app.close(resolve)); });
  const f = await fixture(t), ref = scope(await f.open(`http://localhost:${app.address().port}/page`));
  const asset = await upload(f, ref), rendered = await frame(f, ref);
  const preview = await fetch(`http://127.0.0.1:${f.server.port}/artifact/${rendered.renderId}/${asset.preview_src}`);
  assert.equal(preview.status, 200);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), PNG);
  const other = await frame(f, scope(await f.open(f.file())));
  assert.equal((await fetch(`http://127.0.0.1:${f.server.port}/artifact/${other.renderId}/${asset.preview_src}`)).status, 404);
  const recorded = await f.mutate(ref, "record-edit", { pageKey: ref.entryKey,
    content: editContent("Original", "Original", { after_html: `<p>Original<img src="${asset.preview_src}"></p>`, staged_assets: [asset] }) });
  await f.send(ref, [], [{ pageKey: ref.entryKey, editId: recorded.value.editId, version: 1 }]);
  const work = (await f.poll(ref)).submission;
  assert.equal(work.edits[0].source.state, "pending");
  assert.equal(work.edits[0].assets[0].preview_src, asset.preview_src);
  assert.deepEqual(fs.readFileSync(work.edits[0].assets[0].path), PNG);
  await f.ok(responseFor(work));
  await f.restart();
  assert.deepEqual(fs.readFileSync(work.edits[0].assets[0].path), PNG);
});
