import test from "node:test";
import assert from "node:assert/strict";
import { captureSemanticSnapshot, SEMANTIC_SNAPSHOT_SOURCE } from "../lib/semantic-snapshot.js";
import { normalizeSemanticSnapshot } from "../lib/revision-schema.js";
import { compareSemanticSnapshots } from "../lib/revision-diff.js";

let JSDOM;
try { ({ JSDOM } = await import("jsdom")); } catch {}
const skip = JSDOM ? false : "jsdom unavailable on this Node version";
const capture = (html) => {
  const dom = new JSDOM(html, { url: "https://example.test/article", runScripts: "outside-only" });
  try { return captureSemanticSnapshot(dom.window.document); } finally { dom.window.close(); }
};

test("semantic extraction captures live DOM with a self-contained injectable function", { skip }, () => {
  const dom = new JSDOM("<h1>Original</h1>", { runScripts: "outside-only" });
  try {
    dom.window.document.querySelector("h1").textContent = "Live content";
    const injected = dom.window.eval(SEMANTIC_SNAPSHOT_SOURCE);
    const snapshot = injected(dom.window.document);
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.blocks[0].text, "Live content");
    assert.equal(JSON.stringify(snapshot), JSON.stringify(captureSemanticSnapshot(dom.window.document)));
    assert.deepEqual(
      JSON.parse(JSON.stringify(dom.window.eval(`(${captureSemanticSnapshot.toString()})`)(dom.window.document))),
      JSON.parse(JSON.stringify(snapshot)),
    );
  } finally { dom.window.close(); }
});

test("capture excludes SDK artifacts, hidden data, controls and executable content", { skip }, () => {
  const snapshot = capture(`
    <style>.concealed { display:none }</style>
    <h1>Visible</h1>
    <div data-eh-ui><p>SDK controls</p></div>
    <p hidden>hidden password</p><p aria-hidden="true">aria secret</p>
    <p class="concealed">CSS secret</p><p style="opacity:0">transparent secret</p>
    <p inert>inert secret</p><script>executableSecret()</script>
    <template>template secret</template><noscript>noscript secret</noscript>
    <input value="input secret"><input type="password" value="password secret">
    <textarea>textarea secret</textarea><select><option>selected secret</option></select>
    <output>calculated secret</output><button value="button secret">Visible action</button>
    <p data-eh-el="comment-token" onclick="execute()">Hello <mark data-eh-mark="comment">world</mark>.</p>
    <details><summary>Closed details</summary><p>closed secret</p></details>
  `);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /secret|Secret|SDK controls|comment-token|onclick|data-eh/);
  const paragraph = snapshot.blocks.find((block) => block.tag === "p");
  assert.equal(paragraph.text, "Hello world.");
  assert.equal(paragraph.runs.length, 1);
  assert.deepEqual(paragraph.runs[0].marks, []);
  assert.equal(snapshot.blocks.find((block) => block.tag === "button").text, "Visible action");
});

test("visible button labels and types are content, while button values stay private", { skip }, () => {
  const snapshot = capture(`
    <button type="submit" value="private-token">Start <strong>review</strong></button>
    <button type="reset" hidden>Hidden action</button>
    <input type="submit" value="private-input-value">
  `);
  const button = snapshot.blocks.find((block) => block.tag === "button");
  assert.equal(button.text, "Start review");
  assert.deepEqual(button.attributes, { type: "submit" });
  assert.ok(button.runs.find((run) => run.text === "review").marks.includes("strong"));
  assert.doesNotMatch(JSON.stringify(snapshot), /private-token|private-input-value|Hidden action/);
});

test("headings lists tables inline marks links and image references survive", { skip }, () => {
  const snapshot = capture(`
    <section id="intro"><h2>Heading</h2>
    <ol start="3" reversed><li value="5">Item <strong>bold</strong>
      <ul><li><em>Nested</em></li></ul></li></ol>
    <table><caption>Results</caption><thead><tr><th scope="col">Name</th></tr></thead>
    <tbody><tr><td rowspan="2" colspan="3" headers="name">Alice</td></tr></tbody></table>
    <p>See <a href="#note"><em>note</em></a> and <del>old</del><ins>new</ins>.</p>
    <img src="picture.png" alt="A diagram" title="Overview">
    </section>`);
  const heading = snapshot.blocks.find((block) => block.tag === "h2");
  assert.deepEqual(heading.path, ["body", "section#intro"]);
  assert.equal(snapshot.blocks.find((block) => block.tag === "ol").attributes.start, "3");
  assert.equal(snapshot.blocks.find((block) => block.tag === "li").attributes.value, "5");
  const nested = snapshot.blocks.find((block) => block.text === "Nested");
  assert.deepEqual(nested.path.slice(-3), ["ol", "li", "ul"]);
  const cell = snapshot.blocks.find((block) => block.tag === "td");
  assert.deepEqual(cell.attributes, { rowspan: "2", colspan: "3", headers: "name" });
  assert.deepEqual(cell.path.slice(-3), ["table", "tbody", "tr"]);
  const link = snapshot.blocks.find((block) => block.tag === "p").runs.find((run) => run.href);
  assert.deepEqual(link, { text: "note", marks: ["em"], href: "#note" });
  assert.deepEqual(snapshot.blocks.find((block) => block.tag === "img").attributes,
    { src: "picture.png", alt: "A diagram", title: "Overview" });
});

