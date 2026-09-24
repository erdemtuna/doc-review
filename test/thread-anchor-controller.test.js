import test from "node:test";
import assert from "node:assert/strict";
import { createThreadAnchorController } from "../lib/thread-anchor-controller.js";
import { frameThreadActionSchema, validateFrameThreadAction, validateFrameAnchorStates } from "../lib/contracts/frame.js";

const scope = { capability: "frame-only", reviewId: "review", pageKey: "page", renderId: "render", generation: 1, projectionRevision: 1 };
const projection = { type: "eh:threadAnchors", ...scope, anchors: [
  { threadId: "one", target: { kind: "selection", anchor: { quote: "Original" } } },
  { threadId: "two", target: { kind: "element", anchor: { selector: "#copy" } } },
] };
const action = { type: "eh:threadAction", ...scope, action: "activate", threadId: "one" };
const found = { state: "found", rects: [{ left: 10, top: 10, right: 30, bottom: 30, width: 20, height: 20 }],
  viewport: { width: 200, height: 100 }, relation: "visible" };
const rejects = (fn, code) => assert.throws(fn, (error) => error.code === code);

test("producer and consumer roundtrip every anchor status without conversation data", () => {
  const cases = [found, ...["above", "below", "left", "right"].map((relation) => ({ ...found, relation })),
    { state: "missing" }, { state: "ambiguous", candidateCount: 2 },
    ...["hidden", "not-measurable", "render-loading", "render-changed", "render-unavailable", "invalid-selector"]
      .map((reason) => ({ state: "unavailable", reason }))];
  let current = found;
  const reports = [];
  const producer = createThreadAnchorController({
    channel: scope, resolve: ({ threadId }) => ({ threadId, ...current }),
    changed: (sent, report) => reports.push(validateFrameAnchorStates(report, sent)),
  });
  producer.project(projection);
  for (const state of cases) {
    current = state; producer.refresh();
    assert.equal(reports.at(-1).anchors.length, 2);
    assert.deepEqual(reports.at(-1).anchors[0], { threadId: "one", ...state });
  }
  for (const extra of [{ body: "private" }, { intent: "request-change" }, { resultNote: "private" }, { apiToken: "private" }]) {
    rejects(() => producer.project({ ...projection, ...extra }), "INVALID_INPUT");
    rejects(() => producer.project({ ...projection, anchors: [{ ...projection.anchors[0], ...extra }] }), "INVALID_INPUT");
    rejects(() => frameThreadActionSchema.parse({ ...action, ...extra }), "INVALID_INPUT");
  }
});

test("both endpoints reject each foreign scope component, duplicate membership and stale actions", () => {
  const producer = createThreadAnchorController({
    channel: scope, resolve: ({ threadId }) => ({ threadId, ...found }), changed() {},
  });
  const report = producer.project(projection);
  for (const field of Object.keys(scope).filter((field) => field !== "projectionRevision")) {
    const changed = field === "generation" ? 2 : "foreign";
    rejects(() => producer.project({ ...projection, [field]: changed }), "SCOPE_MISMATCH");
    rejects(() => producer.action({ ...action, [field]: changed }), "SCOPE_MISMATCH");
    rejects(() => validateFrameThreadAction({ ...action, [field]: changed }, projection), "SCOPE_MISMATCH");
    rejects(() => validateFrameAnchorStates({ ...report, [field]: changed }, projection), "SCOPE_MISMATCH");
  }
  rejects(() => producer.project({ ...projection, anchors: [projection.anchors[0], projection.anchors[0]] }), "INVALID_INPUT");
  const next = { ...projection, projectionRevision: 2, anchors: [projection.anchors[1]] };
  producer.project(next);
  rejects(() => producer.action(action), "SCOPE_MISMATCH");
  rejects(() => validateFrameAnchorStates(report, next), "SCOPE_MISMATCH");
  assert.equal(producer.projection.anchors.length, 1);
});

test("actions remeasure before activation/reveal, while dismissal remains available after target loss", () => {
  let state = found;
  const producer = createThreadAnchorController({
    channel: scope, resolve: ({ threadId }) => ({ threadId, ...state }), changed() {},
  });
  rejects(() => producer.action(action), "SCOPE_MISMATCH");
  producer.project(projection);
  assert.deepEqual(producer.action(action), action);
  for (const unavailable of [{ state: "missing" }, { state: "ambiguous", candidateCount: 2 }, { state: "unavailable", reason: "hidden" }]) {
    state = unavailable;
    rejects(() => producer.action(action), "INVALID_INPUT");
    rejects(() => producer.action({ ...action, action: "reveal" }), "INVALID_INPUT");
    assert.equal(producer.action({ ...action, action: "dismiss" }).action, "dismiss");
  }
});

