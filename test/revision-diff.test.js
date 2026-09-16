import test from "node:test";
import assert from "node:assert/strict";
import { compareSemanticSnapshots, compareSources, DIFF_LIMITS } from "../src/revision-diff.js";

const block = (text, options = {}) => ({
  id: "b1", tag: "p", selector: "body > p:nth-of-type(1)", text,
  attributes: {}, runs: text ? [{ text, marks: [] }] : [], path: ["body"],
  ...options,
});
const snapshot = (blocks, limitations = []) => ({
  version: 1, blocks: blocks.map((item, i) => ({ ...item, id: `b${i + 1}` })), limitations,
});
const compare = (before, after, options) =>
  compareSemanticSnapshots(snapshot(before), snapshot(after), options);

test("unchanged snapshots produce complete zero counts; missing snapshots are unavailable", () => {
  const same = snapshot([block("same")]);
  assert.deepEqual(compareSemanticSnapshots(same, same).counts, { added: 0, modified: 0, removed: 0, total: 0 });
  assert.equal(compareSemanticSnapshots(null, same).status, "unavailable");
  assert.equal(compareSemanticSnapshots(null, same).counts, null);
});

test("authored IDs match changed text and word segments reconstruct both endpoints", () => {
  const before = [block("The old text", { attributes: { id: "intro" } })];
  const after = [block("The new text", { attributes: { id: "intro" } })];
  const output = compare(before, after);
  assert.equal(output.status, "complete");
  assert.equal(output.counts.modified, 1);
  const change = output.changes[0];
  assert.equal(change.confidence, "exact");
  assert.equal(change.evidence, "authored-id");
  assert.deepEqual(change.navigation, { selector: after[0].selector, blockId: "b1" });
  assert.equal(change.segments.filter((part) => !part.added).map((part) => part.value).join(""), change.before);
  assert.equal(change.segments.filter((part) => !part.removed).map((part) => part.value).join(""), change.after);
  assert.deepEqual(compare(before, after), output, "change IDs are deterministic");
});

test("local block IDs and positional selectors are never global matching evidence", () => {
  const output = compare([block("before")], [block("after")]);
  assert.equal(output.changes[0].confidence, "context");
  assert.equal(output.changes[0].navigation, null);
});

test("different authored identities override coincidentally equal text", () => {
  const output = compare([block("same", { attributes: { id: "old" } })],
    [block("same", { attributes: { id: "new" } })]);
  assert.equal(output.counts.removed, 1);
  assert.equal(output.counts.added, 1);
  assert.ok(output.changes.every((change) => change.navigation === null));
});

test("additions removals and deleted excerpts remain available", () => {
  const output = compare([block("keep"), block("deleted")], [block("keep"), block("new one"), block("new two")]);
  assert.equal(output.counts.removed, 1);
  assert.equal(output.counts.added, 2);
  const removed = output.changes.find((change) => change.kind === "removed");
  assert.equal(removed.before, "deleted");
  assert.equal(removed.afterBlock, null);
  assert.equal(removed.navigation, null);
});

test("moved blocks are visible but cannot claim exact navigation", () => {
  const output = compare([block("A"), block("B"), block("C")], [block("C"), block("A"), block("B")]);
  assert.ok(output.changes.length > 0);
  for (const change of output.changes) {
    assert.ok(change.fields.includes("order"));
    assert.equal(change.confidence, "ambiguous");
    assert.equal(change.navigation, null);
  }
});

test("moving into another hierarchy cannot claim exact navigation even without reordering", () => {
  const output = compare([block("same", { path: ["body", "section#old"] })],
    [block("same", { path: ["body", "section#new"] })]);
  assert.equal(output.changes[0].confidence, "ambiguous");
  assert.equal(output.changes[0].navigation, null);
});

test("inserted siblings do not turn unchanged unique blocks into moves", () => {
  const output = compare([block("A"), block("B")], [block("new"), block("A"), block("B")]);
  assert.deepEqual(output.counts, { added: 1, removed: 0, modified: 0, total: 1 });
});

test("repeated text and duplicate authored IDs cannot invent exact navigation", () => {
  const before = [block("same", { attributes: { id: "duplicate" } }), block("same", { attributes: { id: "duplicate" } })];
  const after = [before[0], block("changed", { attributes: { id: "duplicate" } })];
  const output = compare(before, after);
  assert.ok(output.changes.length > 0);
  for (const change of output.changes) assert.equal(change.navigation, null);
});

