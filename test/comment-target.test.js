import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptedOpenGeneration,
  acceptsTargetGeometry,
  createHoverIntent,
  groupCommentTargets,
  nextCommentId,
  sanitizeClientRects,
  targetMessage,
} from "../src/comment-target.js";

test("block groups preserve every id, ignore detached targets, and cycle drawer activation", () => {
  const first = { isConnected: true };
  const second = { isConnected: true };
  const groups = groupCommentTargets(new Map([
    ["one", first], ["two", first], ["three", second], ["gone", { isConnected: false }],
  ]));
  assert.deepEqual([...groups.values()], [["one", "two"], ["three"]]);
  assert.equal(nextCommentId(groups.get(first), null), "one");
  assert.equal(nextCommentId(groups.get(first), "one"), "two");
  assert.equal(nextCommentId(groups.get(first), "two"), "one");
  assert.equal(nextCommentId([], "two"), null);
});

test("hover intent dwells, preserves candidate clocks, cancels, and activates keyboard immediately", () => {
  let timer;
  let delay;
  const committed = [];
  const intent = createHoverIntent((value) => committed.push(value), {
    schedule(callback, ms) { timer = callback; delay = ms; return callback; },
    unschedule(handle) { if (timer === handle) timer = null; },
  });
  intent.request("one", "first");
  assert.equal(delay, 150);
  const firstTimer = timer;
  intent.request("one", "same candidate");
  assert.equal(timer, firstTimer);
  assert.deepEqual(committed, []);
  timer();
  assert.deepEqual(committed, ["first"]);
  intent.request("two", "second");
  assert.equal(delay, 100);
  intent.cancel();
  assert.equal(timer, null);
  intent.request(null, null);
  assert.equal(delay, 120);
  intent.request("one", "returned to corridor");
  assert.equal(timer, null);
  intent.request("two", "keyboard", true);
  assert.deepEqual(committed, ["first", "keyboard"]);
  intent.reset();
  intent.request("three", "after navigation");
  assert.equal(delay, 150);
  intent.reset();
  assert.equal(timer, null);
});

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
