import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { SERVER_PROTOCOL, serverLockPath, serverPath } from "../src/paths.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-loop-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, HUMAN_REVIEW_STATE_DIR: process.env.HUMAN_REVIEW_STATE_DIR };

function request(server, method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        method,
        path: route,
        headers: {
          "x-human-review-token": server.token || "",
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function collect(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

const cli = (...args) => spawn(process.execPath, ["src/cli.js", ...args], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });

function spawnServer() {
  return spawn(process.execPath, ["src/server-entry.js"], { cwd: project, env, stdio: "ignore" });
}

async function waitForServer(notPid) {
  const record = path.join(process.env.HUMAN_REVIEW_STATE_DIR, "server.json");
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const saved = JSON.parse(fs.readFileSync(record, "utf8"));
      if (notPid && saved.pid === notPid) throw new Error("stale record");
      const health = await request(saved, "GET", "/health");
      if (health.status === 200) return saved;
    } catch {
      // Not announced yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("review server did not start");
}

async function stop(child) {
  if (child.exitCode === null) {
    const closed = once(child, "close");
    child.kill();
    await closed;
  }
}

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === "ESRCH") return;
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`replacement server PID ${pid} did not exit`);
}

// Flat, sequential top-level tests (no nested subtests): the nested form
// trips node:test's parent-cancellation accounting on Windows even when
// every subtest passes. Module-scope state carries between them; node runs
// a file's top-level tests in order.
const file = path.join(tmp, "review.html");
fs.writeFileSync(file, "<p>Original</p>");
const first = spawnServer();
let server;
let replacementPid = null;

test("poll --timeout exits cleanly with a timeout status", async () => {
  server = await waitForServer();
  assert.equal(server.protocol, SERVER_PROTOCOL);
  const result = await collect(cli("poll", file, "--timeout", "1"));
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.status, "timeout");
  assert.equal(out.waited_seconds, 1);
});

test("status is idle before feedback, waiting after", async () => {
  const before = await collect(cli("status", file));
  assert.equal(before.code, 0, before.stderr);
  assert.equal(JSON.parse(before.stdout).status, "idle");

  const opened = await request(server, "POST", "/api/session", { file });
  await request(server, "POST", `/api/page/${opened.body.key}/comment`, {
    kind: "selection",
    quote: "Original",
    feedback: "Sharper, please.",
  });
  await request(server, "POST", `/api/page/${opened.body.key}/send`, { sessionId: opened.body.sessionId, note: "" });

  const after = await collect(cli("status", file));
  assert.equal(after.code, 0, after.stderr);
  const parsed = JSON.parse(after.stdout);
  assert.equal(parsed.status, "feedback-waiting");
  assert.equal(parsed.feedback_waiting, true);
});

test("a restarted server still delivers the sent batch", async () => {
  await stop(first);
  if (process.platform !== "win32") {
    assert.equal(fs.existsSync(serverLockPath()), false, "SIGTERM releases the writer lock");
    assert.equal(fs.existsSync(serverPath()), false, "SIGTERM removes only its server record");
  }

  const result = await collect(cli("poll", file, "--timeout", "10"));
  assert.equal(result.code, 0, result.stderr);
  const batch = JSON.parse(result.stdout);
  assert.equal(batch.status, "feedback");
  assert.equal(batch.pages[0].comments[0].feedback, "Sharper, please.");
  const replacement = await waitForServer(server.pid);
  replacementPid = replacement.pid;
});

test.after(async () => {
  await stop(first);
  if (replacementPid) {
    try {
      process.kill(replacementPid);
    } catch (err) {
      if (err.code !== "ESRCH") throw err;
    }
    await waitForProcessExit(replacementPid);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});
