import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "./atomic-write.js";
import { stateDir } from "./paths.js";
import { normalizeView } from "./view-identity.js";
import {
  REVISION_SCHEMA_VERSION, REVISION_LIMITS, isRevisionId, normalizeCaptureProvenance,
  normalizeSemanticSnapshot, normalizeRevisionLimits, revisionError, utf8Bytes,
} from "./revision-schema.js";

const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");
const BLOB_ID = /^[a-f0-9]{64}$/;

function captureTime(value, now) {
  const time = value ?? now;
  if (!Number.isSafeInteger(time) || time < 0) throw revisionError("Invalid capture timestamp.");
  return time;
}

export class RevisionStore {
  constructor({ root = path.join(stateDir(), "history"), write = atomicWrite, limits = REVISION_LIMITS } = {}) {
    this.root = root;
    this.write = write;
    this.limits = normalizeRevisionLimits(limits);
  }

  blobPath(id) {
    if (!BLOB_ID.test(id)) throw revisionError("Invalid blob ID.");
    return path.join(this.root, "blobs", `${id}.json`);
  }

  manifestPath(id) {
    if (!isRevisionId(id)) throw revisionError("Invalid revision ID.");
    return path.join(this.root, "revisions", `${id}.json`);
  }

  put({ documentId, source, semantic, reason = "observation", limitations = [] }) {
    if (typeof documentId !== "string" || !documentId || documentId.length > 200) throw revisionError("Invalid document ID.");
    if (typeof reason !== "string" || reason.length > 100) throw revisionError("Invalid capture reason.");
    if (!Array.isArray(limitations) || limitations.length > 100 || limitations.some((item) => typeof item !== "string" || item.length > 500)) {
      throw revisionError("Invalid capture limitations.");
    }
    if (!source && !semantic) throw revisionError("A revision must contain source or semantic content.");
    const now = Date.now();
    const manifest = { version: REVISION_SCHEMA_VERSION, documentId, reason, limitations: [...limitations] };
    const blobs = [];
    let size = 0;
    if (source) {
      if (typeof source.text !== "string") throw revisionError("Invalid source snapshot.");
      const bytes = utf8Bytes(source.text);
      if (bytes > this.limits.sourceBytes) throw revisionError("Source snapshot exceeds the size limit.", "SNAPSHOT_TOO_LARGE");
      const mediaType = source.mediaType ?? "text/plain";
      if (typeof mediaType !== "string" || mediaType.length > 100) throw revisionError("Invalid source media type.");
      const serialized = JSON.stringify({ text: source.text });
      const blobId = digest(serialized);
      manifest.source = {
        blobId, hash: digest(source.text), bytes, mediaType,
        capturedAt: captureTime(source.capturedAt, now),
        provenance: normalizeCaptureProvenance(source.provenance),
      };
      blobs.push([blobId, serialized]);
      size += bytes;
    }
    if (semantic) {
      const snapshot = normalizeSemanticSnapshot(semantic.snapshot, this.limits);
      const serialized = JSON.stringify(snapshot);
      const bytes = utf8Bytes(serialized);
      const blobId = digest(serialized);
      manifest.semantic = {
        blobId, hash: blobId, bytes, schemaVersion: REVISION_SCHEMA_VERSION,
        capturedAt: captureTime(semantic.capturedAt, now),
        provenance: normalizeCaptureProvenance(semantic.provenance),
        ...(semantic.view !== undefined ? { view: normalizeView(semantic.view) } : {}),
      };
      blobs.push([blobId, serialized]);
      size += bytes;
    }
    if (size > this.limits.totalBytes) throw revisionError("Combined snapshot exceeds the size limit.", "SNAPSHOT_TOO_LARGE");
    const serialized = JSON.stringify(manifest);
    const revisionId = `v_${digest(serialized)}`;
    for (const dir of ["blobs", "revisions"]) fs.mkdirSync(path.join(this.root, dir), { recursive: true, mode: 0o700 });
    for (const [blobId, content] of blobs) this.writeImmutable(this.blobPath(blobId), content);
    this.writeImmutable(this.manifestPath(revisionId), serialized);
    return { revisionId, ...manifest };
  }

  writeImmutable(file, content) {
    try {
      const existing = fs.readFileSync(file, "utf8");
      if (existing !== content) throw revisionError("Immutable snapshot content disagrees with its ID.", "SNAPSHOT_CORRUPT");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      this.write(file, content);
    }
  }

  get(revisionId) {
    let raw;
    try {
      raw = fs.readFileSync(this.manifestPath(revisionId), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
    if (`v_${digest(raw)}` !== revisionId) throw revisionError("Revision manifest is corrupt.", "SNAPSHOT_CORRUPT");
    const manifest = JSON.parse(raw);
    if (manifest.version !== REVISION_SCHEMA_VERSION) throw revisionError("Unsupported stored revision schema.");
    return { revisionId, ...manifest };
  }

  readBlob(blobId) {
    const raw = fs.readFileSync(this.blobPath(blobId), "utf8");
    if (digest(raw) !== blobId) throw revisionError("Revision blob is corrupt.", "SNAPSHOT_CORRUPT");
    return JSON.parse(raw);
  }

  readSource(revisionId) {
    const manifest = this.get(revisionId);
    return manifest?.source ? this.readBlob(manifest.source.blobId).text : null;
  }

  readSemantic(revisionId) {
    const manifest = this.get(revisionId);
    return manifest?.semantic ? this.readBlob(manifest.semantic.blobId) : null;
  }

  read(revisionId) {
    const manifest = this.get(revisionId);
    if (!manifest) return null;
    return {
      manifest,
      source: manifest.source ? this.readBlob(manifest.source.blobId).text : null,
      semantic: manifest.semantic ? this.readBlob(manifest.semantic.blobId) : null,
    };
  }

  verify(revisionId, documentId) {
    const manifest = this.get(revisionId);
    if (!manifest || manifest.documentId !== documentId) throw revisionError("Revision does not belong to this document.");
    if (manifest.source) this.readBlob(manifest.source.blobId);
    if (manifest.semantic) this.readBlob(manifest.semantic.blobId);
    return manifest;
  }

  // A grace period protects blobs written before their state transaction commits.
  collectGarbage(referencedIds, { olderThan = Date.now() - 60 * 60 * 1000 } = {}) {
    const keep = new Set(referencedIds);
    const blobs = new Set();
    const manifestsDir = path.join(this.root, "revisions");
    const blobsDir = path.join(this.root, "blobs");
    const removed = { revisions: 0, blobs: 0 };
    const files = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    for (const name of files(manifestsDir)) {
      const id = name.replace(/\.json$/, "");
      if (!isRevisionId(id)) continue;
      const file = this.manifestPath(id);
      if (!keep.has(id) && fs.statSync(file).mtimeMs < olderThan) {
        fs.unlinkSync(file);
        removed.revisions += 1;
      } else {
        const manifest = this.get(id);
        if (manifest.source) blobs.add(manifest.source.blobId);
        if (manifest.semantic) blobs.add(manifest.semantic.blobId);
      }
    }
    for (const name of files(blobsDir)) {
      const id = name.replace(/\.json$/, "");
      if (!BLOB_ID.test(id) || blobs.has(id)) continue;
      const file = this.blobPath(id);
      if (fs.statSync(file).mtimeMs >= olderThan) continue;
      fs.unlinkSync(file);
      removed.blobs += 1;
    }
    return removed;
  }
}
