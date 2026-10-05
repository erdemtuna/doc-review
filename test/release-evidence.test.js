import test from "node:test";
import assert from "node:assert/strict";
import { validateCoverage, validateProducer, CANDIDATE_POLICY, UNIT_JOBS } from "../scripts/release-evidence.js";
import { validateEntries, validateManifest, candidateContext } from "../scripts/release-candidate.js";
import { packageOptions } from "../scripts/package-options.js";
import { validateArtifact } from "../scripts/release-actions.js";
import { releaseReadiness, repositoryFromOrigin, readCandidateFacts } from "../scripts/release-preflight.js";
import { toolingPhase, ciToolingPhase } from "../scripts/tooling-phase.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const report = (names, status = "expected") => ({ errors: [], suites: [{ specs: names.map((title, index) => ({
  title, file: "test.spec.js", line: index + 1, column: 1,
  tests: [{ projectName: "", expectedStatus: "passed", status, results: [{ status: "passed" }] }],
})) }] });
const one = report(["first"]);
const two = report(["second"]);
two.suites[0].specs[0].line = 2;
const planned = report(["first", "second"]);
const shards = [{ policy: CANDIDATE_POLICY, index: 1, total: 2, report: one },
  { policy: CANDIDATE_POLICY, index: 2, total: 2, report: two }];

test("coverage accounts for the complete plan once across shards", () => {
  assert.deepEqual(validateCoverage(planned, shards), { planned: 2, executed: 2, shards: 2, retries: 0 });
  for (const alter of [
    values => values.pop(), values => { values[1].index = 1; },
    values => { values[1].report = one; }, values => { values[1].report.errors = ["Error"]; },
    values => { values[1].report.suites[0].specs[0].tests[0].status = "flaky"; },
    values => { values[1].report.suites[0].specs[0].tests[0].results.push({ status: "passed" }); },
    values => { values[1].policy = "old"; },
  ]) {
    const values = structuredClone(shards); alter(values);
    assert.throws(() => validateCoverage(planned, values));
  }
});

test("suite ancestry distinguishes same-titled pointer and touch cases without relying on changing line numbers", () => {
  const grouped = { errors: [], suites: [{ title: "pointer", specs: structuredClone(one.suites[0].specs) },
    { title: "touch", specs: structuredClone(one.suites[0].specs) }] };
  const actual = structuredClone(grouped);
  actual.suites[1].specs[0].line += 4;
  assert.equal(validateCoverage(grouped, [{ policy: CANDIDATE_POLICY, index: 1, total: 1, report: actual }]).planned, 2);
  actual.suites[1].specs[0].tests[0].expectedStatus = "skipped";
  assert.throws(() => validateCoverage(grouped, [{ policy: CANDIDATE_POLICY, index: 1, total: 1, report: actual }]));
});

test("only planned, single-result skips are allowed in full-suite evidence", () => {
  const skipped = structuredClone(one);
  Object.assign(skipped.suites[0].specs[0].tests[0], {
    expectedStatus: "skipped", status: "skipped", results: [{ status: "skipped" }],
  });
  const shard = { policy: CANDIDATE_POLICY, index: 1, total: 1, report: skipped };
  assert.equal(validateCoverage(skipped, [shard]).planned, 1);
  for (const results of [[], [{ status: "passed" }], [{ status: "failed" }, { status: "skipped" }]]) {
    const changed = structuredClone(shard);
    changed.report.suites[0].specs[0].tests[0].results = results;
    assert.throws(() => validateCoverage(skipped, [changed]));
  }
});

