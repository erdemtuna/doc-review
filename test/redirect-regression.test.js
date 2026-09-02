import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const root = path.join(process.cwd(), `.human-review-redirect-test-${process.pid}`);
fs.rmSync(root, { recursive: true, force: true });
process.env.HUMAN_REVIEW_STATE_DIR = path.join(root, "state");

const { localUrl } = await import("../src/paths.js");
const { start } = await import("../src/server.js");

// Preserves the security-test intent of upstream PR #16 by anupamme without
// merging its duplicate redirect allowlist implementation.

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

function openTarget(review, target) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ target });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: review.port,
        method: "POST",
        path: "/api/session",
        headers: {
          "x-human-review-token": review.token,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
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
    req.end(body);
  });
}

test("localUrl always accepts the three explicit loopback host forms", () => {
  assert.equal(localUrl("http://localhost:3000/x"), "http://localhost:3000/x");
  assert.equal(localUrl("http://127.0.0.1:3000/x"), "http://127.0.0.1:3000/x");
  assert.equal(localUrl("http://[::1]:3000/x"), "http://[::1]:3000/x");
});

test("redirects reuse localUrl validation across schemes, hosts, credentials, and limits", async (t) => {
  let appPort;
  const app = http.createServer((req, res) => {
    const route = new URL(req.url, "http://localhost").pathname;
    const redirect = (location) => {
      res.writeHead(302, location === undefined ? {} : { location });
      res.end();
    };
    if (route === "/ok") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html><title>ok</title>");
    }
    if (route === "/external-http") return redirect("http://example.com/");
    if (route === "/external-https") return redirect("https://example.com/");
    if (route === "/protocol-relative") return redirect("//example.com/path");
    if (route === "/non-http") return redirect("file:///etc/passwd");
    if (route === "/credentials") return redirect(`http://user:secret@localhost:${appPort}/ok`);
    if (route === "/missing") return redirect();
    if (route === "/malformed") return redirect("http://[");
    if (route === "/to-ipv4") return redirect(`http://127.0.0.1:${appPort}/ok`);
    if (route === "/to-localhost") return redirect(`http://localhost:${appPort}/ok`);
    if (route === "/loop-a") return redirect("/loop-b");
    if (route === "/loop-b") return redirect("/loop-a");
    const bounded = /^\/bounded\/(\d+)$/.exec(route);
    if (bounded) {
      const n = Number(bounded[1]);
      return n === 5 ? redirect("/ok") : redirect(`/bounded/${n + 1}`);
    }
    const allowed = /^\/allowed\/(\d+)$/.exec(route);
    if (allowed) {
      const n = Number(allowed[1]);
      return n === 5 ? (() => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>allowed</title>");
      })() : redirect(`/allowed/${n + 1}`);
    }
    res.writeHead(404).end();
  });
  appPort = await listen(app, "127.0.0.1");
  t.after(() => close(app));

  const review = await start();
  t.after(async () => review.dispose());
  const target = (route, host = "localhost") => `http://${host}:${appPort}${route}`;

  for (const route of ["/external-http", "/external-https", "/protocol-relative"]) {
    const result = await openTarget(review, target(route));
    assert.equal(result.status, 500);
    assert.match(JSON.parse(result.raw).error, /limited to localhost/);
  }

  assert.match(JSON.parse((await openTarget(review, target("/non-http"))).raw).error, /must use HTTP or HTTPS/);
  assert.match(JSON.parse((await openTarget(review, target("/credentials"))).raw).error, /cannot contain credentials/);
  assert.match(JSON.parse((await openTarget(review, target("/missing"))).raw).error, /without a location/);
  assert.match(JSON.parse((await openTarget(review, target("/malformed"))).raw).error, /Invalid URL/);
  assert.match(JSON.parse((await openTarget(review, target("/loop-a"))).raw).error, /Too many redirects/);
  assert.match(JSON.parse((await openTarget(review, target("/bounded/0"))).raw).error, /Too many redirects/);
  assert.equal((await openTarget(review, target("/allowed/0"))).status, 200);
  assert.equal((await openTarget(review, target("/to-ipv4"))).status, 200);
  assert.equal((await openTarget(review, target("/to-localhost", "127.0.0.1"))).status, 200);

  const ipv6 = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://localhost:${appPort}/ok` });
    res.end();
  });
  try {
    const ipv6Port = await listen(ipv6, "::1");
    t.after(() => close(ipv6));
    assert.equal((await openTarget(review, `http://[::1]:${ipv6Port}/start`)).status, 200);
  } catch (err) {
    if (!["EADDRNOTAVAIL", "EAFNOSUPPORT", "EPROTONOSUPPORT"].includes(err.code)) throw err;
  }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