test("invalid measurements do not publish or install a replacement projection", () => {
  let invalid = false, reports = 0;
  const producer = createThreadAnchorController({
    channel: scope, resolve: ({ threadId }) => ({ threadId, ...found, ...(invalid ? { body: "private" } : {}) }),
    changed() { reports++; },
  });
  producer.project(projection);
  invalid = true;
  rejects(() => producer.project({ ...projection, projectionRevision: 2, anchors: [projection.anchors[1]] }), "INVALID_INPUT");
  assert.deepEqual(producer.projection, projection);
  assert.equal(reports, 1);
  invalid = false;
  producer.refresh();
  assert.equal(reports, 1);
});

test("equal geometry still reconciles DOM ownership without repeating state reports", () => {
  let reconciliations = 0, reports = 0;
  const producer = createThreadAnchorController({
    channel: scope, resolve: ({ threadId }) => ({ threadId, ...found }),
    reconcile() { reconciliations++; }, changed() { reports++; },
  });
  producer.project(projection);
  producer.refresh();
  assert.equal(reconciliations, 2);
  assert.equal(reports, 1);
});
test("SDK echoes revisions, accepts exact duplicate projections and rejects reuse, rollback and stale actions", () => {
  let resolutions = 0;
  const reports = [];
  const producer = createThreadAnchorController({
    channel: scope, resolve: ({ threadId }) => { resolutions++; return { threadId, ...found }; },
    changed(_projection, report) { reports.push(report); },
  });
  assert.equal(producer.project(projection).projectionRevision, 1);
  producer.project({ ...projection, anchors: [...projection.anchors].reverse() });
  assert.equal(reports.length, 2);
  assert.equal(producer.action(action).projectionRevision, 1);
  rejects(() => producer.project({ ...projection, anchors: [projection.anchors[0]] }), "SCOPE_MISMATCH");
  rejects(() => producer.project({ ...projection, anchors: [
    { ...projection.anchors[0], target: projection.anchors[1].target }, projection.anchors[1],
  ] }), "SCOPE_MISMATCH");
  const next = { ...projection, projectionRevision: 2, anchors: [projection.anchors[0]] };
  assert.equal(producer.project(next).projectionRevision, 2);
  const count = resolutions;
  rejects(() => producer.project(projection), "SCOPE_MISMATCH");
  for (const kind of ["activate", "reveal", "dismiss"]) {
    rejects(() => producer.action({ ...action, action: kind }), "SCOPE_MISMATCH");
    rejects(() => producer.action({ ...action, action: kind, projectionRevision: 3 }), "SCOPE_MISMATCH");
  }
  assert.equal(resolutions, count, "Rejected actions must not even remeasure or reconcile DOM ownership.");
  assert.deepEqual(producer.projection, next);
  assert.equal(producer.action({ ...action, projectionRevision: 2 }).projectionRevision, 2);
  const replacement = createThreadAnchorController({
    channel: { ...scope, generation: 2 }, resolve: ({ threadId }) => ({ threadId, ...found }), changed() {},
  });
  rejects(() => replacement.project(next), "SCOPE_MISMATCH");
  assert.equal(replacement.project({ ...next, generation: 2, renderId: "replacement", projectionRevision: 3 }).projectionRevision, 3);
});
test("mixed revisionless SDK contracts fail closed instead of assuming revision one", () => {
  const producer = createThreadAnchorController({
    channel: scope, resolve: ({ threadId }) => ({ threadId, ...found }), changed() {},
  });
  for (const projectionRevision of [undefined, null, 0, -1, 1.5, "1", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    rejects(() => producer.project({ ...projection, projectionRevision }), "INVALID_INPUT");
  }
  assert.equal(producer.projection, null);
  producer.project(projection);
  for (const projectionRevision of [undefined, null, 0, -1, 1.5, "1"]) {
    rejects(() => producer.action({ ...action, projectionRevision }), "INVALID_INPUT");
    rejects(() => validateFrameAnchorStates({ ...producer.refresh(), projectionRevision }, projection), "INVALID_INPUT");
  }
});
