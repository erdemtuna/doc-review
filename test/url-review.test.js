import { openResponse, mutate, read, send, content, request as conversationRequest } from "./fixtures/review.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doc-review-url-"));
process.env.DOC_REVIEW_STATE_DIR = path.join(tmp, "state");

const { start } = await import("../lib/server.js");

function request(port, token, { method = "GET", route = "/", body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: {
          "x-doc-review-token": token,
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function registerRender(port, token, sessionId, key, generation = 1) {
  const res = await request(port, token, {
    method: "POST",
    route: `/api/session/${sessionId}/render`,
    body: { key, generation },
  });
  assert.equal(res.status, 200, res.raw);
  return JSON.parse(res.raw);
}

test("a localhost route is visually editable and returns source-directed feedback", async (t) => {
  const app = http.createServer((req, res) => {
    if (req.url === "/redirect-away") {
      res.writeHead(302, { location: "https://example.com/wiki" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(
      '<!doctype html><html><head><link rel="stylesheet" href="/_next/wiki.css"></head>' +
        '<body><main><h1>Wiki</h1><p data-block="Intro">Original copy</p></main></body></html>'
    );
  });
  const appPort = await listen(app);
  t.after(() => new Promise((resolve, reject) => app.close((err) => (err ? reject(err) : resolve()))));

  const review = await start();
  t.after(async () => review.dispose());
  const target = `http://localhost:${appPort}/wiki`;

  const opened = await openResponse({ port: review.port, token: review.token }, target);
  assert.equal(opened.status, 200, opened.raw);
  const { key, sessionId } = JSON.parse(opened.raw);
  const scope = opened.body;

  const state = await request(review.port, review.token, { route: `/api/page/${key}` });
  const page = JSON.parse(state.raw);
  assert.equal(page.kind, "url");
  assert.equal(page.url, target);
  assert.equal(page.file, target, "the legacy file field still names the reviewed target");
  assert.equal(page.feedbackOnly, true);
  assert.equal(page.canRevert, false);

  const render = await registerRender(review.port, review.token, sessionId, key);
  const artifact = await request(review.port, review.token, { route: render.path });
  assert.equal(artifact.status, 200, artifact.raw);
  assert.match(artifact.raw, /<h1>Wiki<\/h1>/);
  assert.doesNotMatch(artifact.raw, /<base/);
  assert.match(artifact.raw, new RegExp(`href="http://localhost:${appPort}/_next/wiki\\.css"`));
  assert.match(artifact.raw, /<script data-eh-route>history\.replaceState\(null,"",location\.origin\+"\/wiki"\)<\/script>/);
  assert.match(artifact.raw, new RegExp(`src="http://127\\.0\\.0\\.1:${review.port}/sdk\\.js"`));
  assert.match(artifact.raw, new RegExp(`nonce="${render.capability}"`));

  const changed = await mutate(review, scope, "record-edit", {
    pageKey: key, content: content("Original copy", "Clearer copy", { label: "Intro" }),
  });
  const save = await conversationRequest(review, {
    operation: "save-edit", reviewId: scope.reviewId, entryKey: scope.entryKey,
    requestId: "url-write-refusal", expectedVersion: (await read(review, scope)).version,
    pageKey: key, editId: changed.value.editId, editVersion: 1,
    expectedSourceHash: "0".repeat(40), html: "<p>Do not write this response into Next.js</p>",
  });
  assert.equal(save.status, 409);
  assert.equal(save.body.error.code, "SAVE_EVIDENCE_CONFLICT");
  const deleted = await mutate(review, scope, "record-edit", {
    pageKey: key, content: content("Old card", "", { label: "Old card", kind: "deleted", after_html: "" }),
  });
  await send(review, scope, [], [changed, deleted].map(({ value }) => ({ pageKey: key, editId: value.editId, version: 1 })),
    { overallNote: { body: "Keep the rest of the layout.", intent: "discuss" } });
  const work = (await read(review, scope, "poll")).submission;
  assert.deepEqual((await read(review, scope, "read-page", { pageKey: key })).page.target, { kind: "url", url: target });
  assert.deepEqual(
    work.edits.map(({ content }) => [content.kind, content.after]),
    [
      ["edited", "Clearer copy"],
      ["deleted", ""],
    ]
  );
  assert.ok(work.edits.every((edit) => edit.source.state === "pending"));

  const redirect = await openResponse({ port: review.port, token: review.token }, `http://localhost:${appPort}/redirect-away`);
  const redirectRender = await registerRender(review.port, review.token, redirect.body.sessionId, redirect.body.key);
  const refused = await request(review.port, review.token, { route: redirectRender.path });
  assert.equal(refused.status, 502);
  assert.match(refused.raw, /limited to localhost/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
