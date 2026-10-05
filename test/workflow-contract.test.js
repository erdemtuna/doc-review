import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const load = name => yaml.load(fs.readFileSync(`.github/workflows/${name}.yml`, "utf8"));

test("CI preserves stable gates and seals main artifacts only after full validation", () => {
  const workflow = load("test"), jobs = workflow.jobs;
  assert.equal(jobs.unit.strategy.matrix.include.length, 4);
  assert.equal(jobs.chromium.name, "chromium");
  assert.deepEqual(jobs.chromium.needs, ["build", "preflight", "browser"]);
  assert.deepEqual(jobs.candidate.needs, ["unit", "chromium"]);
  assert.match(jobs.candidate.if, /github\.event_name == 'push'/);
  assert.match(jobs.candidate.if, /github\.ref == 'refs\/heads\/main'/);
  assert.deepEqual(jobs.browser.strategy.matrix.shard, [1, 2]);
  const command = jobs.browser.steps.find(step => step.run?.includes("--suite=full")).run;
  assert.match(command, /--shard=\$\{\{ matrix\.shard \}\}\/2/);
  assert.match(command, /--workers=1/);
  assert(jobs.browser.steps.some(step => step.if?.includes("steps.diagnostics.outcome") && step.uses?.startsWith("actions/upload-artifact@")));
  assert.equal(workflow.permissions.contents, "read");
  assert.match(workflow.concurrency["cancel-in-progress"], /pull_request/);
  for (const job of Object.values(jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/, "Workflow actions must be immutable pins");
      assert(!JSON.stringify(step.env ?? {}).includes("NPM_PUBLISH_TOKEN"));
    }
  }
});

test("prepare adoption is nonprivileged and publication remains separately protected", () => {
  const workflow = load("release"), jobs = workflow.jobs;
  assert.equal(workflow.on.workflow_dispatch.inputs.authentication.default, "token");
  assert.equal(workflow.on.workflow_dispatch.inputs.prepare_mode.default, "reuse");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(jobs.publish.environment, "npm-release");
  assert.deepEqual(jobs.publish.needs, ["guard", "verify"]);
  assert.equal(jobs.fresh.uses, "./.github/workflows/test.yml");
  assert.deepEqual(jobs.prepare.needs, ["guard", "fresh"]);
  assert(!jobs.prepare.steps.some(step => /npm (?:ci|pack)|test:browser/.test(step.run ?? "")), "Reuse prepare must not rebuild/retest");
  for (const id of ["guard", "prepare", "verify"]) {
    assert(!JSON.stringify(jobs[id]).includes("secrets.NPM_PUBLISH_TOKEN"), "Secrets cannot enter candidate verification");
  }
  const secretSteps = jobs.publish.steps.filter(step => JSON.stringify(step).includes("secrets.NPM_PUBLISH_TOKEN"));
  assert.equal(secretSteps.length, 1);
  assert.equal(secretSteps[0].env.NODE_AUTH_TOKEN, "${{ secrets.NPM_PUBLISH_TOKEN }}");
  const verifier = jobs.publish.steps.find(step => step.run?.includes("release-actions.js verify"));
  assert(verifier, "The privileged job must recheck live provenance and bytes");
  assert(!jobs.publish.steps.some(step => /npm ci|npm pack|test:browser/.test(step.run ?? "")));
  const publications = jobs.publish.steps.filter(step => /npm publish "\$FILENAME"/.test(step.run ?? ""));
  assert.equal(publications.length, 2);
  for (const step of publications) assert.match(step.run, /npm publish "\$FILENAME" --ignore-scripts/);
});