test("code whitespace and line breaks remain meaningful", { skip }, () => {
  const snapshot = capture('<pre><code>  one\n\t two  \n</code></pre><p>A<br>B</p>');
  assert.equal(snapshot.blocks.find((block) => block.tag === "pre").text, "  one\n\t two  \n");
  assert.deepEqual(snapshot.blocks.find((block) => block.tag === "pre").runs[0].marks, ["code"]);
  assert.equal(snapshot.blocks.find((block) => block.tag === "p").text, "A\nB");
  assert.equal(capture("<p><code>  inline  </code></p>").blocks[0].text, "  inline  ");
  assert.equal(capture('<p><span style="white-space:pre">  styled  </span></p>').blocks[0].text, "  styled  ");
});

test("ordinary inline whitespace normalizes across runs and semantic CSS marks survive", { skip }, () => {
  const snapshot = capture('<p>One <strong> two </strong> three <span style="font-style:italic">four</span></p>');
  const paragraph = snapshot.blocks[0];
  assert.equal(paragraph.text, "One two three four");
  assert.ok(paragraph.runs.find((run) => run.text === "two ").marks.includes("strong"));
  assert.ok(paragraph.runs.find((run) => run.text === "four").marks.includes("em"));
});

test("limitations never claim inaccessible DOM or image-byte coverage", { skip }, () => {
  const dom = new JSDOM('<div id="host"></div><iframe></iframe><canvas></canvas><svg><text>graphic</text></svg>');
  try {
    dom.window.document.querySelector("#host").attachShadow({ mode: "open" }).innerHTML = "<p>shadow content</p>";
    const snapshot = captureSemanticSnapshot(dom.window.document);
    for (const limitation of [
      "closed-shadow-roots", "cross-origin-frames", "canvas-content", "same-url-image-bytes",
      "hidden-or-virtualized-content", "embedded-documents", "open-shadow-roots", "non-text-media",
    ]) assert.ok(snapshot.limitations.includes(limitation), limitation);
    assert.doesNotMatch(JSON.stringify(snapshot.blocks), /shadow content|graphic/);
  } finally { dom.window.close(); }
});

test("unsafe inline payloads and URL credentials are omitted", { skip }, () => {
  const snapshot = capture(`
    <p><a href="javascript:alert(1)">script link</a><a href="java&#10;script:alert(1)">obfuscated link</a>
    <a href="https://user:password@example.test/">credential link</a></p>
    <img src="data:image/svg+xml;base64,secret" alt="Inline">
  `);
  assert.doesNotMatch(JSON.stringify(snapshot), /alert\(1\)|user:password|base64,secret/);
  assert.ok(snapshot.limitations.includes("unsafe-or-inline-url"));
  assert.ok(snapshot.limitations.includes("credentialed-url"));
});

test("per-revision selectors address authored elements without mutating the DOM", { skip }, () => {
  const dom = new JSDOM('<div id="x&quot;y"><p>One</p><p>Two</p></div>');
  try {
    const before = dom.window.document.documentElement.outerHTML;
    const snapshot = captureSemanticSnapshot(dom.window.document);
    for (const block of snapshot.blocks) {
      assert.equal(dom.window.document.querySelector(block.selector)?.localName, block.tag);
    }
    assert.equal(dom.window.document.documentElement.outerHTML, before);
  } finally { dom.window.close(); }
});

test("oversized captures fail wholly instead of returning a truncated successful snapshot", { skip }, () => {
  assert.throws(() => capture(`<p>${"x".repeat(100001)}</p>`),
    (error) => error.code === "SEMANTIC_CAPTURE_LIMIT" && error.reason === "block-text");
  assert.throws(() => capture(`${"<div>".repeat(66)}text${"</div>".repeat(66)}`),
    (error) => error.code === "SEMANTIC_CAPTURE_LIMIT" && error.reason === "depth");
  assert.throws(() => capture(`<img alt="${"x".repeat(4097)}">`),
    (error) => error.code === "SEMANTIC_CAPTURE_LIMIT" && error.reason === "attribute");
});

test("capture needs an actual document, not a server HTML string", () => {
  assert.throws(() => captureSemanticSnapshot("<p>Not live</p>"),
    (error) => error.code === "SEMANTIC_CAPTURE_UNAVAILABLE");
});

test("actual extracted descriptors round-trip through backend normalization without semantic loss", { skip }, () => {
  const raw = capture(`
    <article id="article"><h2>Heading</h2><address>Contact address</address>
    <fieldset><p>Safe content</p><input value="private"></fieldset>
    <dialog open><p>Visible dialog</p></dialog>
    <button type="submit" value="private">Start <strong>review</strong></button>
    <p><del>Old</del> <ins>New</ins> <a href="#article"><em>reference</em></a></p>
    <ol start="3"><li value="5">Item</li></ol>
    <table><caption>Results</caption><thead><tr><th scope="col">Header</th></tr></thead>
    <tbody><tr><td colspan="2">Cell</td></tr></tbody></table>
    <pre><code>  keep\n\tspacing  \n</code></pre><img src="picture.png" alt="Diagram">
    </article>
  `);
  const normalized = normalizeSemanticSnapshot(raw);
  const comparison = compareSemanticSnapshots(raw, normalized);
  assert.equal(comparison.status, "complete");
  assert.equal(comparison.counts.total, 0);
  assert.deepEqual(normalized.limitations, raw.limitations);
});
