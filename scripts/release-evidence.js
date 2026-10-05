import assert from "node:assert/strict";

export const CANDIDATE_POLICY = "installed-full-v1";
export const UNIT_JOBS = ["unit (ubuntu-latest, 24.21.0)", "unit (ubuntu-latest, 24)",
  "unit (windows-latest, 24)", "unit (ubuntu-latest, 26)"];

export function validateGates(jobs, names) {
  for (const name of names) {
    const matches = jobs.filter(job => job.name === name);
    assert.equal(matches.length, 1, `Missing or ambiguous gate: ${name}`);
    assert.equal(matches[0].conclusion, "success", `Unsuccessful gate: ${name}`);
  }
}

export function validateProducer(run, expected, jobs) {
  assert.equal(run.repository?.full_name, expected.repository, "Producer repository mismatch");
  assert.equal(run.head_repository?.full_name, expected.repository, "Fork producers are not eligible");
  assert.equal(run.path, ".github/workflows/test.yml", "Unexpected producer workflow");
  assert.equal(run.event, "push", "Only main push CI can issue release candidates");
  assert.equal(run.head_branch, "main", "Producer must run on main");
  assert.equal(run.head_sha, expected.commit, "Producer is not current main");
  assert.equal(String(run.id), expected.runId, "Producer run mismatch");
  assert.equal(String(run.run_attempt), expected.attempt, "Producer attempt mismatch");
  assert.equal(run.status, "completed", "Producer is incomplete");
  assert.equal(run.conclusion, "success", "Producer did not succeed");
  validateGates(jobs, [...UNIT_JOBS, "chromium", "Verified main candidate"]);
}

export function reportTests(report) {
  const found = [];
  function visit(suite, parents = []) {
    const titles = [...parents, suite.title ?? ""];
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      found.push({ id: JSON.stringify([spec.file, ...titles, spec.title, test.projectName]),
        expected: test.expectedStatus, status: test.status, results: test.results });
    }
    for (const child of suite.suites ?? []) visit(child, titles);
  }
  for (const suite of report.suites ?? []) visit(suite);
  assert(found.length > 0, "Empty test report");
  return found;
}

export function validateCoverage(planned, shards) {
  const plan = reportTests(planned);
  const expectations = new Map(plan.map(test => [test.id, test.expected]));
  const expected = new Set(expectations.keys());
  assert.equal(plan.length, expected.size, "Duplicate planned test");
  const covered = new Set();
  assert(shards.length > 0, "No shard evidence");
  const shardIds = new Set();
  for (const shard of shards) {
    assert.equal(shard.policy, CANDIDATE_POLICY);
    assert.equal(shard.total, shards.length, "Incomplete shard set");
    assert(Number.isInteger(shard.index) && shard.index >= 1 && shard.index <= shard.total);
    assert(!shardIds.has(shard.index), "Duplicate shard");
    shardIds.add(shard.index);
    assert.deepEqual(shard.report.errors ?? [], [], "Browser runner errors");
    for (const test of reportTests(shard.report)) {
      assert(expected.has(test.id), `Unexpected test: ${test.id}`);
      assert(!covered.has(test.id), `Repeated test: ${test.id}`);
      assert.equal(test.expected, expectations.get(test.id), `Changed test expectation: ${test.id}`);
      covered.add(test.id);
      assert.equal(test.results.length, 1, `Retried or unexecuted test cannot certify a candidate: ${test.id}`);
      if (test.expected === "skipped") {
        assert.equal(test.status, "skipped", "Unexpected skip outcome");
        assert.equal(test.results[0].status, "skipped", "Planned skip has an unexpected result");
      } else {
        assert.equal(test.expected, "passed", `Expected failures cannot certify a candidate: ${test.id}`);
        assert.equal(test.status, "expected", `Flaky or failed test: ${test.id}`);
        assert.equal(test.results[0].status, "passed", `Unsuccessful test: ${test.id}`);
      }
    }
  }
  assert.deepEqual([...covered].sort(), [...expected].sort(), "Missing planned tests");
  return { planned: expected.size, executed: covered.size, shards: shards.length, retries: 0 };
}
