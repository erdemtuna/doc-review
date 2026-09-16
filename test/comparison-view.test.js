import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createComparisonView } from "../src/comparison-view.js";
import { compareSemanticSnapshots, compareSources } from "../src/revision-diff.js";

const block = (text, tag = "p", extra = {}) => ({
  id: "b1", tag, text, path: ["body"], selector: "body > p:nth-of-type(1)",
  attributes: {}, runs: text ? [{ text, marks: [] }] : [], ...extra,
});
const snapshot = (blocks) => ({ version: 1, limitations: [], blocks: blocks.map((item, index) => ({ ...item, id: `b${index}` })) });
function setup(before, after) {
  const dom = new JSDOM("<article></article>");
  const root = dom.window.document.querySelector("article");
  const view = createComparisonView(root);
  const comparison = compareSemanticSnapshots(snapshot(before), snapshot(after));
  assert.equal(comparison.status, "complete");
  view.render(comparison);
  return { root, view, comparison };
}

test("readable headings and inline formatting preserve word-diff character boundaries", () => {
  const before = block("A bold old phrase", "h2", { runs: [
    { text: "A ", marks: [] }, { text: "bold old", marks: ["strong"] }, { text: " phrase", marks: ["em"] },
  ] });
  const after = block("A bold new phrase", "h2", { runs: [
    { text: "A ", marks: [] }, { text: "bold new", marks: ["strong"] }, { text: " phrase", marks: ["em"] },
  ] });
  const { root } = setup([before], [after]);
  assert.equal(root.querySelector(".comparison-before h2").textContent, before.text);
  assert.equal(root.querySelector(".comparison-after h2").textContent, after.text);
  assert.equal(root.querySelector("del strong").textContent, "old");
  assert.equal(root.querySelector("ins strong").textContent, "new");
  assert.equal(root.querySelector(".comparison-after em").textContent, " phrase");
});

test("historical URLs, markup and control names stay inert; metadata is readable", () => {
  const { root } = setup([
    block("link", "button", { runs: [{ text: "link", marks: [], href: "/old" }] }),
    block("", "img", { attributes: { src: "/old.png", alt: "Before image" } }),
    block("<script>window.bad=true</script>", "script"),
  ], [
    block("link", "button", { runs: [{ text: "link", marks: [], href: "javascript:evil()" }] }),
    block("", "img", { attributes: { src: "https://invalid.example/new.png", alt: "After image" } }),
    block("<script>window.bad=false</script>", "script", { runs: [{ text: "<script>window.bad=false</script>", marks: ["constructor", "__proto__"] }] }),
  ]);
  assert.equal(root.querySelectorAll("script, style, img, iframe, a, input").length, 0);
  assert.equal(root.querySelectorAll("button:not(.comparison-expand)").length, 0);
  assert.match(root.textContent, /Link destination: \/old/);
  assert.match(root.textContent, /Image not loaded/);
  assert.match(root.textContent, /<script>window.bad=false<\/script>/);
  assert.equal(root.querySelectorAll("[src], [href], [onclick]").length, 0);
});

test("context expansion retains every change and unrelated render preserves DOM identity", () => {
  const before = Array.from({ length: 45 }, (_, index) => block(`Paragraph ${index}`, "p", { attributes: { id: `p${index}` } }));
  const after = before.map((item, index) => index === 20 ? { ...item, text: "Changed", runs: [{ text: "Changed", marks: [] }] } : item);
  const { root, view, comparison } = setup(before, after);
  assert.equal(root.querySelectorAll(".comparison-row").length, 5);
  const first = root.querySelector(".comparison-row");
  const expand = root.querySelector(".comparison-expand");
  expand.click();
  assert.ok(root.textContent.includes("Paragraph 0"));
  view.render({ ...comparison, afterCapturedAt: 123 });
  assert.equal(first.isConnected, true);
  assert.equal(root.querySelectorAll(".comparison-row").length, 23);
  view.select(0);
  assert.equal(root.querySelectorAll(".comparison-current").length, 1);
  assert.equal(first.isConnected, true);
});

test("ordered lists and unambiguous table rows use readable structure, ambiguous cells are labelled", () => {
  const before = [
    block("", "ol", { selector: "body > ol:nth-of-type(1)", attributes: { start: "4" } }),
    block("Fourth", "li", { selector: "body > ol:nth-of-type(1) > li:nth-of-type(1)", path: ["body", "ol"] }),
    block("Fifth", "li", { selector: "body > ol:nth-of-type(1) > li:nth-of-type(2)", path: ["body", "ol"] }),
    block("Name", "th", { selector: "body > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(1) > th:nth-of-type(1)" }),
    block("Value", "th", { selector: "body > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(1) > th:nth-of-type(2)" }),
    block("Mystery", "td"),
  ];
  const { root } = setup(before, before.map((item) => ({ ...item, text: `${item.text}!`, runs: [{ text: `${item.text}!`, marks: [] }] })));
  assert.equal(root.querySelector(".comparison-before ol").start, 4);
  assert.equal(root.querySelectorAll(".comparison-before ol")[1].start, 5);
  assert.equal(root.querySelector(".comparison-before table tr").children.length, 2);
  assert.match(root.textContent, /Table cell · row structure unavailable/);
});

test("source lines retain gaps, line numbers, literal HTML and EOF labels", () => {
  const dom = new JSDOM("<article></article>");
  const root = dom.window.document.querySelector("article");
  const view = createComparisonView(root);
  view.render(compareSources("same\n", "same\n<script>inert</script>"), { mode: "source" });
  assert.equal(root.querySelectorAll(".comparison-row").length, 2);
  assert.equal(root.querySelectorAll(".comparison-gap").length, 1);
  assert.equal(root.querySelector("script"), null);
  assert.match(root.querySelector(".comparison-row:last-child .comparison-after .comparison-gutter").textContent, /2 \+/);
  assert.match(root.textContent, /No newline at end of file/);
});

test("saved reversed and zero-start ordered lists retain their actual numbering", () => {
  for (const [attributes, expected] of [[{ reversed: "" }, [2, 1]], [{ start: "0" }, [0, 1]]]) {
    const before = [
      block("", "ol", { selector: "body > ol:nth-of-type(1)", attributes }),
      block("One", "li", { selector: "body > ol:nth-of-type(1) > li:nth-of-type(1)", path: ["body", "ol"] }),
      block("Two", "li", { selector: "body > ol:nth-of-type(1) > li:nth-of-type(2)", path: ["body", "ol"] }),
    ];
    const { root } = setup(before, before);
    assert.deepEqual([...root.querySelectorAll(".comparison-before ol")].map((list) => list.start), expected);
  }
});

test("source CRLF-only edits are visible as line-ending diagnostics", () => {
  const dom = new JSDOM("<article></article>");
  const root = dom.window.document.querySelector("article");
  createComparisonView(root).render(compareSources("same\r\n", "same\n"), { mode: "source" });
  assert.match(root.querySelector(".comparison-before").textContent, /Line ending: CRLF/);
  assert.match(root.querySelector(".comparison-after").textContent, /Line ending: LF/);
});
