import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const root = path.join(process.cwd(), `.human-review-render-test-${process.pid}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
process.env.HUMAN_REVIEW_STATE_DIR = path.join(root, "state");

const { start } = await import("../src/server.js");

function request(port, token, { method = "GET", route = "/", body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: {
          ...(token ? { "x-human-review-token": token } : {}),
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
  const opened = await request(review.port, review.token, {
    method: "POST",
    route: "/api/session",
    body: { file },
  });
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
  const ended = await request(review.port, review.token, {
    method: "POST",
    route: `/api/session/${sessionId}/end`,
  });
  assert.equal(ended.status, 200);
  assert.equal((await request(review.port, "", { route: ending.path })).status, 410);
});

test("a transient artifact fetch failure does not consume the render", async (t) => {
  let requests = 0;
  const app = http.createServer((_req, res) => {
    requests += 1;
    if (requests === 2) {
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
  const opened = await request(review.port, review.token, {
    method: "POST",
    route: "/api/session",
    body: { target: `http://localhost:${appPort}/` },
  });
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

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
