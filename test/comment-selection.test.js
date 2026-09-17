import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSelectionRange, pointInCommentApproach, sameRange } from "../lib/comment-target.js";

let JSDOM = null;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  // DOM tests require a Node version supported by jsdom.
}
const skip = JSDOM ? false : "jsdom unavailable on this Node version";

function fixture() {
  const dom = new JSDOM("<body><p id='one'>First <strong>bold</strong> ending.</p><script>excluded</script><p id='two'>Next paragraph.</p></body>");
  const document = dom.window.document;
  const walker = document.createTreeWalker(document.body, dom.window.NodeFilter.SHOW_TEXT);
  const map = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement.closest("script")) continue;
    map.push({ node, start: text.length, end: text.length + node.nodeValue.length });
    text += node.nodeValue;
  }
  return { dom, document, map, text };
}

test("element endpoints normalize to included text without the next paragraph", { skip }, () => {
  const { dom, document, map, text } = fixture();
  const range = document.createRange();
  range.setStart(document.querySelector("#one"), 0);
  range.setEnd(document.querySelector("#two"), 0);
  const normalized = normalizeSelectionRange(map, range);
  assert.equal(text.slice(normalized.start, normalized.end), "First bold ending.");
  assert.equal(normalized.range.startContainer, document.querySelector("#one").firstChild);
  assert.equal(normalized.range.endContainer, document.querySelector("#one").lastChild);
  assert.equal(range.endContainer, document.querySelector("#two"), "the native selection is not modified");
  dom.window.close();
});

test("whole-body and partial multi-node ranges preserve filtered offsets", { skip }, () => {
  const { dom, document, map, text } = fixture();
  const range = document.createRange();
  range.selectNodeContents(document.body);
  let normalized = normalizeSelectionRange(map, range);
  assert.equal(text.slice(normalized.start, normalized.end), "First bold ending.Next paragraph.");
  range.setStart(document.querySelector("#one").firstChild, 3);
  range.setEnd(document.querySelector("#two").firstChild, 4);
  normalized = normalizeSelectionRange(map, range);
  assert.equal(text.slice(normalized.start, normalized.end), "st bold ending.Next");
  assert.equal(normalized.range.startOffset, 3);
  assert.equal(normalized.range.endOffset, 4);
  dom.window.close();
});

test("empty and excluded-only ranges do not create targets", { skip }, () => {
  const { dom, document, map } = fixture();
  const range = document.createRange();
  range.selectNodeContents(document.querySelector("script"));
  assert.equal(normalizeSelectionRange(map, range), null);
  range.setStart(document.querySelector("#one").firstChild, 3);
  range.collapse(true);
  assert.equal(normalizeSelectionRange(map, range), null);
  dom.window.close();
});

test("equivalent element and text boundaries have the same normalized range", { skip }, () => {
  const { dom, document, map } = fixture();
  const element = document.querySelector("#one");
  const one = document.createRange();
  one.selectNodeContents(element);
  const two = document.createRange();
  two.setStart(element.firstChild, 0);
  two.setEnd(element.lastChild, element.lastChild.nodeValue.length);
  assert.equal(sameRange(normalizeSelectionRange(map, one).range, normalizeSelectionRange(map, two).range), true);
  two.setStart(element.firstChild, 1);
  assert.equal(sameRange(normalizeSelectionRange(map, one).range, two), false);
  dom.window.close();
});

test("comment approach includes the gap and action but releases outside its bounds", () => {
  const target = { left: 70, top: 90, right: 430, bottom: 144 };
  const action = { left: 436, top: 86, right: 466, bottom: 116, width: 30, height: 30 };
  for (const point of [{ x: 100, y: 100 }, { x: 433, y: 100 }, { x: 451, y: 101 }]) {
    assert.equal(pointInCommentApproach(point, target, action), true);
  }
  assert.equal(pointInCommentApproach({ x: 480, y: 100 }, target, action), false);
  assert.equal(pointInCommentApproach({ x: 440, y: 160 }, target, action), false);
  assert.equal(pointInCommentApproach({ x: 433, y: 100 }, target, { ...action, width: 0 }), false);
});
