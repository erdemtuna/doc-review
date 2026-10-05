import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { CANDIDATE_POLICY, validateCoverage, reportTests } from "./release-evidence.js";
import { ciToolingPhase } from "./tooling-phase.js";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const integrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
export const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

export function runtimeHashes(directory) {
  const hashes = [];
  for (const name of fs.readdirSync(directory, { recursive: true }).sort()) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink(), `Linked runtime entry: ${name}`);
    if (stat.isFile()) hashes.push([name.replaceAll("\\", "/"), sha256(fs.readFileSync(file))]);
  }
  assert(hashes.length > 0, "Missing built runtime");
  return Object.fromEntries(hashes);
}

export function validateManifest(manifest) {
  assert.equal(manifest.name, "@erdemtuna/doc-review");
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.deepEqual(manifest.files, ["lib", "README.md", "LICENSE"]);
  assert.deepEqual(manifest.bin, { "doc-review": "lib/cli.js" });
  assert.equal(manifest.engines.node, ">=24.21.0");
  assert.deepEqual(manifest.publishConfig, { access: "public", registry: "https://registry.npmjs.org" });
}

export function validateEntries(entries) {
  assert(entries.length > 0 && new Set(entries).size === entries.length, "Empty or duplicate archive entries");
  for (const entry of entries) {
    assert.match(entry, /^package\/[A-Za-z0-9._/-]+$/, `Unsafe archive path: ${entry}`);
    assert(!entry.split("/").some(part => part === ".." || part === "." || part.startsWith(".") ||
      ["node_modules", "src", "test", "e2e", "scripts", "dist"].includes(part)), `Forbidden archive entry: ${entry}`);
    assert(entry.startsWith("package/lib/") || ["package/package.json", "package/README.md", "package/LICENSE"].includes(entry),
      `Entry is outside the package allowlist: ${entry}`);
    if (entry.startsWith("package/lib/")) {
      assert(/\.(js|html|css|md)$/.test(entry) && !/\.(test|spec)\.[cm]?js$/i.test(entry), `Unexpected runtime file: ${entry}`);
    }
  }
  for (const file of ["package.json", "README.md", "LICENSE", "lib/cli.js", "lib/server.js",
    "lib/server-entry.js", "lib/chrome.html", "lib/sdk.js", "lib/SKILL.md",
    "lib/ui/chrome.js", "lib/ui/chrome.css", "lib/ui/THIRD_PARTY_NOTICES.md",
    "lib/references/response-contract.md", "lib/references/source-edits.md", "lib/references/context-and-recovery.md"]) {
    assert(entries.includes(`package/${file}`), `Missing ${file}`);
  }
}

export function inspectArchive(archive) {
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split(/\r?\n/);
  validateEntries(entries);
  const types = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8" }).trim().split(/\r?\n/);
  assert(types.every(line => line.startsWith("-")), "Only regular files may be shipped");
  const manifest = JSON.parse(execFileSync("tar", ["-xzOf", archive, "package/package.json"], { encoding: "utf8" }));
  validateManifest(manifest);
  return { manifest, entries };
}