test("formatting, heading level, hierarchy, references and code whitespace are meaningful", () => {
  const pairs = [
    [block("title", { tag: "h1" }), block("title", { tag: "h2" }), "structure"],
    [block("item", { path: ["body", "ul", "li"] }), block("item", { path: ["body", "ol", "li"] }), "structure"],
    [block("cell", { tag: "td", attributes: { colspan: "1" } }),
      block("cell", { tag: "td", attributes: { colspan: "2" } }), "attributes"],
    [block("bold"), block("bold", { runs: [{ text: "bold", marks: ["strong"] }] }), "runs"],
    [block("link", { runs: [{ text: "link", marks: [], href: "/old" }] }),
      block("link", { runs: [{ text: "link", marks: [], href: "/new" }] }), "runs"],
    [block("", { tag: "img", attributes: { src: "old.png", alt: "Before" } }),
      block("", { tag: "img", attributes: { src: "new.png", alt: "After" } }), "attributes"],
    [block("  code\n", { tag: "pre" }), block("\tcode\n", { tag: "pre" }), "text"],
  ];
  for (const [before, after, field] of pairs) {
    const output = compare([before], [after]);
    assert.equal(output.status, "complete");
    assert.equal(output.counts.modified, 1);
    assert.ok(output.changes[0].fields.includes(field));
  }
});

test("attributes compare canonically regardless of key insertion order", () => {
  const output = compare(
    [block("", { tag: "img", attributes: { src: "a", alt: "b" } })],
    [block("", { tag: "img", attributes: { alt: "b", src: "a" } })],
  );
  assert.equal(output.counts.total, 0);
});

test("button CTA text and action type changes compare without capturing form values", () => {
  const output = compare(
    [block("Start", { tag: "button", attributes: { id: "cta", type: "button" } })],
    [block("Submit", { tag: "button", attributes: { id: "cta", type: "submit" } })],
  );
  assert.equal(output.status, "complete");
  assert.equal(output.counts.modified, 1);
  assert.ok(output.changes[0].fields.includes("text"));
  assert.ok(output.changes[0].fields.includes("attributes"));
  assert.equal(compare([block("Start", { tag: "button", attributes: { value: "private" } })], []).status, "unavailable");
});

test("semantic comparison retains explicit capture limitations", () => {
  const before = snapshot([], ["same-url-image-bytes", "canvas-content"]);
  const after = snapshot([], ["same-url-image-bytes", "closed-shadow-roots"]);
  assert.deepEqual(compareSemanticSnapshots(before, after).limitations,
    ["canvas-content", "closed-shadow-roots", "same-url-image-bytes"]);
});

test("source comparison retains exact whitespace newlines and line references", () => {
  const output = compareSources("first\r\n  old\r\nlast", "first\r\n\tnew\r\nlast");
  assert.equal(output.status, "complete");
  assert.equal(output.counts.modified, 1);
  const change = output.changes[0];
  assert.equal(change.before, "  old\r\n");
  assert.equal(change.after, "\tnew\r\n");
  assert.equal(change.beforeBlock.startLine, 2);
  assert.equal(change.afterBlock.endLine, 2);
  assert.equal(change.navigation, null);
  assert.ok(compareSources("text", "text\n").counts.total > 0);
});

test("source insertion deletion and literal historical HTML are inert data", () => {
  const source = '<script>alert("historical")</script>\n';
  assert.equal(compareSources("", source).changes[0].kind, "added");
  assert.equal(compareSources(source, "").changes[0].kind, "removed");
  assert.equal(compareSources("", source).changes[0].after, source);
  assert.equal(compareSources(null, source).status, "unavailable");
  assert.equal(compareSources("", "").counts.total, 0);
});

test("every budget failure discards partial changes and reports explicit limited state", () => {
  const failures = [
    compare([block("one"), block("two")], [], { maxBlocks: 1 }),
    compare([block("one")], [block("two")], { maxBlockCharacters: 2 }),
    compare([block("one"), block("two")], [], { maxChanges: 1 }),
    compareSources("12345", "", { maxCharacters: 4 }),
    compareSources("a\nb\nc\n", "", { maxTokens: 2 }),
    compareSources("a\nb\nc\n", "d\ne\nf\n", { maxEditLength: 1 }),
    compareSources("one two three", "four five six", { maxTokens: 2 }),
  ];
  for (const output of failures) {
    assert.equal(output.status, "limited", JSON.stringify(output));
    assert.equal(output.counts, null);
    assert.deepEqual(output.changes, []);
    assert.match(output.limitations[0], /^comparison-limit:/);
  }
  assert.equal(compareSources("", "", { maxCharacters: -1 }).status, "unavailable");
  assert.equal(compareSources("", "", { maxCharacters: 999999999 }).limits.maxCharacters, DIFF_LIMITS.maxCharacters);
});

