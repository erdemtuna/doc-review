import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doc-review-lock-"));
process.env.DOC_REVIEW_STATE_DIR = path.join(tmp, "state");

const { start } = await import("../src/server.js");
const { acquireServerLock, readServerLock, releaseServerLock } = await import("../src/server-lock.js");
const { ensureStateDir, serverLockPath, serverPath } = await import("../src/paths.js");

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

const close = (server) =>
  new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

test("a startup race leaves one live writer and one matching server record", async () => {
  const first = await start();
  try {
    await assert.rejects(start(), (err) => err.code === "SERVER_LOCKED");
    const lock = readServerLock();
    const record = JSON.parse(fs.readFileSync(serverPath(), "utf8"));
    assert.equal(lock.instance_id, first.instanceId);
    assert.equal(record.instance_id, first.instanceId);
    assert.equal(record.pid, process.pid);
  } finally {
    await first.dispose();
  }
  assert.equal(fs.existsSync(serverLockPath()), false);
  assert.equal(fs.existsSync(serverPath()), false);
});

test("a demonstrably dead lock owner is reclaimed", () => {
  ensureStateDir();
  fs.writeFileSync(serverLockPath(), JSON.stringify({ pid: 2147483647, instance_id: "dead-owner" }), { flag: "wx" });
  const owner = acquireServerLock({ instanceId: "replacement" });
  assert.equal(owner.instance_id, "replacement");
  assert.equal(readServerLock().instance_id, "replacement");
  assert.equal(releaseServerLock(owner), true);
});

test("a live lock is never reclaimed", () => {
  const owner = acquireServerLock({ instanceId: "live-owner" });
  try {
    assert.throws(() => acquireServerLock({ instanceId: "intruder" }), (err) => err.code === "SERVER_LOCKED");
    assert.equal(readServerLock().instance_id, owner.instance_id);
  } finally {
    releaseServerLock(owner);
  }
});

test("an old owner cannot remove a replacement lock", () => {
  const replacement = acquireServerLock({ instanceId: "replacement-owner" });
  try {
    assert.equal(releaseServerLock({ pid: process.pid, instance_id: "old-owner" }), false);
    assert.equal(readServerLock().instance_id, replacement.instance_id);
  } finally {
    releaseServerLock(replacement);
  }
});

test("listen failure releases the lock and leaves no server record", async () => {
  const blocker = http.createServer();
  const port = await listen(blocker);
  try {
    await assert.rejects(start(port), (err) => err.code === "EADDRINUSE");
    assert.equal(fs.existsSync(serverLockPath()), false);
    assert.equal(fs.existsSync(serverPath()), false);
  } finally {
    await close(blocker);
  }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
