import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-security-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");

const { start } = await import("../src/server.js");

function request(port, { method = "GET", route = "/", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
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

async function registerRender(port, token, sessionId, key, generation = 1) {
  const res = await request(port, {
    method: "POST",
    route: `/api/session/${sessionId}/render`,
    headers: { "x-human-review-token": token },
    body: { key, generation },
  });
  assert.equal(res.status, 200, res.raw);
  return JSON.parse(res.raw);
}

test("the local server refuses strangers", async (t) => {
  const { port, token, dispose } = await start();
  t.after(async () => dispose());

  const file = path.join(tmp, "page.html");
  fs.writeFileSync(file, "<!doctype html><html><body><p>Hi</p></body></html>");

  await t.test("api calls without the token are rejected", async () => {
    const res = await request(port, { method: "POST", route: "/api/session", body: { file } });
    assert.equal(res.status, 401);
  });

  await t.test("api calls with the token succeed", async () => {
    const res = await request(port, {
      method: "POST",
      route: "/api/session",
      headers: { "x-human-review-token": token },
      body: { file },
    });
    assert.equal(res.status, 200);
  });

  await t.test("browser modules imported by the review client are served", async () => {
    const res = await request(port, { route: "/chrome-session.js" });
    assert.equal(res.status, 200);
    assert.match(res.raw, /export function replacePage/);
    // sdk.js imports this at boot; if the route vanishes the editor never loads.
    const editing = await request(port, { route: "/editing.js" });
    assert.equal(editing.status, 200);
    assert.match(editing.raw, /export function listCommandFor/);
    const channel = await request(port, { route: "/frame-channel.js" });
    assert.equal(channel.status, 200);
    assert.equal(channel.headers["access-control-allow-origin"], undefined);
    const icons = await request(port, { route: "/icons.js", headers: { origin: "null" } });
    assert.equal(icons.status, 200);
    assert.equal(icons.headers["access-control-allow-origin"], "null");
    assert.match(icons.raw, /export const ICON_NODES/);
  });

  await t.test("a DNS-rebound host header is rejected everywhere", async () => {
    const res = await request(port, { route: "/health", headers: { host: "evil.example.com" } });
    assert.equal(res.status, 403);
  });

  await t.test("status reports idle before any feedback is sent", async () => {
    const res = await request(port, {
      route: `/api/status?file=${encodeURIComponent(file)}`,
      headers: { "x-human-review-token": token },
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.raw);
    assert.equal(body.status, "idle");
    assert.equal(body.feedback_waiting, false);
    assert.equal(body.server_running, true);
  });

  await t.test("the raw route hands back the on-disk html", async () => {
    const opened = await request(port, {
      method: "POST",
      route: "/api/session",
      headers: { "x-human-review-token": token },
      body: { file },
    });
    const { key } = JSON.parse(opened.raw);
    const res = await request(port, {
      route: `/api/page/${key}/raw`,
      headers: { "x-human-review-token": token },
    });
    assert.equal(res.status, 200);
    assert.match(JSON.parse(res.raw).html, /<p>Hi<\/p>/);
  });

  await t.test("file reviews execute only the nonce-authorized SDK", async () => {
    const hostile = '<!doctype html><html><body><h1>Review me</h1><script>parent.postMessage({type:"eh:html",html:"owned"},"*")</script><button onclick="alert(1)">Comment target</button></body></html>';
    fs.writeFileSync(file, hostile);
    const opened = await request(port, {
      method: "POST",
      route: "/api/session",
      headers: { "x-human-review-token": token },
      body: { file },
    });
    const { key, sessionId } = JSON.parse(opened.raw);
    const render = await registerRender(port, token, sessionId, key);
    assert.doesNotMatch(render.path, new RegExp(render.capability));
    const artifact = await request(port, { route: render.path });

    assert.equal(artifact.status, 200);
    assert.equal(artifact.headers["cache-control"], "no-store");
    assert.equal(artifact.headers["referrer-policy"], "no-referrer");
    const csp = artifact.headers["content-security-policy"] || "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce, "file review response has a one-time script nonce");
    assert.match(csp, /'strict-dynamic'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'self'/);
    assert.equal(artifact.raw.split(`nonce="${nonce}"`).length - 1, 1, "only the SDK receives the nonce");
    assert.ok(artifact.raw.includes(`<script data-eh-sdk data-eh-bootstrap type="module" nonce="${nonce}"`));
    assert.ok(artifact.raw.indexOf("data-eh-bootstrap") < artifact.raw.indexOf("<html>"));
    assert.equal(nonce, render.capability, "the CSP nonce is also the hidden frame capability");
    assert.match(artifact.raw, new RegExp(`data-generation="1" data-page-key="${key}"`));
    assert.match(artifact.raw, new RegExp(`src="http://127\\.0\\.0\\.1:${port}/sdk\\.js"`));
    assert.match(artifact.raw, /<script>parent\.postMessage/, "authored script stays present but CSP blocks it");
    assert.match(artifact.raw, /onclick="alert\(1\)"/, "commentable authored elements remain in the page");
    assert.equal(fs.readFileSync(file, "utf8"), hostile, "serving the safe review does not rewrite the file");

    const ready = await request(port, {
      method: "POST",
      route: `/api/session/${sessionId}/render/${render.renderId}/ready`,
      headers: { "x-human-review-token": token },
      body: {
        capability: render.capability,
        generation: render.generation,
        pageKey: key,
      },
    });
    assert.equal(ready.status, 200);
  });

  await t.test("the server record keeps its token private", () => {
    const record = path.join(process.env.HUMAN_REVIEW_STATE_DIR, "server.json");
    const saved = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.equal(saved.token, token);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(record).mode & 0o777, 0o600);
    }
  });
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
