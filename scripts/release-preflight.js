import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { readJson } from "./release-candidate.js";
import { UNIT_JOBS, validateProducer } from "./release-evidence.js";
import { validateArtifact } from "./release-actions.js";

export function repositoryFromOrigin(origin) {
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(origin);
  assert(match, "Origin must identify a github.com repository; use --repo owner/name for an SSH alias");
  return match[1];
}

export function readCandidateFacts(repository, main, read) {
  const runs = read(["run", "list", "--repo", repository, "--workflow", "test.yml", "--branch", "main", "--limit", "30",
    "--json", "databaseId,headSha,event,status,conclusion"]);
  const run = runs.find(run => run.headSha === main && run.event === "push" && run.status === "completed" && run.conclusion === "success");
  const producer = run ? read(["api", `repos/${repository}/actions/runs/${run.databaseId}`]) : null;
  const attempt = producer?.run_attempt ?? null;
  const checks = run ? read(["run", "view", String(run.databaseId), "--repo", repository, "--json", "jobs"]).jobs : [];
  const artifacts = run ? read(["api", `repos/${repository}/actions/runs/${run.databaseId}/artifacts`]).artifacts : [];
  const matches = artifacts.filter(artifact => artifact.name === `verified-main-candidate-${attempt}` && !artifact.expired);
  assert(matches.length <= 1, "Ambiguous candidate artifact");
  const artifact = matches[0];
  if (artifact) {
    validateProducer(producer, { repository, commit: main, runId: String(run.databaseId), attempt: String(attempt) }, checks);
    validateArtifact(artifact, producer);
  }
  return { checks, candidate: artifact ? { runId: String(run.databaseId), attempt: String(attempt), artifactId: artifact.id } : null };
}

export function releaseReadiness({ manifest, registry, sha, main, previousTag, authentication, checks, candidate }) {
  assert(["token", "oidc"].includes(authentication));
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.match(previousTag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (Object.keys(registry).length) {
    assert.equal(registry.name, manifest.name, "Unexpected registry package");
    assert(registry.versions && typeof registry.versions === "object" && !Array.isArray(registry.versions), "Malformed registry versions");
  }
  const blockers = [];
  if (sha !== main) blockers.push("Checkout is not the current main commit.");
  if (registry.versions?.[manifest.version]) blockers.push("This version is already published; choose an unused version.");
  const latest = registry["dist-tags"]?.latest ?? null;
  if (latest) {
    assert.match(latest, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Registry latest is not a plain release version");
    const proposed = manifest.version.split(".").map(BigInt), published = latest.split(".").map(BigInt);
    const index = proposed.findIndex((part, index) => part !== published[index]);
    if (index < 0 || proposed[index] < published[index]) blockers.push("Candidate must be newer than official npm latest.");
  }
  const required = [...UNIT_JOBS, "chromium", "Verified main candidate"];
  if (required.some(name => !checks.some(check => check.name === name && check.status === "completed" && check.conclusion === "success"))) {
    blockers.push("Required CI gates are not all successful.");
  }
  if (!candidate) blockers.push("No successful current-main push CI candidate; wait for CI or explicitly use fresh prepare.");
  return { package: manifest.name, version: manifest.version, sha, main, previousTag, authentication,
    latest, candidate, ready: blockers.length === 0, blockers };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { "previous-tag": { type: "string" }, authentication: { type: "string", default: "token" },
    output: { type: "string" }, repo: { type: "string" } } });
  assert.match(values["previous-tag"] ?? "", /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Provide --previous-tag vMAJOR.MINOR.PATCH");
  assert(["token", "oidc"].includes(values.authentication));
  const manifest = readJson("package.json");
  const git = args => execFileSync("git", args, { encoding: "utf8" }).trim();
  const gh = args => JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
  assert.equal(git(["status", "--porcelain"]), "", "Commit pending changes before release preflight");
  const selected = values.repo ?? repositoryFromOrigin(git(["remote", "get-url", "origin"]));
  assert.match(selected, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Provide --repo owner/name");
  const repository = gh(["repo", "view", selected, "--json", "nameWithOwner"]).nameWithOwner;
  gh(["api", `repos/${repository}/git/ref/tags/${values["previous-tag"]}`]);
  const sha = git(["rev-parse", "HEAD"]), main = gh(["api", `repos/${repository}/git/ref/heads/main`]).object.sha;
  const response = await fetch(`https://registry.npmjs.org/${manifest.name}`, { signal: AbortSignal.timeout(30_000) });
  assert(response.ok || response.status === 404, `Registry read failed (${response.status})`);
  const registry = response.status === 404 ? {} : await response.json();
  const { checks, candidate } = readCandidateFacts(repository, main, gh);
  const result = releaseReadiness({ manifest, registry, sha, main, previousTag: values["previous-tag"],
    authentication: values.authentication, checks, candidate });
  if (values.output) fs.writeFileSync(values.output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}
