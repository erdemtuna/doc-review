import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSemanticSnapshot, normalizeCaptureProvenance, normalizeHistoryTargets, normalizeRevisionLimits, REVISION_LIMITS } from "../src/revision-schema.js";

const block = (extra = {}) => ({ id: "p1", tag: "p", text: "Readable text", path: "main > p", ...extra });

test("semantic snapshots preserve code whitespace, structure and reference attributes", () => {
  const snapshot = normalizeSemanticSnapshot({
    version: 1,
    blocks: [
      block({ id: "pre", tag: "pre", text: "  first\n\n second" }),
      block({ parentId: "pre", tag: "a", attrs: { title: "Docs", href: "/docs" } }),
    ],
    viewport: { width: 900 },
  });
  assert.equal(snapshot.blocks[0].text, "  first\n\n second");
  assert.equal(snapshot.blocks[1].parentId, "pre");
  assert.deepEqual(snapshot.blocks[1].attributes, { href: "/docs", title: "Docs" });
  assert.equal(snapshot.viewport, undefined);
});

test("semantic schemas reject executable HTML, form content, cycles and duplicate IDs", () => {
  for (const invalid of [
    block({ html: "<script>bad()</script>" }),
    block({ tag: "script" }),
    block({ tag: "input" }),
    block({ attrs: { onclick: "bad()" } }),
    block({ attrs: { value: "password" } }),
    block({ attrs: { href: "javascript:bad()" } }),
    block({ attrs: { href: "java\nscript:bad()" } }),
    block({ attrs: { src: "blob:https://example.com/id" } }),
    block({ attrs: { href: "https://user:password@example.com/private" } }),
    block({ parentId: "p1" }),
    block({ parentId: "missing" }),
  ]) assert.throws(() => normalizeSemanticSnapshot({ version: 1, blocks: [invalid] }));
  assert.throws(() => normalizeSemanticSnapshot({ version: 1, blocks: [block(), block()] }), /Duplicate/);
});

test("resource configuration cannot disable limits with NaN, negative or unknown values", () => {
  for (const limits of [{ sourceBytes: NaN }, { totalBytes: -1 }, { textCharacters: Infinity }, { wrongName: 20 }]) {
    assert.throws(() => normalizeRevisionLimits(limits), /Invalid snapshot limit/);
  }
});

test("semantic size limits fail explicitly rather than publishing truncated snapshots", () => {
  assert.throws(() => normalizeSemanticSnapshot({ version: 1, blocks: [block()] }, {
    ...REVISION_LIMITS, semanticBytes: 10,
  }), (err) => err.code === "SNAPSHOT_TOO_LARGE");
  assert.throws(() => normalizeSemanticSnapshot({ version: 1, blocks: [block()] }, {
    ...REVISION_LIMITS, blocks: 0,
  }), (err) => err.code === "SNAPSHOT_TOO_LARGE");
});

test("capture provenance omits credentials, capabilities and presentation data", () => {
  assert.deepEqual(normalizeCaptureProvenance({
    sessionId: "s_1", generation: 2, pageKey: "page", capability: "secret",
    cookie: "secret", localStorage: { token: "secret" }, rects: [], feedbackOnlyEdits: true,
  }), { sessionId: "s_1", pageKey: "page", generation: 2, feedbackOnlyEdits: true });
});

test("history targets require explicit missing-baseline consent and distinct documents", () => {
  assert.deepEqual(normalizeHistoryTargets([{ key: "a", baselineUnavailable: "inactive_page" }]), [
    { key: "a", baselineUnavailable: "inactive_page" },
  ]);
  assert.throws(() => normalizeHistoryTargets([{ key: "a" }]), /explicit unavailable/);
  assert.throws(() => normalizeHistoryTargets([
    { key: "a", baselineUnavailable: "inactive" }, { key: "a", baselineUnavailable: "inactive" },
  ]), /Duplicate/);
});

test("rich semantic snapshots preserve paths, selectors, runs, table/list attributes and limitations", () => {
  const snapshot = normalizeSemanticSnapshot({
    version: 1,
    blocks: [{
      id: "b1", tag: "li", text: "Read docs", selector: "#guide li",
      path: ["main", "ol", "li"], attributes: { value: "3", id: "step" },
      runs: [{ text: "Read ", marks: [] }, { text: "docs", marks: ["strong"], href: "/guide" }],
    }],
    limitations: ["closed-shadow-roots", "same-url-image-bytes"],
  });
  assert.deepEqual(snapshot.blocks[0].path, ["main", "ol", "li"]);
  assert.equal(snapshot.blocks[0].attributes.value, "3");
  assert.equal(snapshot.blocks[0].runs[1].href, "/guide");
  assert.deepEqual(snapshot.blocks[0].runs[1].marks, ["strong"]);
  assert.deepEqual(snapshot.limitations, ["closed-shadow-roots", "same-url-image-bytes"]);
  assert.throws(() => normalizeSemanticSnapshot({
    version: 1, blocks: [{ ...snapshot.blocks[0], tag: "p" }],
  }), /Unsupported semantic attribute/);
  assert.throws(() => normalizeSemanticSnapshot({
    version: 1, blocks: [{ ...snapshot.blocks[0], text: "Different text" }],
  }), /do not match/);
});

test("the live extractor's semantic output survives shared validation", async (t) => {
  let JSDOM;
  try {
    ({ JSDOM } = await import("jsdom"));
  } catch {
    t.skip("jsdom unavailable on this Node version");
    return;
  }
  const { captureSemanticSnapshot } = await import("../src/semantic-snapshot.js");
  const dom = new JSDOM('<body><address>Office</address><fieldset><p><del>Before</del> <ins>After</ins></p>' +
    '<button type="button">Action</button><ol><li value="3"><a href="/docs">Docs</a></li></ol></fieldset></body>',
  { url: "http://localhost:3000/review" });
  try {
    const captured = captureSemanticSnapshot(dom.window.document);
    const snapshot = normalizeSemanticSnapshot(captured);
    assert.deepEqual(snapshot, captured);
    assert.ok(snapshot.blocks.some((block) => block.tag === "address"));
    assert.ok(snapshot.blocks.some((block) => block.attributes?.type === "button"));
    assert.ok(snapshot.blocks.some((block) => block.runs?.some((run) => run.marks.includes("delete"))));
    assert.ok(snapshot.blocks.some((block) => block.runs?.some((run) => run.marks.includes("insert"))));
  } finally {
    dom.window.close();
  }
});

test("legacy minimal input normalizes to complete canonical descriptors", () => {
  const snapshot = normalizeSemanticSnapshot({ version: 1, blocks: [block()] });
  assert.deepEqual(snapshot.blocks[0].path, ["main > p"]);
  assert.equal(snapshot.blocks[0].selector, "");
  assert.deepEqual(snapshot.blocks[0].attributes, {});
  assert.deepEqual(snapshot.blocks[0].runs, [{ text: "Readable text", marks: [] }]);
  assert.deepEqual(snapshot.limitations, []);
});
