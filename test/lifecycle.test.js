import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-lifecycle-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");

const { start } = await import("../src/server.js");
const { serverLockPath, serverPath } = await import("../src/paths.js");

const within = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
      timer.unref();
    }),
  ]);

function post(review, route, body) {
  return fetch(`http://127.0.0.1:${review.port}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-human-review-token": review.token,
    },
    body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
}

function beginPoll(review, file) {
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const completed = new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: review.port,
        path: `/api/poll?target=${encodeURIComponent(file)}`,
        headers: { "x-human-review-token": review.token },
      },
      (res) => {
        startedResolve();
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve(raw.trim()));
      }
    );
    req.on("error", reject);
    req.end();
  });
  return { started, completed };
}

test("25 complete start, open, poll, and dispose cycles terminate naturally", async () => {
  const file = path.join(tmp, "cycle.html");
  fs.writeFileSync(file, "<p>cycle</p>");

  for (let cycle = 0; cycle < 25; cycle += 1) {
    await within(
      (async () => {
        const review = await start();
        const opened = await post(review, "/api/session", { file });
        assert.equal(opened.status, 200);

        const poll = beginPoll(review, file);
        await poll.started;
        const firstDispose = review.dispose();
        assert.strictEqual(review.dispose(), firstDispose, "dispose returns its cached promise");
        await firstDispose;
        assert.equal(await poll.completed, "", "shutdown interrupts the poll without impersonating a user-closed review");
        assert.equal(fs.existsSync(serverLockPath()), false);
        assert.equal(fs.existsSync(serverPath()), false);
      })(),
      process.platform === "win32" ? 4000 : 2500,
      `lifecycle cycle ${cycle + 1}`
    );
  }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
