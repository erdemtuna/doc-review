import test from "node:test";
import assert from "node:assert/strict";
import { createFeedbackPanelController, createNoteDraft } from "../lib/feedback-panel-controller.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides = {}) {
  const calls = [];
  const context = {
    note: createNoteDraft(), ended: false, available: true, identity: "page-render-1", source: "hash",
    edits: [{ label: "paragraph", kind: "edited" }], total: 1, drafts: 0,
    agent: "idle", prompt: "Poll this review", filename: "file.html", kind: "file", markdown: false,
    save: { status: "saved", savedAt: "", conflict: false, dirty: false, dynamic: false, baseHash: "hash" },
    delivery: { phase: "idle", sending: false, sent: false },
  };
  const controller = createFeedbackPanelController({
    read: () => context,
    send: async (settings) => { calls.push(["send", settings]); },
    flush: async (action) => { calls.push(["flush", action]); },
    revert: async () => { calls.push("revert"); },
    end: async () => { calls.push("end"); },
    copy: async (text) => { calls.push(["copy", text]); },
    failed: (message) => { calls.push(["failed", message]); },
    ...overrides,
  });
  return { controller, context, calls };
}

test("note is session-owned with immutable snapshots, selection and composition", async () => {
  const { controller, context, calls } = fixture();
  context.edits = []; context.total = 0; controller.publish();
  assert.equal(controller.getSnapshot().sendDisabled, true);
  const first = controller.getSnapshot();
  controller.commands.updateNote({ text: "note only", selectionStart: 2, selectionEnd: 5, composing: true });
  assert.equal(context.note.text, "note only");
  assert.equal(first.note.text, "");
  assert.equal(controller.getSnapshot().sendDisabled, true);
  controller.commands.updateNote({ ...context.note, composing: false });
  assert.equal(controller.getSnapshot().sendText, "Send note to agent");
  await controller.commands.send();
  assert.equal(calls.length, 1);
  assert.deepEqual(controller.getSnapshot().note, context.note);
});

for (const action of ["end", "revert"]) {
  test(`${action} defaults to a cancellable dialog and revalidates stale context`, async () => {
    const { controller, context, calls } = fixture();
    controller.commands.open(action);
    controller.commands.cancel();
    assert.equal(controller.getSnapshot().dialog, null);
    controller.commands.open(action);
    context.source = "external"; controller.publish();
    assert.equal(controller.getSnapshot().dialog.stale, true);
    await controller.commands.confirm();
    assert.equal(calls.length, 0);
    assert.match(controller.getSnapshot().dialog.error, /changed/);
  });

  test(`${action} flushes first, coalesces clicks, refuses Escape/cancel while pending`, async () => {
    const flush = deferred();
    const purposes = [];
    const { controller, calls } = fixture({ flush: (purpose) => { purposes.push(purpose); return flush.promise; } });
    controller.commands.open(action);
    const flight = controller.commands.confirm();
    controller.commands.cancel();
    await controller.commands.confirm();
    assert.equal(controller.getSnapshot().dialog.pending, true);
    assert.equal(calls.length, 0);
    assert.deepEqual(purposes, [action]);
    flush.resolve();
    await flight;
    assert.deepEqual(calls, [action]);
    assert.equal(controller.getSnapshot().dialog, null);
  });

  test(`${action} cannot bypass a failed preparation and keeps its confirmation retryable`, async () => {
    const { controller, calls } = fixture({ flush: async () => { throw new Error("Preparation failed"); } });
    controller.commands.open(action);
    await controller.commands.confirm();
    assert.deepEqual(calls, [["failed", "Preparation failed"]]);
    assert.equal(controller.getSnapshot().dialog.pending, false);
    assert.equal(controller.getSnapshot().dialog.error, "Preparation failed");
  });

  test(`${action} refuses stale completion after flush and allows retry of an explicit failure`, async () => {
    const flush = deferred();
    const { controller, context, calls } = fixture({ flush: () => flush.promise });
    controller.commands.open(action);
    const flight = controller.commands.confirm();
    context.identity = "new-render"; controller.publish();
    flush.resolve(); await flight;
    assert.equal(calls.some((call) => call === action), false);
    assert.match(controller.getSnapshot().dialog.error, /page changed/);
    controller.commands.cancel();
    controller.commands.open(action);
    await controller.commands.confirm();
    assert.equal(calls.at(-1), action);
  });
}

test("End describes unsent persisted items separately from tab-only drafts", () => {
  const { controller, context } = fixture();
  context.note.text = "not persisted";
  context.drafts = 1;
  controller.commands.open("end");
  assert.match(controller.getSnapshot().dialog.description, /1 unsent item will be kept/);
  assert.match(controller.getSnapshot().dialog.description, /2 open drafts.*only in this tab/);
});

test("send and destructive actions remain blocked during delivery and shutdown", async () => {
  const { controller, context, calls } = fixture();
  context.delivery.sending = true; controller.publish();
  controller.commands.open("end");
  await controller.commands.send();
  assert.equal(controller.getSnapshot().dialog, null);
  context.delivery.sending = false; context.ended = true; controller.publish();
  controller.commands.open("revert"); await controller.commands.send();
  assert.deepEqual(calls, []);
});

test("copy failure is explicit and retryable", async () => {
  let attempts = 0;
  const { controller, calls } = fixture({ copy: async () => { if (++attempts === 1) throw new Error("denied"); } });
  await controller.commands.copy();
  assert.equal(controller.getSnapshot().copyStatus, "failed");
  await controller.commands.copy();
  assert.equal(controller.getSnapshot().copyStatus, "copied");
  assert.equal(calls.length, 1);
});