test("live producer facts reject untrusted or incomplete CI", () => {
  const expected = { repository: "erdemtuna/doc-review", commit: "a".repeat(40), runId: "123", attempt: "1" };
  const run = { repository: { full_name: expected.repository }, head_repository: { full_name: expected.repository },
    path: ".github/workflows/test.yml", event: "push", head_branch: "main", head_sha: expected.commit,
    id: 123, run_attempt: 1, status: "completed", conclusion: "success" };
  const jobs = [...UNIT_JOBS, "chromium", "Verified main candidate"].map(name => ({ name, conclusion: "success" }));
  validateProducer(run, expected, jobs);
  for (const patch of [{ event: "pull_request" }, { head_branch: "feature" }, { head_sha: "b".repeat(40) },
    { path: ".github/workflows/other.yml" }, { run_attempt: 2 }, { status: "in_progress" },
    { conclusion: "cancelled" }, { head_repository: { full_name: "fork/repo" } }]) {
    assert.throws(() => validateProducer({ ...run, ...patch }, expected, jobs));
  }
  assert.throws(() => validateProducer(run, expected, jobs.slice(1)));
});

test("package options preserve the default and reject ambiguous configuration", () => {
  assert.equal(packageOptions(["--browser"]).suite, "parity");
  assert.deepEqual(packageOptions(["candidate.tgz", "--browser", "--suite=full", "--shard=1/2", "--workers=1"]),
    { archive: "candidate.tgz", browser: true, suite: "full", shard: "1/2", workers: 1 });
  for (const args of [["--suite=full"], ["--suite=parity"], ["--workers=1"], ["--browser", "--suite=unknown"], ["--browser", "--workers=0"],
    ["--browser", "--suite=full", "--shard=3/2"], ["--browser", "--shard=1/2"], ["a.tgz", "b.tgz"]]) {
    assert.throws(() => packageOptions(args));
  }
});

