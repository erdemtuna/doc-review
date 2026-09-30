import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { reviewSchema } from "../lib/contracts/page-boundary.js";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const credentials = /^(authorization|cookie|set-cookie|token|capability|x-doc-review-token)$/i;

function checkBody(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (credentials.test(key)) throw new Error(`Credential field cannot enter evidence: ${key}`);
    checkBody(child);
  }
}

/** Local document evidence is private; headers and browser storage are never inputs. */
export function createEvidenceCollector(directory) {
  fs.mkdirSync(path.join(directory, "blobs"), { recursive: true });
  const log = path.join(directory, "events.jsonl");
  fs.writeFileSync(log, "", { flag: "wx" });
  let sequence = 0;
  function blob(bytes) {
    const body = Buffer.from(bytes);
    const sha256 = digest(body), file = path.join(directory, "blobs", sha256);
    try { fs.writeFileSync(file, body, { flag: "wx" }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!fs.readFileSync(file).equals(body)) throw new Error(`Evidence hash collision or corruption: ${sha256}`);
    }
    return { sha256, bytes: body.length };
  }
  function json(value) {
    checkBody(value);
    return blob(Buffer.from(JSON.stringify(value)));
  }
  function event(input) {
    checkBody(input);
    const { at = new Date().toISOString(), operation = "observation", status, request, result, artifacts = [] } = input;
    if (typeof at !== "string" || !Number.isFinite(Date.parse(at)) || typeof operation !== "string") throw new Error("Invalid evidence event metadata");
    if (status !== undefined && !Number.isInteger(status)) throw new Error("Invalid evidence status");
    if (!Array.isArray(artifacts)) throw new Error("Invalid evidence artifacts");
    for (const ref of artifacts) readEvidenceBlob(directory, ref);
    const row = {
      sequence: ++sequence, at, operation,
      ...(status === undefined ? {} : { status }),
      ...(request === undefined ? {} : { request: json(request) }),
      ...(result === undefined ? {} : { result: json(result) }),
      ...(artifacts.length ? { artifacts } : {}),
      ...(operation === "save-edit" && !Object.hasOwn(request ?? {}, "html") ? { missing: "exact-save-candidate" } : {}),
    };
    fs.appendFileSync(log, `${JSON.stringify(row)}\n`);
    return row;
  }
  return { blob, json, event };
}

function readEvidenceBlob(directory, ref) {
  if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new Error("Invalid evidence reference");
  const bytes = fs.readFileSync(path.join(directory, "blobs", ref.sha256));
  if (bytes.length !== ref.bytes || digest(bytes) !== ref.sha256) throw new Error(`Evidence hash mismatch: ${ref.sha256}`);
  return bytes;
}

export function verifyEvidence(directory) {
  const rows = fs.readFileSync(path.join(directory, "events.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const seen = new Set();
  let uniqueBytes = 0;
  function verify(ref) {
    const bytes = readEvidenceBlob(directory, ref);
    if (!seen.has(ref.sha256)) { uniqueBytes += bytes.length; seen.add(ref.sha256); }
  }
  rows.forEach((row, index) => {
    if (row.sequence !== index + 1) throw new Error("Evidence chronology is incomplete");
    if (row.request) verify(row.request);
    if (row.result) verify(row.result);
    for (const ref of row.artifacts ?? []) verify(ref);
  });
  return { events: rows.length, blobs: seen.size, bytes: uniqueBytes + fs.statSync(path.join(directory, "events.jsonl")).size };
}

export function acceptanceHandoff(manifest, opened) {
  const review = reviewSchema.parse(opened.review);
  const paths = {};
  for (const key of ["runtime", "cli", "state", "document"]) {
    const file = manifest[key];
    if (typeof file !== "string" || !path.isAbsolute(file) || !fs.existsSync(file)) throw new Error(`Missing absolute handoff path: ${key}`);
    paths[key] = fs.realpathSync(file);
  }
  if (path.dirname(paths.cli) !== paths.runtime || path.basename(paths.cli) !== "cli.js") throw new Error("CLI must belong to the pinned runtime");
  for (const key of ["commit", "tarballHash", "originalHash"]) {
    if (typeof manifest[key] !== "string" || !(key === "commit" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(manifest[key])) throw new Error(`Invalid provenance: ${key}`);
  }
  return {
    schemaVersion: 1, ...paths, reviewId: review.reviewId, entryKey: review.entryKey,
    cliArguments: ["--review", review.reviewId, "--entry", review.entryKey],
    commit: manifest.commit, tarballHash: manifest.tarballHash, originalHash: manifest.originalHash,
  };
}
