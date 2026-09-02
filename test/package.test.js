import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stateDir } from "../src/paths.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("package metadata identifies the fork release", () => {
  assert.equal(pkg.name, "@erdemtuna/doc-review");
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.deepEqual(pkg.bin, { "doc-review": "src/cli.js" });
  assert.equal(pkg.repository.url, "git+https://github.com/erdemtuna/doc-review.git");
  assert.equal(pkg.publishConfig.access, "public");
  assert.equal(pkg.publishConfig.registry, "https://registry.npmjs.org");
});

test("CLI help and version use the doc-review identity", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const cli = path.join(root, pkg.bin["doc-review"]);

  const version = await run(process.execPath, [cli, "--version"]);
  assert.equal(version.stdout.trim(), pkg.version);

  const help = await run(process.execPath, [cli, "--help"]);
  const escapedVersion = pkg.version.replaceAll(".", "\\.");
  assert.match(help.stdout, new RegExp(`^doc-review ${escapedVersion}$`, "m"));
  assert.doesNotMatch(help.stdout, /human-review/i);
});

test("state discovery uses only the doc-review namespace", () => {
  const previousDocReview = process.env.DOC_REVIEW_STATE_DIR;
  const previousHumanReview = process.env.HUMAN_REVIEW_STATE_DIR;
  const expected = path.join(root, ".tmp-doc-review-state");

  try {
    process.env.DOC_REVIEW_STATE_DIR = expected;
    process.env.HUMAN_REVIEW_STATE_DIR = path.join(root, ".tmp-human-review-state");
    assert.equal(stateDir(), expected);

    delete process.env.DOC_REVIEW_STATE_DIR;
    assert.equal(path.basename(stateDir()), ".doc-review");
  } finally {
    if (previousDocReview === undefined) delete process.env.DOC_REVIEW_STATE_DIR;
    else process.env.DOC_REVIEW_STATE_DIR = previousDocReview;
    if (previousHumanReview === undefined) delete process.env.HUMAN_REVIEW_STATE_DIR;
    else process.env.HUMAN_REVIEW_STATE_DIR = previousHumanReview;
  }
});
