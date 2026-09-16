import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { RevisionStore } from "../src/revision-store.js";
import { atomicWrite } from "../src/atomic-write.js";

const fixture = path.join(process.cwd(), `.revision-store-test-${crypto.randomUUID()}`);
fs.mkdirSync(fixture);
test.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
const semantic = {
  version: 1,
  blocks: [{ id: "p", tag: "p", text: "Text", path: ["p"], selector: "", attributes: {}, runs: [{ text: "Text", marks: [] }] }],
  limitations: [],
};
const input = {
  documentId: "doc", reason: "send",
  source: { text: "# Text", mediaType: "text/markdown", capturedAt: 100 },
  semantic: { snapshot: semantic, capturedAt: 120, provenance: { feedbackOnlyEdits: true } },
};

test("immutable manifests preserve separate source/DOM capture times and deduplicate content", () => {
  const store = new RevisionStore({ root: path.join(fixture, "dedup") });
  const first = store.put(input);
  const second = store.put(input);
  assert.equal(first.revisionId, second.revisionId);
  assert.equal(first.source.capturedAt, 100);
  assert.equal(first.semantic.capturedAt, 120);
  assert.equal(store.readSource(first.revisionId), "# Text");
  assert.deepEqual(store.readSemantic(first.revisionId), semantic);
  const restarted = new RevisionStore({ root: store.root });
  assert.deepEqual(restarted.get(first.revisionId), first);
  assert.throws(() => restarted.verify(first.revisionId, "other"), /does not belong/);
});

test("source-only and live semantic-only revisions explicitly omit absent representations", () => {
  const store = new RevisionStore({ root: path.join(fixture, "representations") });
  const source = store.put({ documentId: "file", source: input.source });
  const live = store.put({ documentId: "url", semantic: input.semantic });
  assert.equal(store.readSemantic(source.revisionId), null);
  assert.equal(store.readSource(live.revisionId), null);
  assert.throws(() => store.put({ documentId: "empty" }), /must contain/);
});

test("snapshot limits and invalid input fail before creating artifacts", () => {
  const root = path.join(fixture, "limits");
  const store = new RevisionStore({ root, limits: { sourceBytes: 3 } });
  assert.throws(() => store.put(input), (err) => err.code === "SNAPSHOT_TOO_LARGE");
  assert.equal(fs.existsSync(root), false);
  assert.throws(() => store.get("../state"), /Invalid revision ID/);
  assert.throws(() => store.readBlob("../state"), /Invalid blob ID/);
});

test("failed publication leaves no manifest referencing missing blobs", () => {
  const root = path.join(fixture, "failure");
  let writes = 0;
  const store = new RevisionStore({
    root,
    write(file, content) {
      if (++writes === 2) throw new Error("injected blob failure");
      atomicWrite(file, content);
    },
  });
  assert.throws(() => store.put(input), /injected/);
  assert.deepEqual(fs.readdirSync(path.join(root, "revisions")), []);
});

test("tampered manifest or blob is not silently accepted", () => {
  const store = new RevisionStore({ root: path.join(fixture, "corrupt") });
  const result = store.put(input);
  fs.writeFileSync(store.blobPath(result.source.blobId), '{"text":"tampered"}');
  assert.throws(() => store.readSource(result.revisionId), (err) => err.code === "SNAPSHOT_CORRUPT");
  assert.throws(() => store.put(input), (err) => err.code === "SNAPSHOT_CORRUPT");
});

test("collection retains shared blobs and protects recently unpublished snapshots", () => {
  const store = new RevisionStore({ root: path.join(fixture, "gc") });
  const first = store.put(input);
  const second = store.put({ ...input, reason: "result" });
  assert.deepEqual(store.collectGarbage([]), { revisions: 0, blobs: 0 });
  const collected = store.collectGarbage([second.revisionId], { olderThan: Date.now() + 1000 });
  assert.equal(collected.revisions, 1);
  assert.equal(collected.blobs, 0);
  assert.equal(store.get(first.revisionId), null);
  assert.equal(store.readSource(second.revisionId), "# Text");
  const remaining = store.collectGarbage([], { olderThan: Date.now() + 1000 });
  assert.equal(remaining.revisions, 1);
  assert.equal(remaining.blobs, 2);
});
