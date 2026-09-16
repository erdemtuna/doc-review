import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { SERVER_PROTOCOL, serverLockPath, serverPath } from "../src/paths.js";
import { requestRaw } from "../src/poll-transport.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(project, ".doc-review-loop-"));
process.env.DOC_REVIEW_STATE_DIR = path.join(tmp, "state");
const env = { ...process.env, DOC_REVIEW_STATE_DIR: process.env.DOC_REVIEW_STATE_DIR };

async function request(server, method, route, body) {
  const response = await requestRaw(server, {
    method, path: route, timeout: 2000,
    headers: body ? { "content-type": "application/json" } : {},
  }, body);
  return { status: response.status, body: JSON.parse(response.raw) };
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const cliChildren = [];
function cli(...args) {
  const child = spawn(process.execPath, ["src/cli.js", ...args], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  cliChildren.push(child);
  return child;
}

function spawnServer() {
  return spawn(process.execPath, ["src/server-entry.js"], { cwd: project, env, stdio: "ignore" });
}

async function waitForServer(notPid) {
  const record = path.join(process.env.DOC_REVIEW_STATE_DIR, "server.json");
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
  if (child.exitCode === null && child.signalCode === null) {
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
let deliveredBatchId;

test("poll --timeout exits cleanly with a timeout status", { timeout: 15000 }, async () => {
  server = await waitForServer();
  assert.equal(server.protocol, SERVER_PROTOCOL);
  const result = await collect(cli("poll", file, "--timeout", "1"));
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.status, "timeout");
  assert.equal(out.waited_seconds, 1);
});

test("status is idle before feedback, waiting after", { timeout: 15000 }, async () => {
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

test("a restarted server still delivers the sent batch", { timeout: 15000 }, async () => {
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
  deliveredBatchId = batch.batch_id;
  const replacement = await waitForServer(server.pid);
  replacementPid = replacement.pid;
});

test("a server restart during an acknowledged wait reconnects and delivers new feedback", { timeout: 15000 }, async () => {
  const beforeRestart = await waitForServer(server.pid);
  const child = cli("poll", file, "--ack", deliveredBatchId, "--timeout", "10");
  const pending = collect(child);
  try {
    let listening = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const status = await request(beforeRestart, "GET", `/api/status?target=${encodeURIComponent(file)}`);
      if (status.body.agent_listening) {
        listening = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(listening, true, "the acknowledgement reached the server before restart");
    process.kill(replacementPid);
    await waitForProcessExit(replacementPid);
    replacementPid = null;
    const restarted = await waitForServer(beforeRestart.pid);
    replacementPid = restarted.pid;
    const opened = await request(restarted, "POST", "/api/session", { file });
    await request(restarted, "POST", `/api/page/${opened.body.key}/comment`, {
      kind: "selection", quote: "Original", feedback: "After the restart.",
    });
    await request(restarted, "POST", `/api/page/${opened.body.key}/send`, {
      sessionId: opened.body.sessionId, note: "",
    });
    const result = await pending;
    assert.equal(result.code, 0, result.stderr);
    const batch = JSON.parse(result.stdout);
    assert.equal(batch.status, "feedback");
    assert.notEqual(batch.batch_id, deliveredBatchId);
    assert.equal(batch.pages[0].comments[0].feedback, "After the restart.");
    assert.match(result.stderr, /retrying/);
  } finally {
    await stop(child);
  }
});

test.after(async () => {
  await Promise.all(cliChildren.map(stop));
  await stop(first);
  // Discover a replacement even if an assertion failed before assigning its PID.
  if (fs.existsSync(serverPath())) {
    const record = JSON.parse(fs.readFileSync(serverPath(), "utf8"));
    const lock = JSON.parse(fs.readFileSync(serverLockPath(), "utf8"));
    assert.equal(record.instance_id, lock.instance_id);
    assert.equal(record.pid, lock.pid);
    let health;
    try { health = await request(record, "GET", "/health"); } catch {
      // A terminated Windows child can leave its record and lock behind.
    }
    if (health) {
      assert.equal(health.body.instance_id, record.instance_id);
      assert.equal(health.body.pid, record.pid);
      process.kill(record.pid);
      await waitForProcessExit(record.pid);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});
