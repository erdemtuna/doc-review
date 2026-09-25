import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, responseFor, scopeArgs } from "./fixtures/agent-loop.js";
import * as c from "../lib/contracts/index.js";
import { SERVER_PROTOCOL } from "../lib/paths.js";

async function queued(f) {
  const file = f.file(), opened = await f.open(file);
  const ref = { reviewId: opened.review.reviewId, entryKey: opened.review.entryKey };
  await f.send(ref, [await f.thread(ref)]);
  return { file, ref };
}

test("response persistence failure retries the exact request with no partial publication", async (t) => {
  const f = await fixture(t), { ref } = await queued(f);
  const answer = responseFor((await f.poll(ref)).submission);
  const before = f.server.store.data, write = f.server.store.write;
  let failed = false;
  f.server.store.write = (file, bytes) => {
    if (!failed && bytes.includes(answer.requestId)) {
      failed = true;
      assert.equal(f.server.store.data, before);
      throw new Error("Injected response persistence failure.");
    }
    return write(file, bytes);
  };
  const result = await f.respond(ref, answer);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(failed, true);
  assert.match(result.stderr, /retrying the identical request/);
  const persisted = c.submissionReadSchema.parse(await f.read(ref, "submission", { submissionId: answer.submissionId }));
  assert.equal(persisted.result.responses.length, 1);
  assert.equal(persisted.receipt.requestId, answer.requestId);
});

test("lost response before/after persistence retries a frozen body, not source work, and replays after restart", { timeout: 15000 }, async (t) => {
  const f = await fixture(t), { file, ref } = await queued(f);
  const { submission } = await f.poll(ref);
  const answer = responseFor(submission), requests = [];
  const sourceBefore = fs.readFileSync(file), sourceTime = fs.statSync(file).mtimeMs;
  await f.proxy(async ({ req, res, body, forward }) => {
    assert.equal(req.headers["x-doc-review-token"], f.server.token);
    requests.push(body);
    if (requests.length === 1) return res.destroy();
    const output = await forward();
    if (requests.length === 2) {
      fs.writeFileSync(path.join(f.root, "response.json"), JSON.stringify({ ...answer, resultNote: "Do not reread during retry." }));
    }
    if (requests.length < 4) { res.writeHead(200); res.write('{"ok":'); return res.destroy(); }
    if (requests.length === 4) return res.end("malformed");
    res.writeHead(output.status); res.end(output.text);
  });
  const result = await f.respond(ref, answer);
  assert.equal(result.code, 0, result.stderr);
  c.acceptedMutationSchema.parse(result.body);
  assert.equal(requests.length, 5);
  assert.equal(new Set(requests).size, 1);
  assert.deepEqual(JSON.parse(requests[0]), answer);
  assert.deepEqual(fs.readFileSync(file), sourceBefore);
  assert.equal(fs.statSync(file).mtimeMs, sourceTime);
  assert.equal(Object.keys(f.server.store.data.conversations.reviews[ref.reviewId].results).length, 1);
  await f.restart();
  const replay = await f.respond(ref, answer);
  assert.deepEqual(replay.body, result.body);
});

test("unknown acceptance exits 2, receipt miss is not success, and the original file later recovers", async (t) => {
  const f = await fixture(t), { ref } = await queued(f);
  const answer = responseFor((await f.poll(ref)).submission);
  let allow = false;
  await f.proxy(async ({ res, body, forward }) => {
    if (JSON.parse(body).operation === "respond" && !allow) return res.destroy();
    const result = await forward(); res.writeHead(result.status); res.end(result.text);
  });
  fs.writeFileSync(path.join(f.root, "response.json"), JSON.stringify(answer));
  const unknown = await f.cli("respond", ...scopeArgs(ref), "--response-file", "response.json", "--timeout", "0.4");
  assert.equal(unknown.code, 2);
  c.transportOutcomeSchema(c.acceptedMutationSchema).parse(unknown.body);
  assert.equal(unknown.body.state, "unknown");
  assert.equal(unknown.body.requestId, answer.requestId);
  const absent = await f.cli("receipt", ...scopeArgs(ref), "--request-id", answer.requestId);
  assert.equal(absent.body.state, "not-found");
  assert.equal((await f.read(ref, "submission", { submissionId: answer.submissionId })).submission.state, "delivered");
  allow = true;
  const accepted = await f.cli("respond", ...scopeArgs(ref), "--response-file", "response.json");
  assert.equal(accepted.code, 0, accepted.stderr);
  const receipt = await f.cli("receipt", ...scopeArgs(ref), "--request-id", answer.requestId);
  assert.deepEqual(receipt.body.receipt, accepted.body.receipt);
});

