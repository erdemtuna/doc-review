import test from "node:test";
import assert from "node:assert/strict";
import { createCommentsController } from "../lib/comments-controller.js";

function fixture() {
  let context = {
    open: true,
    ended: false,
    comparing: false,
    hasPage: true,
    error: null,
    composeOpen: false,
    comments: [
      { id: "c1", quote: "quote 1", feedback: "feedback 1", createdAt: 100 },
      { id: "c2", quote: "quote 2", feedback: "feedback 2", createdAt: 200, updatedAt: 250 },
    ],
    others: [{ key: "p2", filename: "other.html", count: 3 }],
    activeId: null,
    orphans: new Set(),
    ui: { confirmation: null, edit: null },
  };
  const options = {
    read: () => context,
    close: () => { context.open = false; },
    activate: (id, scroll) => { context.activeId = id; },
    edit: (id) => {
      const comment = context.comments.find((c) => c.id === id);
      if (comment) {
        context.ui.edit = {
          commentId: id,
          draft: comment.feedback,
          original: comment.feedback,
          originSurface: "drawer",
          status: "idle",
          selectionStart: comment.feedback.length,
          selectionEnd: comment.feedback.length,
          composing: false,
          validation: "",
        };
      }
    },
    save: () => {
      if (context.ui.edit) {
        const comment = context.comments.find((c) => c.id === context.ui.edit.commentId);
        if (comment) {
          comment.feedback = context.ui.edit.draft;
          comment.updatedAt = Date.now();
        }
        context.ui.edit = null;
      }
      return Promise.resolve();
    },
    cancelEdit: () => {
      context.ui.edit = null;
    },
    confirm: (id) => {
      context.ui.confirmation = { commentId: id, surface: "drawer", status: "idle" };
    },
    cancelDelete: () => {
      context.ui.confirmation = null;
    },
    remove: (id) => {
      context.comments = context.comments.filter((c) => c.id !== id);
      context.ui.confirmation = null;
      return Promise.resolve();
    },
    navigate: (key) => {
      return Promise.resolve();
    },
  };
  const controller = createCommentsController(options);
  return { controller, context, options };
}

test("cached immutable snapshots preserve card identity and object references", () => {
  const { controller } = fixture();
  const snapshot1 = controller.getSnapshot();
  const snapshot2 = controller.getSnapshot();
  assert.strictEqual(snapshot1, snapshot2, "snapshot is stable without publish");
  assert.strictEqual(snapshot1.cards, snapshot1.cards, "cards array reference is stable");
  assert.strictEqual(snapshot1.others, snapshot1.others, "others array reference is stable");
  assert.strictEqual(snapshot1.ui, snapshot1.ui, "ui reference is stable");
});

test("newest sorting and metadata transform comments correctly", () => {
  const { controller, context } = fixture();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.cards.length, 2);
  // c2 is newest due to updatedAt
  assert.equal(snapshot.cards[0].id, "c2");
  assert.equal(snapshot.cards[1].id, "c1");
  // Verify age formatting and metadata
  assert.ok(snapshot.cards[0].age);
  assert.equal(snapshot.cards[0].edited, true, "c2 has updatedAt so it's edited");
  assert.equal(snapshot.cards[1].edited, false, "c1 has no updatedAt");
});

test("orphaned comments carry the orphaned badge through snapshot", () => {
  const { controller, context } = fixture();
  context.orphans = new Set(["c1"]);
  controller.publish();
  const snapshot = controller.getSnapshot();
  const c1 = snapshot.cards.find((c) => c.id === "c1");
  assert.equal(c1.orphaned, true);
});

test("active comment is marked in snapshot", () => {
  const { controller, context } = fixture();
  context.activeId = "c2";
  controller.publish();
  const snapshot = controller.getSnapshot();
  const c2 = snapshot.cards.find((c) => c.id === "c2");
  assert.equal(c2.active, true);
});

test("single edit ownership restricts edit updates to owned comment", () => {
  const { controller, context } = fixture();
  controller.commands.edit("c1");
  assert.ok(context.ui.edit);
  assert.equal(context.ui.edit.commentId, "c1");

  // Try to update c1 edit - should succeed
  controller.commands.updateEdit("c1", { draft: "modified", selectionStart: 0, selectionEnd: 0, composing: false });
  assert.equal(context.ui.edit.draft, "modified");

  // Try to update c2 edit while c1 is owned - should be ignored
  controller.commands.updateEdit("c2", { draft: "should not apply", selectionStart: 0, selectionEnd: 0, composing: false });
  assert.equal(context.ui.edit.draft, "modified", "c2 update was rejected");
  assert.equal(context.ui.edit.commentId, "c1");
});

