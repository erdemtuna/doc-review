import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReviewMode, reviewConfiguration, savePolicyForPage } from "../src/review-mode.js";

test("new reviews default to View and source kind composes with save policy", () => {
  assert.equal(normalizeReviewMode(), "view");
  assert.deepEqual(reviewConfiguration({ kind: "file" }, undefined), { mode: "view", savePolicy: "writable" });
  assert.deepEqual(reviewConfiguration({ kind: "file", markdown: true }, "edit"), {
    mode: "edit",
    savePolicy: "feedback-only",
  });
  assert.deepEqual(reviewConfiguration({ kind: "url" }, "edit"), { mode: "edit", savePolicy: "feedback-only" });
  assert.equal(savePolicyForPage({ kind: "file", feedbackOnly: true }), "feedback-only");
});
