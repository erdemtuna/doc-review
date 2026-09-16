import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { SERVER_PROTOCOL } from "../src/paths.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t, poll, { protocol = SERVER_PROTOCOL, health } = {}) {
  const dir = fs.mkdtempSync(path.join(project, ".doc-review-recovery-"));
  const state = path.join(dir, "state");
  fs.mkdirSync(state);
  const file = path.join(dir, "review.html");
  fs.writeFileSync(file, "<p>Review</p>");
  const children = [];
  let record;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      if (health) return health(req, res, record);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, ...record }));
    }
    return poll(req, res, record);
  });
  const dispose = async () => {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, "close");
      child.kill();
      await closed;
    }));
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  t.after(dispose);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  record = {
    pid: process.pid, instance_id: path.basename(dir),
    port: server.address().port, protocol, token: "isolated-test-token",
  };
  const lock = JSON.stringify({ pid: record.pid, instance_id: record.instance_id });
  fs.writeFileSync(path.join(state, "server.json"), JSON.stringify(record));
  fs.writeFileSync(path.join(state, "server.lock"), lock);
  return {
    record, server, state, lock, dispose,
    cli(...args) {
      const child = spawn(process.execPath, [path.join(project, "src", "cli.js"), ...args], {
        cwd: dir,
        env: { ...process.env, DOC_REVIEW_STATE_DIR: state },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    },
    file,
  };
}

test("failure-path fixture cleanup stops a still-waiting CLI and response timer", { timeout: 5000 }, async (t) => {
  let started;
  const listening = new Promise((resolve) => { started = resolve; });
  let timerClosed = false;
  const review = await fixture(t, (_req, res) => {
    res.writeHead(200);
    res.write(" ");
    const timer = setInterval(() => res.write(" "), 10);
    res.once("close", () => {
      clearInterval(timer);
      timerClosed = true;
    });
    started();
  });
  const pending = review.cli("poll", review.file);
  await listening;
  await review.dispose();
  assert.notEqual((await pending).code, 0);
  assert.equal(fs.existsSync(review.state), false);
  assert.equal(timerClosed, true);
});

test("CLI recovers after four drops and repeats an uncertain ack before and after persistence", { timeout: 15000 }, async (t) => {
  const ackIds = [];
  let committed = 0;
  const batch = {
    status: "feedback", batch_id: "b_newer", pages: [{
      file: "review.html", comments: [{ feedback: "x".repeat(250000) }], edits: [],
    }],
  };
  const review = await fixture(t, (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    assert.equal(url.pathname, "/api/poll");
    assert.equal(req.headers["x-doc-review-token"], "isolated-test-token");
    ackIds.push(url.searchParams.get("ack"));
    if (ackIds.length === 1) return req.socket.destroy(); // Request lost before persistence.
    if (!committed) committed++;
    if (ackIds.length < 5) {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"status":"feedback","batch_id":"b_newer","pages":[');
      return setImmediate(() => res.destroy()); // Ack persisted, response incomplete.
    }
    res.end(JSON.stringify(batch));
  });
  const result = await review.cli("poll", review.file, "--ack", "b_explicit", "--timeout", "10");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), batch, "large stdout must be complete JSON");
  assert.deepEqual(ackIds, Array(5).fill("b_explicit"));
  assert.equal(committed, 1);
  assert.equal((result.stderr.match(/retrying/g) || []).length, 4);
});

test("CLI rediscovery adopts a matching replacement identity after a mid-wait disconnect", { timeout: 5000 }, async (t) => {
  let first = true;
  const batch = { status: "feedback", batch_id: "b_redelivered", pages: [] };
  const review = await fixture(t, (req, res, record) => {
    if (first) {
      first = false;
      record.instance_id += "-replacement";
      fs.writeFileSync(path.join(review.state, "server.json"), JSON.stringify(record));
      fs.writeFileSync(path.join(review.state, "server.lock"), JSON.stringify({
        pid: record.pid, instance_id: record.instance_id,
      }));
      return req.socket.destroy();
    }
    res.end(JSON.stringify(batch));
  });
  const result = await review.cli("poll", review.file, "--timeout", "2");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), batch);
});