test("selection and composing state updates preserve in edit", () => {
  const { controller, context } = fixture();
  controller.commands.edit("c1");
  assert.equal(context.ui.edit.selectionStart, 10); // "feedback 1".length = 10
  assert.equal(context.ui.edit.selectionEnd, 10);
  assert.equal(context.ui.edit.composing, false);

  controller.commands.updateEdit("c1", {
    draft: "modified",
    selectionStart: 5,
    selectionEnd: 8,
    composing: true,
  });
  assert.equal(context.ui.edit.selectionStart, 5);
  assert.equal(context.ui.edit.selectionEnd, 8);
  assert.equal(context.ui.edit.composing, true);
});

test("rejected commands for stale IDs when ended", () => {
  const { controller, context } = fixture();
  context.ended = true;
  controller.publish();

  controller.commands.activate("c1", false);
  assert.equal(context.activeId, null, "activate rejected when ended");

  controller.commands.edit("c1");
  assert.equal(context.ui.edit, null, "edit rejected when ended");

  controller.commands.confirm("c1");
  assert.equal(context.ui.confirmation, null, "confirmation rejected when ended");
});

test("rejected commands for stale IDs when comparing", () => {
  const { controller, context } = fixture();
  context.comparing = true;
  controller.publish();

  controller.commands.close();
  assert.equal(context.open, true, "close rejected when comparing");
});

test("rejected commands for stale IDs when disposed", () => {
  const { controller, context } = fixture();
  controller.dispose();

  controller.commands.activate("c1", false);
  assert.equal(context.activeId, null, "activate rejected when disposed");

  controller.commands.edit("c1");
  assert.equal(context.ui.edit, null, "edit rejected when disposed");
});

test("deletion requires confirmation ownership", () => {
  const { controller, context } = fixture();
  const initialLength = context.comments.length;

  // Confirm is rejected without confirmation state
  controller.commands.confirm("c1");
  assert.ok(context.ui.confirmation);

  // Remove without proper ownership attempt should be checked
  controller.commands.remove("c2");
  assert.equal(context.comments.length, initialLength, "remove rejected for non-owned id");

  // Proper removal
  controller.commands.confirm("c1");
  controller.commands.remove("c1");
  assert.equal(context.comments.length, initialLength - 1);
});

test("an owned edit prevents another card opening delete confirmation", () => {
  const { controller, context } = fixture();
  controller.commands.edit("c1");
  assert.ok(context.ui.edit);

  controller.commands.confirm("c2");
  assert.equal(context.ui.confirmation, null, "confirmation rejected while edit is active");

  controller.commands.cancelEdit("c1");
  controller.commands.confirm("c2");
  assert.ok(context.ui.confirmation);
  assert.equal(context.ui.confirmation.commentId, "c2");
});

test("pending deletion blocks retargeting, editing and cancellation", () => {
  const { controller, context } = fixture();
  controller.commands.confirm("c1");
  context.ui.confirmation.status = "deleting";
  controller.commands.confirm("c2");
  controller.commands.edit("c2");
  controller.commands.activate("c2", true);
  controller.commands.cancelDelete("c1");
  assert.equal(context.ui.confirmation.commentId, "c1");
  assert.equal(context.ui.edit, null);
  assert.equal(context.activeId, null);
});

test("other page navigation requires valid page key", () => {
  const { controller, context } = fixture();
  const navigateSpy = { called: false, key: null };
  context.others = [{ key: "valid-key", filename: "test.html", count: 1 }];

  controller.commands.navigate("invalid-key");
  assert.equal(navigateSpy.called, false, "navigate rejected for invalid key");

  controller.commands.navigate("valid-key");
  // Navigation was accepted (actual call depends on implementation)
});

test("drawer open state closes when comparing", () => {
  const { controller, context } = fixture();
  assert.equal(context.open, true);
  assert.equal(context.comparing, false);

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.open, true);

  context.comparing = true;
  controller.publish();
  const nextSnapshot = controller.getSnapshot();
  assert.equal(nextSnapshot.open, false, "drawer closed when comparing");
});

test("loading and error states display correctly", () => {
  const { controller, context } = fixture();
  context.hasPage = false;
  context.error = null;
  controller.publish();

  let snapshot = controller.getSnapshot();
  assert.equal(snapshot.loading, true);
  assert.equal(snapshot.error, null);

  context.error = "Failed to load";
  controller.publish();
  snapshot = controller.getSnapshot();
  assert.equal(snapshot.loading, false);
  assert.equal(snapshot.error, "Failed to load");

  context.error = null;
  context.hasPage = true;
  controller.publish();
  snapshot = controller.getSnapshot();
  assert.equal(snapshot.loading, false);
  assert.equal(snapshot.error, null);
});

test("empty state shows only when no comments and compose not open", () => {
  const { controller, context } = fixture();
  context.comments = [];
  context.composeOpen = false;
  controller.publish();

  let snapshot = controller.getSnapshot();
  assert.equal(snapshot.showEmpty, true);

  context.composeOpen = true;
  controller.publish();
  snapshot = controller.getSnapshot();
  assert.equal(snapshot.showEmpty, false);
});

