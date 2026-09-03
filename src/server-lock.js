import crypto from "node:crypto";
import fs from "node:fs";
import { ensureStateDir, serverLockPath, serverPath } from "./paths.js";

const sameOwner = (left, right) =>
  !!left &&
  !!right &&
  Number(left.pid) === Number(right.pid) &&
  String(left.instance_id || "") === String(right.instance_id || "");

export function readServerLock() {
  try {
    return JSON.parse(fs.readFileSync(serverLockPath(), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    if (err.code === "EPERM") return true;
    if (err.code === "ESRCH") return false;
    throw err;
  }
}

export function acquireServerLock({ pid = process.pid, instanceId = crypto.randomBytes(16).toString("hex") } = {}) {
  ensureStateDir();
  const owner = { pid, instance_id: instanceId };
  const lockFile = serverLockPath();

  for (;;) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
      return owner;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }

    const existing = readServerLock();
    if (!existing || !existing.instance_id || !Number.isInteger(Number(existing.pid))) {
      const invalid = new Error("The doc-review server lock is malformed and cannot be reclaimed safely.");
      invalid.code = "SERVER_LOCK_INVALID";
      throw invalid;
    }
    if (isProcessAlive(Number(existing.pid))) {
      const locked = new Error(`Doc Review state is already owned by server PID ${existing.pid}.`);
      locked.code = "SERVER_LOCKED";
      locked.owner = existing;
      throw locked;
    }

    const quarantine = `${lockFile}.${existing.instance_id}.${crypto.randomBytes(6).toString("hex")}.stale`;
    try {
      fs.renameSync(lockFile, quarantine);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    const moved = JSON.parse(fs.readFileSync(quarantine, "utf8"));
    if (!sameOwner(moved, existing)) {
      throw new Error("The doc-review server lock changed while reclaiming it.");
    }
    fs.unlinkSync(quarantine);
  }
}

export function releaseServerLock(owner) {
  const existing = readServerLock();
  if (!sameOwner(existing, owner)) return false;
  try {
    fs.unlinkSync(serverLockPath());
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

export function removeOwnedServerRecord(owner) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(serverPath(), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
  if (!sameOwner(record, owner)) return false;
  try {
    fs.unlinkSync(serverPath());
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}
