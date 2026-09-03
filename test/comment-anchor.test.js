import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCommentAnchor } from "../src/comment-anchor.js";

test("persisted anchors allow semantic fields only", () => {
  assert.deepEqual(normalizeCommentAnchor("selection", {
    quote: "Selected",
    prefix: "before",
    suffix: "after",
    selector: "p:nth-child(1)",
    rects: [{ left: 1 }],
    viewport: { width: 100 },
    generation: 9,
    visible: true,
  }), {
    quote: "Selected",
    prefix: "before",
    suffix: "after",
    selector: "p:nth-child(1)",
  });
  assert.deepEqual(normalizeCommentAnchor("element", {
    selector: "#save",
    label: "Save",
    top: 10,
  }), { selector: "#save", label: "Save" });
  assert.equal(normalizeCommentAnchor("selection", { rects: [] }), null);
});