test("a gracefully ended heartbeat-only poll reconnects with the same acknowledgement", { timeout: 5000 }, async (t) => {
  const acknowledgements = [];
  const batch = { status: "feedback", batch_id: "b_after_shutdown", pages: [] };
  const review = await fixture(t, (req, res) => {
    acknowledgements.push(new URL(req.url, "http://127.0.0.1").searchParams.get("ack"));
    if (acknowledgements.length === 1) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.write(" ");
      return res.end();
    }
    res.end(JSON.stringify(batch));
  });
  const result = await review.cli("poll", review.file, "--ack", "b_explicit", "--timeout", "2");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), batch);
  assert.deepEqual(acknowledgements, ["b_explicit", "b_explicit"]);
  assert.match(result.stderr, /retrying/);
});

test("an older live protocol fails actionably without changing its matching lock or record", { timeout: 5000 }, async (t) => {
  let polls = 0;
  const review = await fixture(t, () => { polls++; }, { protocol: SERVER_PROTOCOL - 1 });
  const before = fs.readFileSync(path.join(review.state, "server.json"), "utf8");
  const result = await review.cli("poll", review.file);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Incompatible live.*protocol/);
  assert.match(result.stderr, /End active reviews.*stop\/restart/);
  assert.doesNotMatch(result.stderr, /Lost the connection/);
  assert.equal(polls, 0);
  assert.equal(fs.readFileSync(path.join(review.state, "server.lock"), "utf8"), review.lock);
  assert.equal(fs.readFileSync(path.join(review.state, "server.json"), "utf8"), before);
  const response = await fetch(`http://127.0.0.1:${review.record.port}/health`);
  assert.equal(response.status, 200, "the incompatible server is still alive");
});

for (const [label, status, body] of [
  ["authorization", 403, '{"error":"Forbidden"}'],
  ["invalid target", 400, '{"error":"Invalid target"}'],
  ["persistence failure", 500, '{"error":"Cannot persist acknowledgement"}'],
  ["malformed JSON", 200, '{"status":'],
  ["empty response", 200, ""],
  ["unexpected shape", 200, '{"ok":true}'],
  ["missing receipt", 200, '{"status":"feedback","pages":[]}'],
]) {
  test(`CLI treats ${label} as terminal even without an explicit timeout`, { timeout: 5000 }, async (t) => {
    let polls = 0;
    const review = await fixture(t, (_req, res) => {
      polls++;
      res.writeHead(status);
      res.end(body);
    });
    const result = await review.cli("poll", review.file);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /retrying/);
    assert.match(result.stderr, /HTTP|Malformed/);
    assert.equal(polls, 1);
  });
}

test("malformed health and health identity mismatches are terminal", { timeout: 5000 }, async (t) => {
  for (const body of ["not json", JSON.stringify({ pid: -1, instance_id: "wrong", protocol: SERVER_PROTOCOL })]) {
    const review = await fixture(t, () => assert.fail("must not poll"), {
      health: (_req, res) => res.end(body),
    });
    const result = await review.cli("poll", review.file);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Malformed|identity/);
    assert.doesNotMatch(result.stderr, /retrying/);
  }
});

test("a short explicit cutoff bounds stalled discovery health probes", { timeout: 5000 }, async (t) => {
  let probes = 0;
  const review = await fixture(t, () => assert.fail("must not poll"), {
    health: () => { probes++; },
  });
  const start = performance.now();
  const result = await review.cli("poll", review.file, "--timeout", "0.1");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "timeout");
  assert.equal(JSON.parse(result.stdout).waited_seconds, 0.1);
  assert.equal(probes, 1);
  assert.ok(performance.now() - start < 2000, "discovery did not take its usual probe/startup budget");
});

test("heartbeats and incomplete JSON cannot extend an explicit response cutoff", { timeout: 5000 }, async (t) => {
  const review = await fixture(t, (_req, res) => {
    res.writeHead(200);
    res.write('{"status":');
    const timer = setInterval(() => res.write(" "), 10);
    res.once("close", () => clearInterval(timer));
  });
  const result = await review.cli("poll", review.file, "--timeout", "0.15");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).status, "timeout");
  assert.equal(JSON.parse(result.stdout).waited_seconds, 0.15);
});

test("closed responses and CLI help retain their machine/human identities", { timeout: 5000 }, async (t) => {
  const review = await fixture(t, (_req, res) => res.end('{"status":"closed","next_step":"Stop polling."}'));
  const result = await review.cli("poll", review.file);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: "closed", next_step: "Stop polling." });
  const help = await review.cli("--help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^doc-review \d/);
  assert.match(help.stdout, /default 12 hours \(43200 seconds\)/);
  assert.match(help.stdout, /--ack <batch_id>/);
  assert.doesNotMatch(help.stdout, /doc-feedback|agent-review/);
});
