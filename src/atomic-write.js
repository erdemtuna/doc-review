import crypto from "node:crypto";
import fs from "node:fs";

const RETRY_DELAYS_MS = [10, 20, 40, 80, 160];
const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const waitState = new Int32Array(new SharedArrayBuffer(4));

// Keep Store transactions synchronous; rename backoff blocks for at most 310ms.
const sleepSync = (ms) => Atomics.wait(waitState, 0, 0, ms);

export function createAtomicWriter({ fileSystem = fs, sleep = sleepSync, report = console.error } = {}) {
  return function atomicWrite(file, data) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.doc-review.tmp`;
    let fd;
    let created = false;
    try {
      fd = fileSystem.openSync(tmp, "wx");
      created = true;
      fileSystem.writeFileSync(fd, data);
      fileSystem.closeSync(fd);
      fd = undefined;
      for (let attempt = 0; ; attempt += 1) {
        try {
          fileSystem.renameSync(tmp, file);
          return;
        } catch (err) {
          if (!TRANSIENT_RENAME_ERRORS.has(err.code) || attempt === RETRY_DELAYS_MS.length) throw err;
          sleep(RETRY_DELAYS_MS[attempt]);
        }
      }
    } catch (err) {
      if (fd !== undefined) {
        try {
          fileSystem.closeSync(fd);
        } catch (cleanupError) {
          report(`Could not close atomic-write temporary file ${tmp}: ${cleanupError.message}`);
        }
      }
      if (created) {
        try {
          fileSystem.unlinkSync(tmp);
        } catch (cleanupError) {
          if (cleanupError.code !== "ENOENT") {
            report(`Could not remove atomic-write temporary file ${tmp}: ${cleanupError.message}`);
          }
        }
      }
      throw err;
    }
  };
}

export const atomicWrite = createAtomicWriter();
