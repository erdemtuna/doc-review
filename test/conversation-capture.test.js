import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../lib/chrome-api.js";
import { createResultCaptures, resultCaptureKey } from "../lib/conversation-capture.js";
import { normalizeView } from "../lib/view-identity.js";

const scope = () => ({ reviewId: "review", entryKey: "entry", submissionId: "submission", pageKey: "page",
  sessionId: "session", renderId: "render", generation: 1, sourceHash: "source", view: normalizeView(null) });
const content = (available) => ({ mode: "content", available, reason: "Content unavailable" });
const conflict = (code = "VERSION_CONFLICT", status = 409) => new ApiError("Typed failure", status, code, []);
function fixture(overrides = {}) {
  const state = { current: true, available: false, posts: 0, reads: 0, refreshes: 0, published: 0 };
  const owner = createResultCaptures({
    current: () => state.current,
    compare: async () => { state.reads++; return content(state.available); },
    capture: async () => { state.posts++; state.available = true; },
    refresh: async () => { state.refreshes++; },
    changed: () => { state.published++; }, ...overrides,
  });
  return { owner, state };
}

test("automatic and manual callers join one exact in-flight capture", async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const begun = new Promise(resolve => { started = resolve; });
  const { owner, state } = fixture({ capture: async () => { state.posts++; started(); await gate; state.available = true; } });
  const first = owner.request(scope());
  await begun;
  const second = owner.request(scope());
  assert.equal(first, second);
  assert.equal(state.posts, 1);
  release(); await Promise.all([first, second]);
  assert.equal(state.refreshes, 1);
  assert.deepEqual(owner.failures, []);
});

test("each existing review/result/page/frame/source/view identity separates capture ownership", () => {
  const initial = scope(), key = resultCaptureKey(initial);
  for (const field of ["reviewId", "entryKey", "submissionId", "pageKey", "sessionId", "renderId", "sourceHash"]) {
    assert.notEqual(resultCaptureKey({ ...initial, [field]: "different" }), key, field);
  }
  assert.notEqual(resultCaptureKey({ ...initial, generation: 2 }), key);
  assert.notEqual(resultCaptureKey({ ...initial, view: { version: 1, status: "identified",
    tabs: [{ groupId: "tabs", tabId: "tab", panelId: "panel", label: "View" }] } }), key);
  assert.equal(resultCaptureKey({ ...initial, view: null }), key, "null remains an accepted unverified view");
});

test("different result/page flights cannot coalesce or relabel each other's capture", async () => {
  const started = [], ready = new Set();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { owner } = fixture({
    compare: async value => content(ready.has(resultCaptureKey(value))),
    capture: async value => { started.push(value); await gate; ready.add(resultCaptureKey(value)); },
  });
  const one = owner.request(scope());
  const two = owner.request({ ...scope(), submissionId: "other", pageKey: "other-page" });
  assert.notEqual(one, two);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started.map(value => [value.submissionId, value.pageKey]), [["submission", "page"], ["other", "other-page"]]);
  release(); await Promise.all([one, two]);
});

test("typed immutable conflict reconciles only authoritative same-result Content, then refreshes", async () => {
  const scopes = [];
  let reads = 0, refreshed = 0;
  const { owner } = fixture({
    compare: async value => { scopes.push(value); return content(++reads > 1); },
    capture: async () => { throw conflict(); },
    refresh: async () => { refreshed++; },
  });
  await owner.request(scope());
  assert.equal(refreshed, 1);
  assert.ok(scopes.every(value => value.submissionId === "submission" && value.pageKey === "page"));
  assert.deepEqual(owner.failures, []);
});

for (const [code, status] of [["SAVE_EVIDENCE_CONFLICT", 409], ["SCOPE_MISMATCH", 403], ["STATE_PERSIST_FAILED", 503], ["OTHER", 409]]) {
  test(`${code} is not blanket-reconciled even if Content would later be available`, async () => {
    let reads = 0;
    const error = conflict(code, status);
    const { owner } = fixture({
      compare: async () => content(++reads > 1),
      capture: async () => { throw error; },
    });
    await assert.rejects(owner.request(scope()), value => value === error);
    assert.equal(reads, 1);
    assert.equal(owner.failures[0].message, error.message);
  });
}

for (const response of [{ mode: "source", available: true }, content(false), { mode: "content", available: "true" }]) {
  test(`conflict retains a failure for unavailable/invalid Content ${JSON.stringify(response)}`, async () => {
    let reads = 0;
    const { owner } = fixture({
      compare: async () => ++reads === 1 ? content(false) : response,
      capture: async () => { throw conflict(); },
    });
    await assert.rejects(owner.request(scope()));
    assert.equal(owner.failures.length, 1);
  });
}

test("late completion for a replaced frame/view cannot publish a new failure or clear an old one", async () => {
  const { owner, state } = fixture({ capture: async () => { state.current = false; throw conflict(); } });
  await assert.rejects(owner.request(scope()));
  assert.deepEqual(owner.failures, []);
});

test("a stale successful completion cannot erase an existing correlated failure", async () => {
  let current = true, retry = false, available = false;
  const { owner } = fixture({
    current: () => current,
    compare: async () => content(available),
    capture: async () => {
      if (!retry) throw conflict();
      available = true; current = false;
    },
  });
  await assert.rejects(owner.request(scope()));
  const failure = owner.failures[0];
  retry = true;
  await assert.rejects(owner.request(scope()));
  assert.equal(owner.failures[0], failure);
});

test("only the same result/page's authoritative available Content clears its recorded failure", async () => {
  let ready = false;
  const { owner } = fixture({
    capture: async () => { throw conflict(); },
    compare: async () => content(ready),
  });
  await assert.rejects(owner.request(scope()));
  ready = true;
  await owner.request({ ...scope(), submissionId: "other" });
  assert.equal(owner.failures.length, 1);
  await owner.request(scope());
  assert.deepEqual(owner.failures, []);
});

test("successful POST with unavailable Content is not reported as a complete capture", async () => {
  const { owner } = fixture({ compare: async () => content(false) });
  await assert.rejects(owner.request(scope()), /Content unavailable/);
  assert.equal(owner.failures.length, 1);
});

test("an explicit same-result Content read can reconcile a later observer, never Source or another result", async () => {
  const { owner } = fixture({ capture: async () => { throw conflict(); } });
  await assert.rejects(owner.request(scope()));
  assert.throws(() => owner.confirmContent(scope(), { mode: "source", available: true }), /Invalid comparison/);
  owner.confirmContent(scope(), content(false));
  owner.confirmContent({ ...scope(), submissionId: "different" }, content(true));
  assert.equal(owner.failures.length, 1);
  owner.confirmContent(scope(), content(true));
  assert.equal(owner.failures.length, 0);
});
