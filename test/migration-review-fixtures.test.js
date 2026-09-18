import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { launchBrief, rolloutNotes } from "./fixtures/migration-review.js";
import { injectSdk } from "../src/html-transform.js";
import { serializeDocument } from "../src/serialize.js";

test("seeded HTML stays serialization-stable through SDK bootstrap", () => {
  for (const version of [0, 1, 2]) {
    const source = launchBrief(version);
    const original = new JSDOM(source);
    const injected = new JSDOM(injectSdk(source, "fixture"));
    try {
      assert.equal(serializeDocument(injected.window.document), serializeDocument(original.window.document));
      assert.equal(original.window.document.querySelectorAll("#demo-title").length, 1);
      assert.equal(original.window.document.querySelectorAll('[id^="reference-"]').length, 18);
    } finally {
      original.window.close();
      injected.window.close();
    }
  }
});

test("seeded Markdown provides a real line-ending and EOF example", () => {
  assert.match(rolloutNotes(0), /\r\n/);
  assert.equal(rolloutNotes(0).endsWith("\n"), false);
  assert.doesNotMatch(rolloutNotes(1), /\r/);
  assert.equal(rolloutNotes(1).endsWith("\n"), true);
  assert.notEqual(rolloutNotes(1), rolloutNotes(2));
});
