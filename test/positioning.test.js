import test from "node:test";
import assert from "node:assert/strict";
import { lastVisibleRect, placeContextualSurface } from "../src/positioning.js";

const viewport = { left: 0, top: 0, width: 1200, height: 800 };
const frameRect = { left: 0, top: 48, right: 1200, bottom: 800 };

test("placement attaches on desktop and uses a sheet only at the responsive breakpoint", () => {
  const rects = [
    { left: 100, top: 100, right: 180, bottom: 120, width: 80, height: 20 },
    { left: 200, top: 125, right: 260, bottom: 145, width: 60, height: 20 },
  ];
  assert.equal(lastVisibleRect(rects), rects[1]);
  const geometry = {
    relation: "visible",
    rects,
    clip: { left: 0, top: 0, right: 1200, bottom: 752, width: 1200, height: 752 },
    horizontal: 260,
  };
  assert.equal(placeContextualSurface(geometry, { frameRect, viewport }).kind, "attached");
  assert.equal(placeContextualSurface(geometry, {
    frameRect,
    viewport: { left: 0, top: 0, width: 600, height: 800 },
    narrow: true,
  }).kind, "sheet");
  assert.notEqual(placeContextualSurface(geometry, {
    frameRect,
    viewport: { left: 0, top: 0, width: 1200, height: 300 },
    surfaceHeight: 220,
  }).kind, "sheet");
});

test("edge placement uses the nested clipping rectangle and stable horizontal coordinate", () => {
  const clip = { left: 100, top: 160, right: 700, bottom: 460, width: 600, height: 300 };
  const top = placeContextualSurface({ relation: "above", rects: [], clip, horizontal: 320 }, {
    frameRect,
    viewport,
    surfaceHeight: 180,
  });
  const bottom = placeContextualSurface({ relation: "below", rects: [], clip, horizontal: 320 }, {
    frameRect,
    viewport,
    surfaceHeight: 180,
  });
  assert.equal(top.kind, "edge-top");
  assert.equal(top.top, frameRect.top + clip.top + 12);
  assert.equal(bottom.kind, "edge-bottom");
  assert.equal(bottom.top, frameRect.top + clip.bottom - 180 - 12);
  assert.equal(top.left, bottom.left);
  assert.deepEqual(placeContextualSurface({ relation: "unavailable", clip, rects: [] }, {
    frameRect,
    viewport,
  }), { kind: "hidden" });
});
