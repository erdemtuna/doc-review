import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyCandidate, sha256, integrity, runtimeHashes } from "../scripts/release-candidate.js";
import { CANDIDATE_POLICY } from "../scripts/release-evidence.js";
import { UNIT_JOBS } from "../scripts/release-evidence.js";
import { adoptCandidate, bindFreshCandidate, verifyPrepared } from "../scripts/release-actions.js";

test("archive verification rejects changed bytes, manifests, checksums, policy and unexpected files", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), bundle = path.join(root, "bundle");
  fs.mkdirSync(path.join(source, "package"), { recursive: true }); fs.mkdirSync(bundle);
  const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
  const manifest = { name: "@erdemtuna/doc-review", version, files: ["lib", "README.md", "LICENSE"],
    bin: { "doc-review": "lib/cli.js" }, engines: { node: ">=24.21.0" },
    publishConfig: { access: "public", registry: "https://registry.npmjs.org" } };
  const files = ["README.md", "LICENSE", "lib/cli.js", "lib/server.js", "lib/server-entry.js", "lib/chrome.html",
    "lib/sdk.js", "lib/SKILL.md", "lib/ui/chrome.js", "lib/ui/chrome.css", "lib/ui/THIRD_PARTY_NOTICES.md",
    "lib/references/response-contract.md", "lib/references/source-edits.md", "lib/references/context-and-recovery.md"];
  for (const name of files) {
    const file = path.join(source, "package", name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `fixture: ${name}`);
  }
  fs.writeFileSync(path.join(source, "package", "package.json"), JSON.stringify(manifest));
  const filename = `erdemtuna-doc-review-${version}.tgz`, archive = path.join(bundle, filename);
  execFileSync("tar", ["-czf", archive, "-C", source, ...["package/package.json", ...files.map(file => `package/${file}`)]]);
  const bytes = fs.readFileSync(archive);
  const meta = { schemaVersion: 1, policy: CANDIDATE_POLICY, filename, package: manifest.name, version: manifest.version,
    repository: "erdemtuna/doc-review", commit: "a".repeat(40), workflow_run_id: "1", workflow_run_attempt: "1",
    event: "push", ref: "refs/heads/main",
    node_version: "v24.21.0", npm_version: "12.0.2", registry: "https://registry.npmjs.org",
    sha256: sha256(bytes), integrity: integrity(bytes), runtime: runtimeHashes(path.join(source, "package", "lib")) };
  const metadata = path.join(bundle, "ci-metadata.json"), sum = `${archive}.sha256`;
  const reset = () => { fs.writeFileSync(metadata, JSON.stringify(meta)); fs.writeFileSync(archive, bytes);
    fs.writeFileSync(sum, `${meta.sha256}  ${filename}\n`); };
  reset();
  assert.equal(verifyCandidate(bundle, { commit: meta.commit }).sha256, meta.sha256);
  for (const patch of [{ version: "999.0.0" }, { schemaVersion: 2 }, { policy: "old" }, { npm_version: "11.0.0" },
    { integrity: "wrong" }, { runtime: {} }, { workflow_run_attempt: "0" }]) {
    reset(); fs.writeFileSync(metadata, JSON.stringify({ ...meta, ...patch }));
    assert.throws(() => verifyCandidate(bundle));
  }
  reset(); fs.appendFileSync(archive, "tampered"); assert.throws(() => verifyCandidate(bundle));
  reset(); fs.writeFileSync(sum, "wrong"); assert.throws(() => verifyCandidate(bundle));
  reset();
  const planned = { suites: [{ title: "suite", specs: [{ file: "file.spec.js", title: "test",
    tests: [{ projectName: "", expectedStatus: "passed", status: "expected", results: [{ status: "passed" }] }] }] }], errors: [] };
  const sealed = { ...meta, coverage: { planned, shards: [{ policy: CANDIDATE_POLICY, index: 1, total: 1, report: planned }],
    summary: { planned: 1, executed: 1, shards: 1, retries: 0 }, sourceOnly: ["ui-foundations.spec.js"] } };
  fs.writeFileSync(metadata, JSON.stringify(sealed));
  const context = { repository: meta.repository, commit: meta.commit, runId: "10", attempt: "1", ref: "refs/heads/main",
    event: "workflow_dispatch" };
  const run = (id, workflow) => ({ id, repository: { full_name: meta.repository }, head_repository: { full_name: meta.repository },
    head_sha: meta.commit, head_branch: "main", status: "completed", conclusion: "success", run_attempt: 1,
    path: `.github/workflows/${workflow}.yml`, event: workflow === "test" ? "push" : "workflow_dispatch" });
  const api = route => {
    if (route.endsWith("/git/ref/heads/main")) return { object: { sha: meta.commit } };
    if (route.endsWith("/actions/runs/1")) return run(1, "test");
    if (route.endsWith("/actions/runs/10")) return run(10, "release");
    if (route.includes("/attempts/1/jobs")) return { jobs: [...UNIT_JOBS, "chromium", "Verified main candidate"]
      .map(name => ({ name, conclusion: "success" })) };
    if (route.includes("/actions/runs/1/artifacts")) return { artifacts: [{ id: 11, name: "verified-main-candidate-1",
      expired: false, workflow_run: { id: 1, head_sha: meta.commit } }] };
    if (route.includes("/actions/runs/10/artifacts")) return { artifacts: [{ id: 12, name: `release-candidate-${version}-attempt-1`,
      expired: false, workflow_run: { id: 10, head_sha: meta.commit } }] };
    throw new Error(`Unexpected fixture request: ${route}`);
  };
  const prepared = path.join(root, "prepared");
  adoptCandidate(context, bundle, prepared, api, () => sealed);
  assert.deepEqual(fs.readFileSync(path.join(prepared, filename)), bytes, "Adoption must not repack the archive");
  assert.equal(verifyPrepared(context, prepared, "10", api, () => sealed).producer.artifactId, 11);
  assert.throws(() => verifyPrepared(context, prepared, "10", api, () => ({ ...sealed, sha256: "b".repeat(64) })));
  assert.throws(() => verifyPrepared(context, prepared, "10",
    route => route.endsWith("/git/ref/heads/main") ? { object: { sha: "b".repeat(40) } } : api(route), () => sealed));
  const fresh = path.join(root, "fresh");
  fs.mkdirSync(fresh);
  for (const file of [filename, `${filename}.sha256`]) fs.copyFileSync(path.join(bundle, file), path.join(fresh, file));
  const freshMeta = { ...sealed, workflow_run_id: context.runId, event: context.event };
  const freshMetadata = path.join(fresh, "ci-metadata.json");
  fs.writeFileSync(freshMetadata, JSON.stringify(freshMeta));
  const freshGates = ["Prepare release candidate", ...UNIT_JOBS.map(name => `Fresh validation / ${name}`), "Fresh validation / chromium"]
    .map(name => ({ name, conclusion: "success" }));
  const freshApi = route => route.includes("/actions/runs/10/attempts/1/jobs") ? { jobs: freshGates } : api(route);
  assert.throws(() => bindFreshCandidate(context, fresh, api), /gate/);
  fs.writeFileSync(freshMetadata, JSON.stringify({ ...freshMeta, workflow_run_attempt: "2" }));
  assert.throws(() => bindFreshCandidate(context, fresh, freshApi), /workflow_run_attempt/);
  fs.writeFileSync(freshMetadata, JSON.stringify(freshMeta));
  assert.throws(() => bindFreshCandidate(context, fresh,
    route => route.includes("/attempts/1/jobs") ? { jobs: [...freshGates, freshGates[1]] } : freshApi(route)), /ambiguous/);
  assert.equal(bindFreshCandidate(context, fresh, freshApi).workflow_run_id, context.runId);
  assert.equal(verifyPrepared(context, fresh, "10", freshApi).producer, undefined);
  assert.deepEqual(fs.readFileSync(path.join(fresh, filename)), bytes, "Fresh binding must retain the canonical archive");
  fs.writeFileSync(path.join(bundle, "extra.json"), "{}"); assert.throws(() => verifyCandidate(bundle));
});
