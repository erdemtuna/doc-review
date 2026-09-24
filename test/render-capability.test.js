import { openResponse, mutate, read } from "./fixtures/review.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";

const root = path.join(process.cwd(), `.doc-review-render-test-${process.pid}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
process.env.DOC_REVIEW_STATE_DIR = path.join(root, "state");

const { start } = await import("../lib/server.js");

function request(port, token, { method = "GET", route = "/", body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: {
          ...(token ? { "x-doc-review-token": token } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw }));
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

test("render registrations are current, single-use, capability-bound, and expiring", async (t) => {
  const review = await start(0, { renderTtlMs: 200 });
  t.after(async () => review.dispose());

  const file = path.join(root, "page.html");
  fs.writeFileSync(file, "<!doctype html><html><body><h1>Safe</h1></body></html>");
  const opened = await openResponse({ port: review.port, token: review.token }, file);
  const { sessionId, key } = JSON.parse(opened.raw);

  const register = (generation) =>
    request(review.port, review.token, {
      method: "POST",
      route: `/api/session/${sessionId}/render`,
      body: { key, generation },
    });

  const first = JSON.parse((await register(1)).raw);
  const current = JSON.parse((await register(3)).raw);
  const reordered = await register(2);
  assert.equal(reordered.status, 409, "an older reordered registration cannot become current");

  const replaced = await request(review.port, "", { route: first.path });
  assert.equal(replaced.status, 410, "a newer generation atomically invalidates the old document");

  const document = await request(review.port, "", { route: current.path });
  assert.equal(document.status, 200);
  assert.equal(document.headers["cache-control"], "no-store");
  assert.equal(document.headers["referrer-policy"], "no-referrer");
  assert.doesNotMatch(current.path, new RegExp(current.capability));
  assert.match(document.raw, new RegExp(`nonce="${current.capability}"`));
  assert.match(document.raw, /src="http:\/\/127\.0\.0\.1:\d+\/sdk\.js"/);

  const replay = await request(review.port, "", { route: current.path });
  assert.equal(replay.status, 410, "artifact documents are single-use");

  const wrongReady = await request(review.port, review.token, {
    method: "POST",
    route: `/api/session/${sessionId}/render/${current.renderId}/ready`,
    body: { capability: "wrong", generation: 3, pageKey: key },
  });
  assert.equal(wrongReady.status, 403);

  const ready = await request(review.port, review.token, {
    method: "POST",
    route: `/api/session/${sessionId}/render/${current.renderId}/ready`,
    body: { capability: current.capability, generation: 3, pageKey: key },
  });
  assert.equal(ready.status, 200);
  assert.equal(
    JSON.parse(ready.raw).sourceHash,
    createHash("sha1").update(fs.readFileSync(file, "utf8")).digest("hex"),
    "ready identifies the source bytes that were served, not a later source read"
  );
  assert.equal(
    (
      await request(review.port, review.token, {
        method: "POST",
        route: `/api/session/${sessionId}/render/${current.renderId}/ready`,
        body: { capability: current.capability, generation: 3, pageKey: key },
      })
    ).status,
    403,
    "retiring the capability makes duplicate ready messages fail"
  );

  const expiring = JSON.parse((await register(4)).raw);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await request(review.port, "", { route: expiring.path })).status, 410);

  const ending = JSON.parse((await register(5)).raw);
  await mutate(review, opened.body, "end", { confirmUnsentReadOnly: true });
  assert.equal((await read(review, opened.body)).state, "ended");
  assert.equal((await request(review.port, "", { route: ending.path })).status, 200,
    "End freezes mutations but keeps the document and observer available for late results");
});

test("a transient artifact fetch failure does not consume the render", async (t) => {
  let requests = 0;
  const app = http.createServer((_req, res) => {
    requests += 1;
    if (requests === 1) {
      res.writeHead(503, { "content-type": "text/plain" });
      return res.end("not ready");
    }
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<!doctype html><p>ready</p>");
  });
  const appPort = await listen(app);
  t.after(() => new Promise((resolve, reject) => app.close((err) => (err ? reject(err) : resolve()))));

  const review = await start();
  t.after(async () => review.dispose());
  const opened = await openResponse({ port: review.port, token: review.token }, `http://localhost:${appPort}/`);
  const { sessionId, key } = JSON.parse(opened.raw);
  const registered = await request(review.port, review.token, {
    method: "POST",
    route: `/api/session/${sessionId}/render`,
    body: { key, generation: 1 },
  });
  const render = JSON.parse(registered.raw);

  const failed = await request(review.port, "", { route: render.path });
  assert.equal(failed.status, 502);
  assert.equal(failed.headers["cache-control"], "no-store");
  assert.equal(failed.headers["referrer-policy"], "no-referrer");

  const retried = await request(review.port, "", { route: render.path });
  assert.equal(retried.status, 200);
  assert.match(retried.raw, /<p>ready<\/p>/);
});

test("parent execution and capture modules are explicitly served", async (t) => {
  const review = await start();
  t.after(() => review.dispose());
  for (const name of ["execution-client.js", "history-coordinator.js"]) {
    const response = await request(review.port, "", { route: `/${name}` });
    assert.equal(response.status, 200, name);
    assert.match(response.headers["content-type"], /text\/javascript/);
    assert.equal(response.raw, fs.readFileSync(path.join(process.cwd(), "lib", name), "utf8"));
  }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