test("invalid schema cannot smuggle arbitrary attributes or inconsistent run text", () => {
  for (const item of [
    block("text", { attributes: { onclick: "execute()" } }),
    block("text", { runs: [{ text: "different", marks: [] }] }),
    block("text", { attributes: { value: "form value" } }),
  ]) {
    assert.equal(compare([item], []).status, "unavailable");
  }
});

test("representative long documents compare within configured budgets", () => {
  const before = Array.from({ length: 500 }, (_, i) => block(`Paragraph ${i}: ` + "readable words ".repeat(8), {
    attributes: { id: `p-${i}` },
  }));
  const after = before.map((item, i) => i === 250
    ? block(`${item.text}changed`, { attributes: item.attributes }) : item);
  const started = performance.now();
  const output = compare(before, after);
  assert.equal(output.status, "complete");
  assert.equal(output.counts.modified, 1);
  assert.ok(performance.now() - started < 1500);
});

test("alignment includes every block exactly once per side in monotonically increasing order", () => {
  const old = [block("A"), block("B"), block("C"), block("D")];
  const next = [block("new"), block("C"), block("A"), block("changed"), block("D")];
  const output = compare(old, next);
  assert.equal(output.version, 2);
  assert.equal(output.status, "complete");
  assert.deepEqual(output.rows.filter((row) => row.beforeIndex !== null).map((row) => row.beforeIndex), [0, 1, 2, 3]);
  assert.deepEqual(output.rows.filter((row) => row.afterIndex !== null).map((row) => row.afterIndex), [0, 1, 2, 3, 4]);
  assert.deepEqual(output.rows.filter((row) => row.beforeBlock).map((row) => row.beforeBlock.text), old.map((item) => item.text));
  assert.deepEqual(output.rows.filter((row) => row.afterBlock).map((row) => row.afterBlock.text), next.map((item) => item.text));
  for (const row of output.rows.filter((row) => row.moveId)) {
    assert.ok(row.beforeBlock === null || row.afterBlock === null);
    assert.equal(output.rows.filter((other) => other.moveId === row.moveId).length, 2);
  }
  assert.equal(new Set(output.rows.filter((row) => row.changeId).map((row) => row.changeId)).size, output.counts.total);
});

test("unchanged context hunks are stable and never replace counted changes", () => {
  const output = compare([block("one"), block("two"), block("three")],
    [block("one"), block("changed"), block("three")]);
  assert.deepEqual(output.rows.map((row) => row.kind), ["unchanged", "modified", "unchanged"]);
  assert.deepEqual(output.hunks.map(({ kind, start, count }) => ({ kind, start, count })), [
    { kind: "context", start: 0, count: 1 }, { kind: "changes", start: 1, count: 1 }, { kind: "context", start: 2, count: 1 },
  ]);
  assert.equal(output.counts.total, 1);
});

test("source alignment preserves exact endpoints, actual line numbers and final newline facts", () => {
  const before = "same\r\nremoved\r\nlast";
  const after = "same\r\nnew\r\nextra\r\nlast\n";
  const output = compareSources(before, after);
  for (const [side, source] of [["before", before], ["after", after]]) {
    const blocks = output.rows.map((row) => row[`${side}Block`]).filter(Boolean);
    assert.equal(blocks.map((item) => item.text).join(""), source);
    assert.deepEqual(blocks.map((item) => item.startLine), blocks.map((_, index) => index + 1));
    for (const row of output.rows.filter((row) => row.changeId)) {
      const text = row.segments.filter((part) => side === "before" ? !part.added : !part.removed).map((part) => part.value).join("");
      assert.equal(text, row[`${side}Block`]?.text || "");
    }
  }
  assert.deepEqual(output.endOfFile, {
    before: { empty: false, newline: false }, after: { empty: false, newline: true },
  });
});

test("alignment and response budgets fail explicitly without exposing partial rows", () => {
  for (const output of [
    compareSources("a\nb\n", "a\nb\n", { maxRows: 1 }),
    compare([block("one")], [block("two")], { maxResponseCharacters: 20 }),
  ]) {
    assert.equal(output.status, "limited");
    assert.equal(output.counts, null);
    assert.deepEqual(output.rows, []);
    assert.deepEqual(output.hunks, []);
  }
});
