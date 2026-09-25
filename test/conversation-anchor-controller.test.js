import test from "node:test";
import assert from "node:assert/strict";
import { createConversationAnchorController, describeConversationAnchor } from "../lib/conversation-anchor-controller.js";
import { placeConversationSurface } from "../lib/positioning.js";

const projection = { type: "eh:threadAnchors", capability: "cap", reviewId: "review", pageKey: "page", renderId: "render", generation: 1,
  projectionRevision: 1, anchors: ["one", "two"].map((threadId) => ({ threadId, target: { kind: "element", anchor: { selector: "#copy" } } })) };
const found = { state: "found", relation: "visible", rects: [{ left: 10, top: 20, right: 100, bottom: 40, width: 90, height: 20 }],
  viewport: { width: 1200, height: 800 } };
const report = { ...projection, type: "eh:threadAnchorStates", anchors: projection.anchors.map(({ threadId }) => ({ threadId, ...found })) };
test("shell validates full identity, exact membership and action direction before hosting", () => {
  const controller = createConversationAnchorController();
  controller.project(projection); controller.receive(report);
  assert.deepEqual(controller.peers("one"), ["one", "two"]);
  const action = controller.outgoing("activate", "one");
  assert.deepEqual(controller.incoming(action), action);
  for (const field of ["capability", "reviewId", "pageKey", "renderId", "generation"]) {
    const wrong = field === "generation" ? 2 : "wrong";
    assert.throws(() => controller.receive({ ...report, [field]: wrong }), { code: "SCOPE_MISMATCH" });
    assert.throws(() => controller.incoming({ ...action, [field]: wrong }), { code: "SCOPE_MISMATCH" });
  }
  assert.throws(() => controller.incoming({ ...action, threadId: "foreign" }), { code: "SCOPE_MISMATCH" });
  assert.throws(() => controller.incoming({ ...action, action: "reveal" }), { code: "INVALID_INPUT" });
  assert.throws(() => controller.receive({ ...report, token: "private" }), { code: "INVALID_INPUT" });
  assert.throws(() => controller.receive({ ...report, anchors: report.anchors.slice(0, 1) }), { code: "SCOPE_MISMATCH" });
  controller.reset();
  assert.throws(() => controller.incoming(action), { code: "SCOPE_MISMATCH" });
});
test("new members retain verified unchanged targets; replacement renders cannot borrow geometry", () => {
  const controller = createConversationAnchorController();
  controller.project(projection); controller.receive(report);
  controller.project({ ...projection, anchors: [...projection.anchors, { ...projection.anchors[0], threadId: "three" }] });
  assert.equal(controller.states.length, 2);
  assert.equal(controller.receive(report), false);
  controller.project({ ...projection, renderId: "replacement" });
  assert.deepEqual(controller.states, []);
  assert.throws(() => controller.outgoing("activate", "one"), { code: "INVALID_INPUT" });
  assert.equal(controller.outgoing("dismiss", "one").action, "dismiss");
});
test("projection revisions belong to the shell, deduplicate targets and do not alias after reset", () => {
  const controller = createConversationAnchorController();
  assert.equal(controller.project(projection), true);
  assert.equal(controller.projection.projectionRevision, 1);
  assert.equal(controller.project({ ...projection, anchors: [...projection.anchors].reverse() }), false);
  assert.equal(controller.projection.projectionRevision, 1);
  controller.receive(report);
  controller.reset();
  assert.throws(() => controller.receive(report), { code: "SCOPE_MISMATCH" });
  controller.project(projection);
  assert.equal(controller.projection.projectionRevision, 2);
  assert.equal(controller.receive(report), false);
  assert.deepEqual(controller.states, []);
  controller.project({ ...projection, generation: 2, renderId: "replacement" });
  assert.equal(controller.projection.projectionRevision, 3);
  assert.throws(() => controller.receive(report), { code: "SCOPE_MISMATCH" });
});
test("delayed reports and activations never replace or act on newer geometry", () => {
  const controller = createConversationAnchorController();
  controller.project({ ...projection, anchors: projection.anchors.slice(0, 1) });
  const earlier = { ...controller.projection, type: "eh:threadAnchorStates", anchors: report.anchors.slice(0, 1) };
  controller.receive(earlier);
  const activation = controller.outgoing("activate", "one");
  controller.project(projection);
  const current = { ...report, projectionRevision: controller.projection.projectionRevision,
    anchors: report.anchors.map(({ threadId }) => ({ threadId, state: "missing" })) };
  assert.equal(controller.receive(current), true);
  assert.equal(controller.receive(current), true);
  const before = controller.states;
  assert.equal(controller.receive(earlier), false);
  for (const action of ["activate", "dismiss"]) assert.equal(controller.incoming({ ...activation, action }), null);
  assert.strictEqual(controller.states, before);
  assert.throws(() => controller.outgoing("activate", "one"), { code: "INVALID_INPUT" });
  for (const anchors of [current.anchors.slice(0, 1), [...current.anchors, { threadId: "unknown", state: "missing" }],
    [{ threadId: "unknown", state: "missing" }, current.anchors[1]]]) {
    assert.throws(() => controller.receive({ ...current, anchors }), { code: "SCOPE_MISMATCH" });
  }
  assert.throws(() => controller.receive({ ...current, anchors: [current.anchors[0], current.anchors[0]] }), { code: "INVALID_INPUT" });
  assert.throws(() => controller.incoming({ ...activation, projectionRevision: 2, threadId: "unknown" }), { code: "SCOPE_MISMATCH" });
  assert.strictEqual(controller.states, before);
});
test("revisionless, malformed, future and foreign stale messages remain explicitly invalid", () => {
  const controller = createConversationAnchorController();
  controller.project(projection); controller.receive(report);
  const action = controller.outgoing("activate", "one");
  for (const projectionRevision of [undefined, null, 0, -1, 1.5, "1", Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => controller.receive({ ...report, projectionRevision }), { code: "INVALID_INPUT" });
    assert.throws(() => controller.incoming({ ...action, projectionRevision }), { code: "INVALID_INPUT" });
  }
  for (const projectionRevision of [2, 100]) {
    assert.throws(() => controller.receive({ ...report, projectionRevision }), { code: "SCOPE_MISMATCH" });
    assert.throws(() => controller.incoming({ ...action, projectionRevision }), { code: "SCOPE_MISMATCH" });
  }
  controller.project({ ...projection, anchors: projection.anchors.slice(0, 1) });
  for (const field of ["capability", "reviewId", "pageKey", "renderId", "generation"]) {
    const value = field === "generation" ? 999 : "foreign";
    assert.throws(() => controller.receive({ ...report, [field]: value }), { code: "SCOPE_MISMATCH" });
    assert.throws(() => controller.incoming({ ...action, [field]: value }), { code: "SCOPE_MISMATCH" });
  }
  assert.throws(() => controller.receive({ ...report, anchors: [{ threadId: "one", state: "found", rects: [] }] }), { code: "INVALID_INPUT" });
  assert.throws(() => controller.incoming({ ...action, action: "reveal" }), { code: "INVALID_INPUT" });
});
test("unavailable and ambiguous explanations never claim missing source or offer false jumps", () => {
  for (const state of [{ state: "missing" }, { state: "ambiguous", candidateCount: 2 },
    ...["hidden", "render-loading", "render-changed", "render-unavailable", "not-measurable", "invalid-selector"]
      .map((reason) => ({ state: "unavailable", reason }))]) {
    const view = describeConversationAnchor({ threadId: "one", ...state });
    assert.equal(view.canJump, false); assert.ok(view.reason);
  }
  assert.equal(describeConversationAnchor({ threadId: "one", ...found, relation: "below" }).offscreen, true);
});
test("adjacent placement uses measured local space without a gutter and never covers any selected rectangle", () => {
  const options = { frameRect: { left: 0, top: 48 }, viewport: { left: 0, top: 0, width: 1280, height: 800 } };
  const multi = { ...found, rects: [...found.rects, { left: 0, right: 600, top: 50, bottom: 70, width: 600, height: 20 }] };
  const position = placeConversationSurface(multi, options);
  assert.ok(position.left >= 612);
  assert.ok(position.top >= 60);
  assert.ok(position.top + position.height <= 788);
  const margin = placeConversationSurface(found, { ...options, frameRect: { ...options.frameRect, right: 784 } });
  assert.ok(margin.left < 784, "Unselected prose can be covered without reflowing the document.");
  assert.ok(placeConversationSurface({ ...found, rects: [{ left: 0, right: 1280, top: 0, bottom: 50, width: 1280, height: 50 }] }, options).top >= 110);
  for (const viewport of [{ ...options.viewport, width: 600 }, { ...options.viewport, height: 400 }]) {
    assert.ok(placeConversationSurface(found, { ...options, viewport }));
  }
  assert.equal(placeConversationSurface(found, { ...options, viewport: { ...options.viewport, height: 200 } }), null);
  for (const state of [{ state: "missing" }, { ...found, relation: "right", rects: [] }, { state: "unavailable", reason: "hidden" }]) {
    assert.equal(placeConversationSurface(state, options), null);
  }
  const short = placeConversationSurface(found, { ...options, height: 190, minHeight: 150 });
  assert.equal(short.height, 190);
  const tall = placeConversationSurface(found, { ...options, height: 1400, minHeight: 220 });
  assert.ok(tall.height >= 220 && tall.top + tall.height <= 788);
  assert.equal(placeConversationSurface({ ...found, rects: [{ left: 0, right: 1280, top: 0, bottom: 752, width: 1280, height: 752 }] }, options), null);
});
