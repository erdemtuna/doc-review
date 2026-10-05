import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { candidateContext, readJson, verifyCandidate } from "./release-candidate.js";
import { validateProducer, validateGates, UNIT_JOBS } from "./release-evidence.js";
import { ciToolingPhase } from "./tooling-phase.js";

const gh = args => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const FRESH_VALIDATION_GATES = [...UNIT_JOBS.map(name => `Fresh validation / ${name}`), "Fresh validation / chromium"];
const api = route => JSON.parse(gh(["api", route]));
function pages(route, field, read = api) {
  const values = [];
  for (let page = 1; ; page++) {
    const response = read(`${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const items = response[field];
    assert(Array.isArray(items), `Malformed GitHub ${field}`);
    values.push(...items);
    if (items.length < 100) return values;
  }
}
const output = (key, value) => {
  assert(!String(value).includes("\n"));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};

function currentMain(context, read = api) {
  assert.equal(context.ref, "refs/heads/main", "Release must run on main");
  assert.equal(read(`repos/${context.repository}/git/ref/heads/main`).object.sha, context.commit, "Main moved; redispatch on its current head");
}

function canonicalMetadata(repository, origin) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doc-review-provenance-"));
  try {
    gh(["run", "download", origin.runId, "--repo", repository,
      "--name", `verified-main-candidate-${origin.attempt}`, "--dir", directory]);
    return verifyCandidate(directory);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

export function validateArtifact(artifact, run) {
  assert.equal(artifact.expired, false, "Artifact expired; use explicit fresh preparation");
  assert(Number.isSafeInteger(artifact.id) && artifact.id > 0);
  assert.equal(artifact.workflow_run?.id, run.id, "Artifact producer mismatch");
  assert.equal(artifact.workflow_run?.head_sha, run.head_sha, "Artifact source mismatch");
}

function producer(context, meta, read = api, loadArtifact = canonicalMetadata) {
  const origin = meta.producer ?? { runId: meta.workflow_run_id, attempt: meta.workflow_run_attempt };
  assert.match(origin.runId ?? "", /^[1-9]\d*$/, "Invalid producer run identity");
  assert.match(origin.attempt ?? "", /^[1-9]\d*$/, "Invalid producer attempt");
  const run = read(`repos/${context.repository}/actions/runs/${origin.runId}`);
  const jobs = pages(`repos/${context.repository}/actions/runs/${origin.runId}/attempts/${origin.attempt}/jobs`, "jobs", read);
  validateProducer(run, { repository: context.repository, commit: context.commit, ...origin }, jobs);
  const artifacts = pages(`repos/${context.repository}/actions/runs/${origin.runId}/artifacts`, "artifacts", read);
  const candidates = artifacts.filter(artifact => artifact.name === `verified-main-candidate-${origin.attempt}`);
  assert.equal(candidates.length, 1, "Missing or ambiguous verified main artifact");
  validateArtifact(candidates[0], run);
  if (origin.artifactId) assert.equal(candidates[0].id, origin.artifactId, "Producer artifact identity changed");
  if (meta.sha256) {
    const canonical = loadArtifact(context.repository, origin);
    for (const key of ["package", "version", "filename", "repository", "commit", "policy", "sha256", "integrity", "runtime", "coverage"]) {
      assert.deepEqual(meta[key], canonical[key], `Bundle differs from the live producer artifact: ${key}`);
    }
    assert.equal(canonical.workflow_run_id, origin.runId);
    assert.equal(canonical.workflow_run_attempt, origin.attempt);
    assert.equal(canonical.event, "push");
    assert.equal(canonical.ref, "refs/heads/main");
  }
  return { runId: origin.runId, attempt: origin.attempt, artifactId: candidates[0].id };
}

export async function selectCandidate(context, explicitRun, read = api) {
  currentMain(context, read);
  if (explicitRun) assert.match(explicitRun, /^[1-9]\d*$/, "Invalid candidate run ID");
  const runs = explicitRun ? [read(`repos/${context.repository}/actions/runs/${explicitRun}`)] :
    pages(`repos/${context.repository}/actions/workflows/test.yml/runs?branch=main&event=push&head_sha=${context.commit}`, "workflow_runs", read);
  const eligible = runs.filter(run => run.head_sha === context.commit && run.event === "push" && run.head_branch === "main");
  const succeeded = eligible.filter(run => run.status === "completed" && run.conclusion === "success")
    .sort((a, b) => b.id - a.id);
  assert(succeeded.length, "No successful current-main CI candidate; wait for CI or explicitly choose fresh preparation");
  const run = succeeded[0];
  const origin = producer(context, { workflow_run_id: String(run.id), workflow_run_attempt: String(run.run_attempt) }, read);
  output("candidate_run_id", origin.runId);
  output("candidate_attempt", origin.attempt);
  output("candidate_artifact_id", origin.artifactId);
  console.log(JSON.stringify({ source: context.commit, ...origin }));
  return origin;
}

export function adoptCandidate(context, source, destination, read = api, loadArtifact = canonicalMetadata) {
  currentMain(context, read);
  const manifest = readJson("package.json");
  const meta = verifyCandidate(source, { repository: context.repository, commit: context.commit,
    package: manifest.name, version: manifest.version, event: "push", ref: "refs/heads/main" });
  assert(meta.coverage, "Unsealed build is not a verified candidate");
  const origin = producer(context, meta, read, loadArtifact);
  fs.mkdirSync(destination, { recursive: true });
  assert.equal(fs.readdirSync(destination).length, 0, "Prepare destination is not empty");
  for (const file of [meta.filename, `${meta.filename}.sha256`]) fs.copyFileSync(path.join(source, file), path.join(destination, file));
  const prepared = { ...meta, producer: origin, workflow_run_id: context.runId,
    workflow_run_attempt: context.attempt, event: context.event, ref: context.ref };
  fs.writeFileSync(path.join(destination, "release-metadata.json"), `${JSON.stringify(prepared, null, 2)}\n`);
  verifyCandidate(destination, { workflow_run_id: context.runId, workflow_run_attempt: context.attempt });
  console.log(JSON.stringify({ preparedBy: context.runId, producer: origin, sha256: meta.sha256 }));
}

export function bindFreshCandidate(context, directory, read = api) {
  currentMain(context, read);
  const manifest = readJson("package.json");
  const meta = verifyCandidate(directory, { repository: context.repository, commit: context.commit,
    package: manifest.name, version: manifest.version, workflow_run_id: context.runId,
    workflow_run_attempt: context.attempt, event: "workflow_dispatch", ref: "refs/heads/main" });
  assert(meta.coverage, "Fresh candidate has no complete coverage");
  assert(!meta.producer, "Fresh validation cannot adopt another producer");
  const jobs = pages(`repos/${context.repository}/actions/runs/${context.runId}/attempts/${context.attempt}/jobs`, "jobs", read);
  validateGates(jobs, FRESH_VALIDATION_GATES);
  fs.renameSync(path.join(directory, "ci-metadata.json"), path.join(directory, "release-metadata.json"));
  return verifyCandidate(directory);
}

export function verifyPrepared(context, directory, prepareRun, read = api, loadArtifact = canonicalMetadata) {
  currentMain(context, read);
  assert.match(prepareRun ?? "", /^[1-9]\d*$/, "Provide an exact prepare run");
  const manifest = readJson("package.json");
  const meta = verifyCandidate(directory, { repository: context.repository, commit: context.commit, workflow_run_id: prepareRun,
    package: manifest.name, version: manifest.version, filename: `erdemtuna-doc-review-${manifest.version}.tgz`,
    event: "workflow_dispatch", ref: "refs/heads/main" });
  assert(meta.coverage, "Prepared candidate lacks full browser evidence");
  const run = read(`repos/${context.repository}/actions/runs/${prepareRun}`);
  assert.equal(run.repository?.full_name, context.repository);
  assert.equal(run.head_repository?.full_name, context.repository);
  assert.equal(run.path, ".github/workflows/release.yml");
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.head_branch, "main");
  assert.equal(run.head_sha, context.commit);
  assert.equal(String(run.run_attempt), meta.workflow_run_attempt);
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  const preparedArtifacts = pages(`repos/${context.repository}/actions/runs/${prepareRun}/artifacts`, "artifacts", read)
    .filter(artifact => artifact.name === `release-candidate-${meta.version}-attempt-${meta.workflow_run_attempt}`);
  assert.equal(preparedArtifacts.length, 1, "Missing or ambiguous prepared artifact");
  validateArtifact(preparedArtifacts[0], run);
  if (meta.producer) producer(context, meta, read, loadArtifact);
  else {
    const jobs = pages(`repos/${context.repository}/actions/runs/${prepareRun}/attempts/${meta.workflow_run_attempt}/jobs`, "jobs", read);
    validateGates(jobs, ["Prepare release candidate", ...FRESH_VALIDATION_GATES]);
  }
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV,
    `EXPECTED_INTEGRITY=${meta.integrity}\nEXPECTED_SHA256=${meta.sha256}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Verified candidate ${meta.package}@${meta.version}\n\nSource: ${meta.commit}\n\nPrepare: ${prepareRun}\n\nArchive SHA-256: ${meta.sha256}\n\nCoverage: ${meta.coverage.summary.executed} planned tests, no retries.\n`);
  console.log(JSON.stringify({ prepareRun, producer: meta.producer ?? "fresh-validated", sha256: meta.sha256,
    coverage: meta.coverage.summary }));
  return meta;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [operation, ...args] = process.argv.slice(2), context = candidateContext();
  await ciToolingPhase(`release-${operation}`, async () => {
    if (operation === "select") await selectCandidate(context, args[0]);
    else if (operation === "adopt") adoptCandidate(context, args[0], args[1]);
    else if (operation === "verify") verifyPrepared(context, args[0], args[1]);
    else if (operation === "fresh") {
      bindFreshCandidate(context, args[0]);
      console.log("Fresh verified archive promoted without changing its bytes.");
    } else assert.fail(`Unknown release action: ${operation}`);
  });
}
