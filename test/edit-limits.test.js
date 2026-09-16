import assert from "node:assert/strict";
import test from "node:test";
import { limitEditFields, MAX_EDIT_CHARACTERS } from "../src/edit-limits.js";

test("edit fields preserve 6k and exact-limit text and report larger values", () => {
  for (const length of [6000, MAX_EDIT_CHARACTERS, MAX_EDIT_CHARACTERS + 1, 250000]) {
    const text = "x".repeat(length);
    const result = limitEditFields({ before: text, after: text, before_html: text, after_html: text });
    for (const field of ["before", "after", "before_html", "after_html"]) {
      assert.equal(result.fields[field], text.slice(0, MAX_EDIT_CHARACTERS));
    }
    assert.equal(result.truncated, length > MAX_EDIT_CHARACTERS);
    assert.deepEqual(result.truncated_fields, length > MAX_EDIT_CHARACTERS
      ? ["before", "after", "before_html", "after_html"] : []);
  }
});

test("limits count Unicode code points without splitting surrogate pairs", () => {
  const emoji = "\u{1F600}";
  const exact = "x".repeat(MAX_EDIT_CHARACTERS - 1) + emoji;
  assert.deepEqual(limitEditFields({ after: exact }).fields, { after: exact });
  assert.equal(limitEditFields({ after: exact }).truncated, false);
  const cut = limitEditFields({ after: exact + "y", moved_after: emoji.repeat(MAX_EDIT_CHARACTERS + 1) });
  assert.equal(cut.fields.after, exact);
  assert.equal(cut.fields.moved_after, emoji.repeat(MAX_EDIT_CHARACTERS));
  assert.deepEqual(cut.truncated_fields, ["after", "moved_after"]);
});

test("missing fields stay missing and empty fields are not truncated", () => {
  assert.deepEqual(limitEditFields({ before: null, after: "" }), {
    fields: { after: "" }, truncated: false, truncated_fields: [],
  });
});
