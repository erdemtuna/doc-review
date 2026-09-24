import test from "node:test";
import assert from "node:assert/strict";
import { readNewMessageTarget } from "../lib/new-message-target.js";
import { placeNewMessageSurface } from "../lib/positioning.js";
import { targetMessage } from "../lib/comment-target.js";

const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
const viewport = { width: 1200, height: 752 };
const target = { kind: "selection", anchor: { quote: "Selected text", prefix: "", suffix: "" } };
const message = () => {
  const payload = targetMessage({ ...target, quote: "Selected text", generation: 7, relation: "visible",
    rects: [rect(80, 100, 280, 124)], clip: rect(0, 0, 1200, 752), horizontal: null }, viewport);
  return { ...payload, targetGeneration: payload.generation, viewport };
};
const options = { viewport: { ...viewport, height: 800, left: 0, top: 0 },
  frameRect: rect(0, 48, 1200, 800), surfaceWidth: 340, surfaceHeight: 310, toolbarHeight: 48 };

test("new comment consumes the actual existing SDK payload, nullable geometry never invents anchors", () => {
  assert.deepEqual(readNewMessageTarget(message()).target, target);
  assert.equal(readNewMessageTarget(message()).generation, 7);
  assert.equal(readNewMessageTarget(message()).geometry.horizontal, null);
  for (const change of [{ viewport: null }, { viewport: {} }, { viewport: 3 }, { clip: null }, { rects: null },
    { relation: "invented" }, { viewport: { width: 0, height: 752 } }]) {
    const decoded = readNewMessageTarget({ ...message(), ...change });
    assert.deepEqual(decoded.target, target);
    assert.equal(decoded.geometry, null);
  }
  for (const generation of [null, undefined, 0, -1, 1.5, "7", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => readNewMessageTarget({ ...message(), targetGeneration: generation }));
  }
  assert.throws(() => readNewMessageTarget({ ...message(), anchor: null }));
  for (const relation of ["above", "below", "unavailable"]) {
    assert.equal(readNewMessageTarget({ ...message(), relation, rects: [] }).geometry.relation, relation);
  }
});

test("new composition uses effective clipping and safe former placement without target overlap", () => {
  const geometry = readNewMessageTarget(message()).geometry;
  const placement = placeNewMessageSurface(geometry, options);
  assert.equal(placement.kind, "attached");
  assert.ok(placement.left >= 280 + 12);
  assert.equal(placeNewMessageSurface(geometry, { ...options, viewport: { ...options.viewport, width: 899 } }), null);
  assert.equal(placeNewMessageSurface(geometry, { ...options, surfaceHeight: 900 }), null);
  const clipped = readNewMessageTarget({ ...message(), clip: rect(100, 110, 240, 300) }).geometry;
  assert.deepEqual(clipped.rects, [rect(100, 110, 240, 124)]);
  assert.equal(placeNewMessageSurface(clipped, options), null);
  assert.equal(readNewMessageTarget({ ...message(), clip: rect(600, 400, 800, 700) }).geometry, null);
  const covered = { ...geometry, rects: [rect(0, 0, 1200, 752)] };
  assert.equal(placeNewMessageSurface(covered, options), null);
  for (const relation of ["above", "below"]) {
    const edge = placeNewMessageSurface({ ...geometry, relation, rects: [] }, options);
    assert.equal(edge.kind, relation === "above" ? "edge-top" : "edge-bottom");
    assert.ok(edge.top >= 60 && edge.top + edge.height <= 788);
  }
  assert.equal(placeNewMessageSurface({ ...geometry, relation: "unavailable", rects: [] }, options), null);
});
