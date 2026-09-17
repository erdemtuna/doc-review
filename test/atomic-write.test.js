import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWrite, createAtomicWriter } from "../lib/atomic-write.js";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doc-review-atomic-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  fs.writeFileSync(file, "original");
  return { directory, file };
}

test("an atomic replacement leaves only the committed file", (t) => {
  const { directory, file } = fixture(t);
  atomicWrite(file, "committed");
  assert.equal(fs.readFileSync(file, "utf8"), "committed");
  assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
});

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`atomic rename retries ${code} with bounded backoff`, (t) => {
    const { directory, file } = fixture(t);
    let attempts = 0;
    const delays = [];
    const write = createAtomicWriter({
      fileSystem: { ...fs, renameSync(from, to) {
        attempts += 1;
        if (attempts < 4) throw Object.assign(new Error("locked"), { code });
        fs.renameSync(from, to);
      } },
      sleep: (ms) => delays.push(ms),
    });
    write(file, "committed");
    assert.equal(attempts, 4);
    assert.deepEqual(delays, [10, 20, 40]);
    assert.equal(fs.readFileSync(file, "utf8"), "committed");
    assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
  });
}

test("exhausted retries preserve the prior file and throw the rename error", (t) => {
  const { directory, file } = fixture(t);
  const error = Object.assign(new Error("still locked"), { code: "EBUSY" });
  let attempts = 0;
  const delays = [];
  const write = createAtomicWriter({
    fileSystem: { ...fs, renameSync() { attempts += 1; throw error; } },
    sleep: (ms) => delays.push(ms),
  });
  assert.throws(() => write(file, "not committed"), (err) => err === error);
  assert.equal(attempts, 6);
  assert.deepEqual(delays, [10, 20, 40, 80, 160]);
  assert.equal(fs.readFileSync(file, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
});

test("permanent rename errors are not retried", (t) => {
  const { directory, file } = fixture(t);
  const error = Object.assign(new Error("I/O failure"), { code: "EIO" });
  let attempts = 0;
  const write = createAtomicWriter({
    fileSystem: { ...fs, renameSync() { attempts += 1; throw error; } },
    sleep: () => assert.fail("must not sleep"),
  });
  assert.throws(() => write(file, "not committed"), (err) => err === error);
  assert.equal(attempts, 1);
  assert.equal(fs.readFileSync(file, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
});

test("partial writes close and clean up the exclusively created temporary file", (t) => {
  const { directory, file } = fixture(t);
  const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  const write = createAtomicWriter({
    fileSystem: { ...fs, writeFileSync(fd) { fs.writeFileSync(fd, "partial"); throw error; } },
  });
  assert.throws(() => write(file, "not committed"), (err) => err === error);
  assert.equal(fs.readFileSync(file, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
});

test("failure to create a temporary file never removes someone else's path", (t) => {
  const { file } = fixture(t);
  const error = Object.assign(new Error("already exists"), { code: "EEXIST" });
  const write = createAtomicWriter({
    fileSystem: { ...fs, openSync(_file, flag) {
      assert.equal(flag, "wx");
      throw error;
    }, unlinkSync() { assert.fail("must not unlink a file we did not create"); } },
  });
  assert.throws(() => write(file, "not committed"), (err) => err === error);
});

test("cleanup failure is reported without masking the original rename error", (t) => {
  const { file } = fixture(t);
  const error = Object.assign(new Error("original failure"), { code: "EIO" });
  const messages = [];
  const write = createAtomicWriter({
    fileSystem: { ...fs, renameSync() { throw error; }, unlinkSync() { throw new Error("cleanup failed"); } },
    report: (message) => messages.push(message),
  });
  assert.throws(() => write(file, "not committed"), (err) => err === error);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Could not remove atomic-write temporary file.*cleanup failed/);
  assert.equal(fs.readFileSync(file, "utf8"), "original");
});