test("fixture runtime imports and CLI paths follow the installed override independently of cwd", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-runtime-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "probe.mjs"), 'export const marker = "installed";');
  const locator = JSON.stringify(new URL("./fixtures/runtime.js", import.meta.url).href);
  const code = `import { runtimeFile, runtimeImport } from ${locator};
    const { marker } = await runtimeImport("probe.mjs");
    console.log(JSON.stringify({ file: runtimeFile("folder/probe.js"), marker }));`;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: directory, env: { ...process.env, DOC_REVIEW_TEST_RUNTIME: directory }, encoding: "utf8",
  }));
  assert.deepEqual(result, { file: path.join(directory, "folder", "probe.js"), marker: "installed" });
  const env = { ...process.env };
  delete env.DOC_REVIEW_TEST_RUNTIME;
  const fallback = execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { runtimeFile } from ${locator}; console.log(runtimeFile("cli.js"));`],
  { cwd: directory, env, encoding: "utf8" }).trim();
  assert.equal(fallback, path.resolve("lib", "cli.js"));
});

test("candidate contexts and archive allowlists fail closed", () => {
  assert.throws(() => candidateContext({}));
  assert.throws(() => validateEntries(["package/../outside"]));
  assert.throws(() => validateEntries(["package/lib/.env"]));
  assert.throws(() => validateEntries(["package/node_modules/pkg.js"]));
  assert.throws(() => validateEntries(["package/scripts/danger.js"]));
  assert.throws(() => validateEntries(["package/lib/contracts.ts"]));
  assert.throws(() => validateEntries(["package/lib/module.test.js"]));
  assert.throws(() => validateEntries(["/absolute"]));
  assert.throws(() => validateManifest({ name: "other", version: "1.0.0" }));
});

test("expired and wrong-source artifact identities are rejected", () => {
  const run = { id: 123, head_sha: "a".repeat(40) };
  const artifact = { id: 4, expired: false, workflow_run: { id: run.id, head_sha: run.head_sha } };
  validateArtifact(artifact, run);
  assert.throws(() => validateArtifact({ ...artifact, expired: true }, run));
  assert.throws(() => validateArtifact({ ...artifact, workflow_run: { id: 1, head_sha: run.head_sha } }, run));
});

test("read-only preflight identifies blockers without changing release state", () => {
  const input = { manifest: { name: "@erdemtuna/doc-review", version: "0.15.0" },
    registry: { name: "@erdemtuna/doc-review", versions: {}, "dist-tags": { latest: "0.14.0" } }, sha: "a".repeat(40), main: "a".repeat(40),
    previousTag: "v0.14.0", authentication: "token",
    checks: [...UNIT_JOBS, "chromium", "Verified main candidate"].map(name => ({ name, status: "completed", conclusion: "success" })),
    candidate: { runId: "123", artifactId: 4 } };
  assert.equal(releaseReadiness(input).ready, true);
  const result = releaseReadiness({ ...input, candidate: null,
    registry: { name: input.manifest.name, versions: { "0.15.0": {} } }, main: "b".repeat(40) });
  assert.equal(result.ready, false);
  assert.equal(result.blockers.length, 3);
});

test("preflight resolves the fork's origin instead of GitHub CLI's upstream default", () => {
  for (const origin of ["https://github.com/erdemtuna/doc-review.git", "https://github.com/erdemtuna/doc-review",
    "git@github.com:erdemtuna/doc-review.git", "ssh://git@github.com/erdemtuna/doc-review.git"]) {
    assert.equal(repositoryFromOrigin(origin), "erdemtuna/doc-review");
  }
  for (const origin of ["https://github.com/owner/repo/extra", "https://other.example/owner/repo.git",
    "https://user:credential@github.com/owner/repo.git", "git@personal-alias:owner/repo.git"]) {
    assert.throws(() => repositoryFromOrigin(origin), /--repo/);
  }
});

test("every preflight run lookup remains bound to the selected fork", () => {
  const repository = "erdemtuna/doc-review", main = "a".repeat(40);
  const run = { id: 123, repository: { full_name: repository }, head_repository: { full_name: repository },
    path: ".github/workflows/test.yml", event: "push", head_branch: "main", head_sha: main,
    run_attempt: 1, status: "completed", conclusion: "success" };
  const checks = [...UNIT_JOBS, "chromium", "Verified main candidate"].map(name => ({ name, conclusion: "success" }));
  const calls = [];
  const read = args => {
    calls.push(args);
    if (args[0] === "run") {
      assert.equal(args[args.indexOf("--repo") + 1], repository, "Never inherit the upstream CLI default");
      return args[1] === "list" ? [{ databaseId: run.id, headSha: main, ...run }] : { jobs: checks };
    }
    assert.equal(args[0], "api");
    assert(args[1].startsWith(`repos/${repository}/`));
    return args[1].endsWith("/artifacts") ? { artifacts: [{ id: 4, name: "verified-main-candidate-1",
      expired: false, workflow_run: { id: run.id, head_sha: main } }] } : run;
  };
  assert.deepEqual(readCandidateFacts(repository, main, read), { checks, candidate: { runId: "123", attempt: "1", artifactId: 4 } });
  assert.equal(calls.length, 4);
  assert.deepEqual(readCandidateFacts(repository, main, () => []), { checks: [], candidate: null });
});

test("phase records preserve failures without persisting command arguments or credentials", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phase-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(await toolingPhase(directory, "install-package", async () => 3), 3);
  await assert.rejects(toolingPhase(directory, "installed-browser", async () => { throw new Error("Failure"); }), /Failure/);
  const rows = fs.readFileSync(path.join(directory, "phases.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map(row => row.status), ["passed", "failed"]);
  for (const row of rows) {
    assert(row.durationMs >= 0);
    assert.deepEqual(Object.keys(row).sort(), ["phase", "startedAt", "completedAt", "durationMs", "status"].sort());
  }
  assert.equal(await ciToolingPhase("candidate-verify", async () => 7, {}), 7);
  const summary = path.join(directory, "summary.txt");
  await ciToolingPhase("candidate-verify", async () => 7, { RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: summary });
  assert.match(fs.readFileSync(summary, "utf8"), /candidate-verify.*passed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "doc-review-phases", "phases.jsonl"), "utf8")).phase, "candidate-verify");
});