test("unknown acceptance after a committed response recovers exactly rather than resubmitting new work", async (t) => {
  const f = await fixture(t), { ref } = await queued(f);
  const answer = responseFor((await f.poll(ref)).submission);
  let allow = false;
  await f.proxy(async ({ res, forward }) => {
    const output = await forward();
    if (!allow) return res.destroy();
    res.writeHead(output.status); res.end(output.text);
  });
  fs.writeFileSync(path.join(f.root, "response.json"), JSON.stringify(answer));
  const unknown = await f.cli("respond", ...scopeArgs(ref), "--response-file", "response.json", "--timeout", "0.4");
  assert.equal(unknown.code, 2);
  assert.equal((await f.read(ref, "submission", { submissionId: answer.submissionId })).submission.state, "handled");
  allow = true;
  const result = await f.cli("respond", ...scopeArgs(ref), "--response-file", "response.json");
  assert.equal(result.code, 0, result.stderr);
  c.acceptedMutationSchema.parse(result.body);
  assert.equal(Object.keys(f.server.store.data.conversations.reviews[ref.reviewId].results).length, 1);
});

test("an active review poll rediscovers a restarted producer and keeps its original durable identity", async (t) => {
  const f = await fixture(t), opened = await f.open(f.file());
  const ref = { reviewId: opened.review.reviewId, entryKey: opened.review.entryKey };
  await f.proxy(async ({ res, forward }) => {
    await forward();
    await f.restart();
    await f.send(ref, [await f.thread(ref)]);
    res.destroy();
  });
  const result = await f.cli("poll", ...scopeArgs(ref), "--timeout", "5");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(c.agentPollSchema.parse(result.body).review.reviewId, ref.reviewId);
  assert.match(result.stderr, /retrying/);
});

test("incompatible live discovery never changes a lock, kills the producer, or reads a legacy fallback", async (t) => {
  const f = await fixture(t), { ref } = await queued(f);
  const recordPath = path.join(f.state, "server.json"), lockPath = path.join(f.state, "server.lock");
  const record = JSON.parse(fs.readFileSync(recordPath));
  fs.writeFileSync(recordPath, JSON.stringify({ ...record, protocol: SERVER_PROTOCOL - 1 }));
  const beforeRecord = fs.readFileSync(recordPath), beforeLock = fs.readFileSync(lockPath);
  for (const command of ["poll", "status"]) {
    const result = await f.cli(command, ...scopeArgs(ref), "--timeout", "1");
    assert.equal(result.code, 1);
    assert.match(result.body.error.message, /Incompatible live.*protocol/);
    assert.doesNotMatch(result.stderr, /Lost the connection|Response uncertain/);
    assert.deepEqual(fs.readFileSync(recordPath), beforeRecord);
    assert.deepEqual(fs.readFileSync(lockPath), beforeLock);
  }
  assert.equal((await fetch(`http://127.0.0.1:${f.server.port}/health`)).status, 200);
});

for (const [label, status, body] of [
  ["authorization", 401, c.contractFailure(new c.ContractError("UNAUTHORIZED", "No access"))],
  ["wrong scope", 403, c.contractFailure(new c.ContractError("SCOPE_MISMATCH", "Wrong review"))],
  ["malformed JSON", 200, "{incomplete"],
  ["unknown shape", 200, { ok: true }],
]) {
  test(`poll treats ${label} as a typed terminal failure`, async (t) => {
    const f = await fixture(t), { ref } = await queued(f);
    let calls = 0;
    await f.proxy(async ({ res }) => {
      calls++; res.writeHead(status); res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
    const result = await f.cli("poll", ...scopeArgs(ref));
    assert.equal(result.code, 1);
    c.failureSchema.parse(result.body);
    assert.equal(calls, 1);
    assert.doesNotMatch(result.stderr, /retrying/);
  });
}

test("absolute poll cutoff covers stalled discovery and partial response bytes", async (t) => {
  const f = await fixture(t), { ref } = await queued(f);
  await f.proxy(async ({ res }) => {
    res.writeHead(200); res.write('{"state":');
    const timer = setInterval(() => res.write(" "), 10);
    res.once("close", () => clearInterval(timer));
  }, { interceptHealth: true });
  const start = performance.now();
  const result = await f.cli("poll", ...scopeArgs(ref), "--timeout", "0.15");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(c.agentPollSchema.parse(result.body).state, "timeout");
  assert.ok(performance.now() - start < 2000);
});
