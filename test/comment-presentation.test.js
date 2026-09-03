import test from "node:test";
import assert from "node:assert/strict";
import {
  createCommentUi,
  migrateCommentUi,
  mutationIsCurrent,
  ownConfirmation,
  ownEdit,
  ownMenu,
  reconcileCommentUi,
} from "../src/chrome-session.js";

test("one comment owns menu, confirmation, or edit state", () => {
  const ui = createCommentUi();
  ownMenu(ui, "c1", "aligned", "trigger");
  assert.equal(ui.menu.commentId, "c1");
  ownConfirmation(ui, "c1", "aligned");
  assert.equal(ui.menu, null);
  assert.equal(ui.confirmation.status, "idle");
  ownEdit(ui, { id: "c2", feedback: "draft" }, "drawer");
  assert.equal(ui.confirmation, null);
  assert.equal(ui.edit.draft, "draft");
});

test("transient state follows a correction id and clears on acknowledgement", () => {
  const ui = createCommentUi();
  ownEdit(ui, { id: "old", feedback: "draft" }, "aligned");
  ui.edit.draft = "changed";
  migrateCommentUi(ui, "old", "new");
  assert.equal(ui.edit.commentId, "new");
  assert.equal(ui.edit.draft, "changed");
  const removed = reconcileCommentUi(ui, []);
  assert.deepEqual([...removed], ["new"]);
  assert.equal(ui.edit, null);
});

test("only Save or Cancel can release an owned edit", () => {
  const ui = createCommentUi();
  assert.equal(ownEdit(ui, { id: "c1", feedback: "draft" }, "drawer"), true);
  ui.edit.draft = "unsaved";
  assert.equal(ownMenu(ui, "c2", "drawer", "trigger"), false);
  assert.equal(ownConfirmation(ui, "c2", "drawer"), false);
  assert.equal(ownEdit(ui, { id: "c2", feedback: "other" }, "drawer"), false);
  assert.equal(ui.edit.commentId, "c1");
  assert.equal(ui.edit.draft, "unsaved");
});

test("mutation epochs reject stale responses and missing comments", () => {
  const comments = [{ id: "c1" }];
  assert.equal(mutationIsCurrent(4, 4, comments, "c1"), true);
  assert.equal(mutationIsCurrent(4, 5, comments, "c1"), false);
  assert.equal(mutationIsCurrent(4, 4, [], "c1"), false);
});