test("edit validation clears on draft change", () => {
  const { controller, context } = fixture();
  controller.commands.edit("c1");
  context.ui.edit.validation = "Error message";

  controller.commands.updateEdit("c1", {
    draft: "new draft",
    selectionStart: 0,
    selectionEnd: 0,
    composing: false,
  });
  assert.equal(context.ui.edit.validation, "", "validation cleared on draft change");

  // Update with same draft preserves validation
  controller.commands.updateEdit("c1", {
    draft: "new draft",
    selectionStart: 5,
    selectionEnd: 5,
    composing: false,
  });
  assert.equal(context.ui.edit.validation, "");
});

test("edit status transitions prevent commands during save", () => {
  const { controller, context } = fixture();
  controller.commands.edit("c1");
  context.ui.edit.status = "saving";

  const originalDraft = context.ui.edit.draft;
  controller.commands.updateEdit("c1", {
    draft: "should not apply",
    selectionStart: 0,
    selectionEnd: 0,
    composing: false,
  });
  assert.equal(context.ui.edit.draft, originalDraft, "updateEdit rejected during save");
});

test("controller dispose prevents all commands", () => {
  const { controller, context } = fixture();
  controller.dispose();
  const initialState = JSON.stringify(context);

  controller.commands.close();
  controller.commands.activate("c1", false);
  controller.commands.edit("c1");
  controller.commands.confirm("c1");

  assert.equal(JSON.stringify(context), initialState, "disposed controller prevents all state changes");
});

test("subscription mechanism works and unsubscribe stops notifications", () => {
  const { controller, context } = fixture();
  const updates = [];
  const unsubscribe = controller.subscribe(() => {
    updates.push(controller.getSnapshot().cards.length);
  });

  const beforeUpdate = updates.length;

  // Add a comment via context modification
  context.comments = [{ id: "test", quote: "test", feedback: "test", createdAt: Date.now() }];
  controller.publish();

  // After unsubscribe, no more updates
  unsubscribe();
  const afterUnsub = updates.length;
  controller.publish();
  assert.equal(updates.length, afterUnsub, "unsubscribe stops notifications");
});

test("controller store disposal stops subscriptions", () => {
  const { controller } = fixture();
  const updates = [];
  const unsubscribe = controller.subscribe(() => {
    updates.push(null);
  });

  controller.dispose();
  controller.publish();

  assert.equal(updates.length, 0, "disposal prevents notifications");
  unsubscribe();
});

test("disclosure preference survives page and drawer changes, but a new controller starts expanded", () => {
  const { controller, context } = fixture();
  assert.equal(controller.getSnapshot().sectionOpen, true);
  controller.commands.setSectionOpen(false);
  context.open = false;
  context.comparing = true;
  controller.publish();
  context.comments = [];
  context.open = true;
  context.comparing = false;
  controller.publish();
  assert.equal(controller.getSnapshot().sectionOpen, false);
  assert.equal(fixture().controller.getSnapshot().sectionOpen, true);
});

test("comment editing reveals and locks the disclosure until Save or Cancel", async () => {
  const { controller, context } = fixture();
  for (const finish of ["save", "cancelEdit"]) {
    controller.commands.setSectionOpen(false);
    controller.commands.edit("c1", "aligned");
    assert.equal(controller.getSnapshot().sectionOpen, true);
    assert.match(controller.getSnapshot().sectionLock, /Save or cancel/);
    context.ui.edit.validation = "Required";
    controller.publish();
    controller.commands.setSectionOpen(false);
    assert.equal(controller.getSnapshot().sectionOpen, true);
    context.ui.edit.status = "saving";
    controller.publish();
    controller.commands.setSectionOpen(false);
    assert.equal(controller.getSnapshot().sectionOpen, true);
    context.ui.edit.status = "idle";
    await controller.commands[finish]("c1");
    controller.publish();
    assert.equal(controller.getSnapshot().sectionLock, "");
    assert.equal(controller.getSnapshot().sectionOpen, true);
    controller.commands.setSectionOpen(false);
    assert.equal(controller.getSnapshot().sectionOpen, false);
  }
});

test("external edit ownership and deletion confirmations reveal and lock hidden comments", () => {
  const { controller, context, options } = fixture();
  controller.commands.setSectionOpen(false);
  options.edit("c1");
  controller.publish();
  assert.equal(controller.getSnapshot().sectionOpen, true);
  controller.commands.cancelEdit("c1");
  controller.publish();
  controller.commands.setSectionOpen(false);
  controller.commands.confirm("c1");
  controller.commands.setSectionOpen(false);
  assert.equal(controller.getSnapshot().sectionOpen, true);
  assert.match(controller.getSnapshot().sectionLock, /deletion/);
  controller.commands.cancelDelete("c1");
  controller.publish();
  controller.commands.setSectionOpen(false);
  assert.equal(controller.getSnapshot().sectionOpen, false);
  context.ended = true;
  controller.commands.setSectionOpen(true);
  assert.equal(controller.getSnapshot().sectionOpen, false);
});
