import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createComparisonView } from "../src/comparison-view.js";
import { compareSemanticSnapshots, compareSources } from "../src/revision-diff.js";
import { readFileSync } from "node:fs";

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

test("shell hosts navigation and headings in one sticky group without rebuilding stable headings", () => {
  const dom = new JSDOM('<section><div class="comparison-header"><nav></nav><div class="comparison-heading-slot"></div></div><article></article></section>');
  const root = dom.window.document.querySelector("article");
  const view = createComparisonView(root);
  const comparison = compareSources("Original\n", "Updated\n");
  view.render(comparison, { mode: "source" });
  const heading = dom.window.document.querySelector(".comparison-headings");
  assert.equal(heading.parentElement.className, "comparison-heading-slot");
  assert.equal(root.querySelector(".comparison-headings"), null);
  view.render({ ...comparison, afterCapturedAt: 123 }, { mode: "source" });
  assert.equal(heading.isConnected, true);
  view.render({ available: false, rows: [], changes: [] });
  assert.equal(heading.isConnected, false);
  assert.equal(dom.window.document.querySelector(".comparison-heading-slot").textContent, "");
});

test("changed rows have non-color labels and unchanged mobile context has a single-version hook", () => {
  const { root } = setup([block("Same"), block("Original")], [block("Same"), block("Updated")]);
  const unchanged = root.querySelector(".comparison-unchanged");
  assert.equal(unchanged.querySelector(".comparison-mobile-label").textContent, "Unchanged · both versions");
  assert.ok(unchanged.querySelector(".comparison-after"));
  const changed = root.querySelector(".comparison-row:not(.comparison-unchanged)");
  assert.equal(changed.querySelector(".comparison-before").getAttribute("aria-label"), "Before · modified");
  assert.equal(changed.querySelector(".comparison-after .comparison-mobile-label").textContent, "After · modified");
  assert.equal(changed.querySelector(".comparison-change-label").textContent, "Modified");
});

test("shell keeps recovery and diagnostics secondary and preserves accessible destinations", () => {
  const dom = new JSDOM(readFileSync(new URL("../src/chrome.html", import.meta.url), "utf8"));
  const document = dom.window.document;
  const byId = (id) => document.getElementById(id);
  assert.equal(byId("latestVersion").textContent, "Review");
  assert.equal(byId("seeChanges").textContent, "Changes");
  assert.equal(byId("seeChanges").getAttribute("aria-controls"), "historyPanel");
  assert.equal(byId("latestVersion").getAttribute("aria-pressed"), "true");
  assert.equal(byId("reviewDetails").querySelector("summary").textContent.trim(), "More ⌄");
  assert.equal(byId("executionStatic").textContent, "Reload without scripts");
  assert.equal(byId("executionAuto").textContent, "Use page interactions");
  assert.equal(byId("executionStatus").closest(".toolbar"), null);
  assert.equal(byId("executionStatus").getAttribute("role"), "status");
  assert.equal(byId("executionStatus").hidden, true);
  assert.equal(byId("documentTrustControls").hidden, true);
  for (const id of ["historyCurrentStatus", "historyViewCoverage", "historyUnavailable", "historyTiming", "historyCaptureDelay", "historyLimitations", "finishCapture", "finishCaptureHelp"]) {
    assert.equal(byId(id).closest("details#historyDiagnostics"), byId("historyDiagnostics"), id);
  }
  assert.equal(byId("historyViewCoverage").hasAttribute("role"), false);
  assert.equal(byId("captureResult").closest("details"), null);
  assert.equal(byId("changeNavigation").parentElement.className, "comparison-header");
  assert.ok(byId("drawer").querySelector("#commentsSection"));
});
