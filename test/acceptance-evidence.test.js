import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEvidenceCollector, verifyEvidence, acceptanceHandoff } from "../scripts/acceptance-evidence.js";

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-evidence-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("evidence keeps every event but stores repeated bodies once and refuses overwrite", t => {
  const directory = temporary(t), collector = createEvidenceCollector(directory);
  for (let n = 0; n < 100; n++) collector.event({ operation: "submission", request: { reviewId: "r" }, result: { text: "x".repeat(20000) }, status: 200 });
  const summary = verifyEvidence(directory);
  assert.equal(summary.events, 100);
  assert.equal(summary.blobs, 2);
  assert.ok(summary.bytes < 100 * 20000 * .2);
  assert.throws(() => createEvidenceCollector(directory), /EEXIST/);
});

test("failure payload is exact, missing payloads are explicit and credentials are rejected", t => {
  const directory = temporary(t), collector = createEvidenceCollector(directory);
  const request = { reviewId: "r", html: '<body style="">Actual rejected candidate</body>' };
  const row = collector.event({ operation: "save-edit", status: 409, request, result: { error: "mismatch" } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "blobs", row.request.sha256))), request);
  assert.equal(row.missing, undefined);
  assert.equal(collector.event({ operation: "save-edit", status: 409, request: { reviewId: "r" } }).missing, "exact-save-candidate");
  assert.throws(() => collector.event({ request: { nested: { authorization: "secret" } } }), /Credential field/);
  assert.equal(verifyEvidence(directory).events, 2);
  fs.writeFileSync(path.join(directory, "blobs", row.request.sha256), "corrupted");
  assert.throws(() => verifyEvidence(directory), /hash mismatch/);
});

test("handoffs derive exact identifiers and argument boundaries from authoritative open data", t => {
  const directory = temporary(t), cli = path.join(directory, "cli.js");
  fs.writeFileSync(cli, "");
  const manifest = { runtime: directory, cli, state: directory, document: cli,
    commit: "a".repeat(40), tarballHash: "b".repeat(64), originalHash: "c".repeat(64) };
  const opened = { review: { reviewId: "review_exact", entryKey: "755f0e1b4439837e", version: 1, state: "open", createdAt: Date.now(), endedAt: null } };
  const handoff = acceptanceHandoff(manifest, opened);
  assert.deepEqual(handoff.cliArguments, ["--review", "review_exact", "--entry", "755f0e1b4439837e"]);
  assert.throws(() => acceptanceHandoff({ ...manifest, cli: path.join(directory, "missing.js") }, opened), /handoff path/);
  assert.throws(() => acceptanceHandoff(manifest, { review: {} }));
});

test("checkpoint snapshots and screenshots share verified blobs without losing references", t => {
  const directory = temporary(t), collector = createEvidenceCollector(directory);
  const screenshot = collector.blob(Buffer.from([137, 80, 78, 71]));
  collector.event({ operation: "checkpoint-A", artifacts: [screenshot] });
  collector.event({ operation: "checkpoint-B", artifacts: [collector.blob(Buffer.from([137, 80, 78, 71]))] });
  assert.equal(verifyEvidence(directory).blobs, 1);
  fs.unlinkSync(path.join(directory, "blobs", screenshot.sha256));
  assert.throws(() => verifyEvidence(directory), /ENOENT/);
  assert.throws(() => collector.event({ operation: "missing", artifacts: [screenshot] }), /ENOENT/);
});
