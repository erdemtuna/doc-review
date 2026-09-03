import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptedOpenGeneration,
  acceptsTargetGeometry,
  sanitizeClientRects,
  targetMessage,
} from "../src/comment-target.js";

test("client rectangles are finite, clipped, bounded, and generation checked", () => {
  const viewport = { width: 100, height: 80 };
  const rects = sanitizeClientRects([
    { left: -10, top: 5, right: 30, bottom: 25, width: 40, height: 20 },
    { left: Infinity, top: 0, right: 2, bottom: 2, width: 2, height: 2 },
    { left: 120, top: 0, right: 130, bottom: 10, width: 10, height: 10 },
  ], viewport);
  assert.deepEqual(rects, [{ left: 0, top: 5, right: 30, bottom: 25, width: 30, height: 20 }]);
  const target = targetMessage({
    kind: "selection",
    quote: "x",
    anchor: { quote: "x" },
    rects,
    generation: 3,
    relation: "visible",
    clip: { left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 },
    horizontal: 30,
  }, viewport);
  assert.equal(target.generation, 3);
  assert.equal(target.relation, "visible");
  assert.equal(target.horizontal, 30);
  assert.equal(acceptsTargetGeometry(3, target), true);
  assert.equal(acceptsTargetGeometry(4, target), false);
});

test("comment opening changes authority only after an accepted matching generation", () => {
  const state = { pendingGeneration: 4, retargetGeneration: 5 };
  assert.equal(acceptedOpenGeneration(state, { accepted: false, requestedGeneration: 5 }), 4);
  assert.equal(acceptedOpenGeneration(state, { accepted: true, requestedGeneration: 5 }), 5);
  assert.equal(acceptedOpenGeneration(state, { accepted: true, requestedGeneration: 9 }), null);
});