export function candidateContext(env = process.env) {
  const value = { repository: env.GITHUB_REPOSITORY, commit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT, event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF };
  assert.match(value.repository ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(value.commit ?? "", /^[a-f0-9]{40}$/);
  assert.match(value.runId ?? "", /^[1-9]\d*$/);
  assert.match(value.attempt ?? "", /^[1-9]\d*$/);
  assert(["pull_request", "push", "workflow_dispatch"].includes(value.event));
  assert.match(value.ref ?? "", /^refs\/(?:heads|pull)\/[A-Za-z0-9_./-]+$/);
  return value;
}

export function verifyCandidate(directory, expected = {}) {
  const file = fs.existsSync(path.join(directory, "release-metadata.json")) ? "release-metadata.json" : "ci-metadata.json";
  const meta = readJson(path.join(directory, file));
  assert.equal(meta.schemaVersion, 1);
  assert.equal(meta.policy, CANDIDATE_POLICY);
  assert.match(meta.filename, /^erdemtuna-doc-review-\d+\.\d+\.\d+\.tgz$/);
  assert.deepEqual(fs.readdirSync(directory).sort(), [file, meta.filename, `${meta.filename}.sha256`].sort(),
    "Candidate bundle has unexpected files");
  for (const [key, value] of Object.entries(expected)) assert.equal(meta[key], value, `Candidate ${key} mismatch`);
  assert.match(meta.commit, /^[a-f0-9]{40}$/);
  assert.match(meta.workflow_run_id, /^[1-9]\d*$/);
  assert.match(meta.workflow_run_attempt, /^[1-9]\d*$/);
  assert.equal(meta.node_version, "v24.21.0");
  assert.equal(meta.npm_version, "12.0.2");
  assert.equal(meta.registry, "https://registry.npmjs.org");
  const archive = path.join(directory, meta.filename), bytes = fs.readFileSync(archive);
  assert.equal(sha256(bytes), meta.sha256, "Archive SHA-256 mismatch");
  assert.equal(integrity(bytes), meta.integrity, "Archive SHA-512 mismatch");
  assert.equal(fs.readFileSync(`${archive}.sha256`, "utf8"), `${meta.sha256}  ${meta.filename}\n`, "Checksum mismatch");
  const { manifest, entries } = inspectArchive(archive);
  assert.equal(manifest.name, meta.package);
  assert.equal(manifest.version, meta.version);
  const hashes = [];
  for (const entry of entries.filter(entry => entry.startsWith("package/lib/"))) {
    hashes.push([entry.slice("package/lib/".length), sha256(execFileSync("tar", ["-xzOf", archive, entry]))]);
  }
  assert.deepEqual(Object.fromEntries(hashes), meta.runtime, "Packed runtime differs from the validated build");
  if (meta.coverage) {
    assert.deepEqual(meta.coverage.sourceOnly, ["ui-foundations.spec.js"], "Unrecorded source-only tests");
    const coverage = validateCoverage(meta.coverage.planned, meta.coverage.shards);
    assert.deepEqual(coverage, meta.coverage.summary, "Coverage summary mismatch");
  }
  return meta;
}

export function buildCandidate(directory, env = process.env) {
  const context = candidateContext(env);
  assert.equal(process.version, "v24.21.0");
  const npm = env.npm_execpath;
  assert(npm, "Run candidate tooling through npm");
  assert.equal(execFileSync(process.execPath, [npm, "--version"], { encoding: "utf8" }).trim(), "12.0.2");
  const manifest = readJson("package.json");
  validateManifest(manifest);
  const runtime = runtimeHashes("lib");
  const archiveInputs = Object.fromEntries(["package.json", "README.md", "LICENSE"]
    .map(file => [file, sha256(fs.readFileSync(file))]));
  fs.mkdirSync(directory, { recursive: true });
  assert.equal(fs.readdirSync(directory).length, 0, "Candidate destination must be empty");
  const packed = Object.values(JSON.parse(execFileSync(process.execPath, [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", directory],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })));
  assert.equal(packed.length, 1);
  const filename = `erdemtuna-doc-review-${manifest.version}.tgz`;
  assert.equal(packed[0].filename, filename);
  const bytes = fs.readFileSync(path.join(directory, filename));
  assert.equal(packed[0].integrity, integrity(bytes), "npm pack integrity mismatch");
  for (const [file, hash] of Object.entries(archiveInputs)) {
    assert.equal(sha256(execFileSync("tar", ["-xzOf", path.join(directory, filename), `package/${file}`])), hash,
      `Packed ${file} does not match the canonical checkout`);
  }
  const metadata = { schemaVersion: 1, policy: CANDIDATE_POLICY, package: manifest.name, version: manifest.version, filename,
    repository: context.repository, commit: context.commit, workflow_run_id: context.runId,
    workflow_run_attempt: context.attempt, event: context.event, ref: context.ref,
    node_version: process.version, npm_version: "12.0.2", registry: "https://registry.npmjs.org",
    sha256: sha256(bytes), integrity: integrity(bytes), runtime };
  fs.writeFileSync(path.join(directory, `${filename}.sha256`), `${metadata.sha256}  ${filename}\n`);
  writeJson(path.join(directory, "ci-metadata.json"), metadata);
  verifyCandidate(directory);
  return metadata;
}

export function restoreRuntime(directory) {
  const meta = verifyCandidate(directory);
  for (const [name, hash] of Object.entries(meta.runtime)) {
    const bytes = execFileSync("tar", ["-xzOf", path.join(directory, meta.filename), `package/lib/${name}`]);
    assert.equal(sha256(bytes), hash);
    const target = path.join("lib", ...name.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  assert.deepEqual(runtimeHashes("lib"), meta.runtime, "Restored runtime contains stale or unexpected files");
}

export function sealCandidate(directory, evidenceDir, env = process.env) {
  const context = candidateContext(env), meta = verifyCandidate(directory, { commit: context.commit,
    workflow_run_id: context.runId, workflow_run_attempt: context.attempt });
  const files = fs.readdirSync(evidenceDir, { recursive: true }).filter(file => String(file).endsWith("browser-evidence.json"));
  const evidence = files.map(file => readJson(path.join(evidenceDir, file)));
  assert(evidence.length > 0);
  for (const item of evidence) {
    assert.equal(item.archiveSha256, meta.sha256);
    assert.equal(item.policy, CANDIDATE_POLICY);
    assert.deepEqual(item.sourceOnly, ["ui-foundations.spec.js"], "Unexpected source-only coverage declaration");
  }
  const planned = evidence[0].planned;
  const identities = report => reportTests(report).map(test => [test.id, test.expected]).sort();
  for (const item of evidence) assert.deepEqual(identities(item.planned), identities(planned), "Shard plans differ");
  const shards = evidence.map(item => ({ policy: item.policy, index: item.index, total: item.total, report: item.report }));
  const summary = validateCoverage(planned, shards);
  const sealed = { ...meta, coverage: { planned, shards, summary, sourceOnly: ["ui-foundations.spec.js"] } };
  writeJson(path.join(directory, "ci-metadata.json"), sealed);
  return verifyCandidate(directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [operation, directory, evidence] = process.argv.slice(2);
  assert(directory, "Provide an explicit candidate directory");
  const actions = { build: () => buildCandidate(directory), restore: () => restoreRuntime(directory),
    seal: () => sealCandidate(directory, evidence), verify: () => verifyCandidate(directory) };
  assert(Object.hasOwn(actions, operation), `Unknown candidate operation: ${operation}`);
  const result = await ciToolingPhase(`candidate-${operation}`, actions[operation]);
  if (result) console.log(JSON.stringify({ package: result.package, version: result.version, sha256: result.sha256,
    coverage: result.coverage?.summary }, null, 2));
}
