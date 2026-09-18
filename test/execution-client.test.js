import test from "node:test";
import assert from "node:assert/strict";
import { executionPresentation } from "../lib/execution-client.js";
import { createRecoveryController } from "../lib/recovery-controller.js";

test("actual displayed frame policy wins over newly classified source", () => {
  const page = { key: "a", kind: "file", savePolicy: "writable", executionMode: "static" };
  const view = executionPresentation(page, { executionMode: "interactive", savePolicy: "feedback-only" },
    { pendingReload: true });
  assert.match(view.editDescription, /agent to apply/);
  assert.match(view.status, /previous page/);
  assert.match(executionPresentation({ ...page, savePolicy: "feedback-only" },
    { executionMode: "static", savePolicy: "writable" }).editDescription, /save directly/);
  assert.match(executionPresentation(page, null).editDescription, /Waiting/);
});

test("script-disabled recovery never projects scripted source as writable", () => {
  const view = executionPresentation({ kind: "file", executionPreference: "static" },
    { executionMode: "static", savePolicy: "feedback-only", executionNotice: "External modules are unsupported." });
  assert.match(view.editDescription, /agent/);
  assert.match(view.detail, /source is not overwritten/);
  assert.match(view.detail, /External modules/);
  assert.equal(executionPresentation({ kind: "url" }, null).eligible, false);
  assert.equal(executionPresentation({ kind: "file", markdown: true }, null).eligible, false);
});

function fixture(overrides = {}) {
  const page = {
    key: "a", kind: "file", file: "sample.html", filename: "sample.html", markdown: false,
    executionPreference: "auto", executionMode: "interactive", savePolicy: "feedback-only",
    feedbackOnly: true, canRevert: true, pollCommand: "", historySupported: true, comments: [], edits: [],
  };
  const context = {
    page, rendered: { executionMode: "interactive", savePolicy: "feedback-only" },
    identity: { key: "a", renderId: "r_a", generation: 1, loading: false },
    comparing: false, ended: false, loading: false, pendingReload: false, frameError: null,
    reload: { visible: false, message: "", error: false },
  };
  const changes = [];
  const failures = [];
  const menus = [];
  const controller = createRecoveryController({
    sessionId: "session", read: () => context,
    request: async () => ({ page }), changed: (value) => changes.push(value),
    failed: (message) => failures.push(message), menuChanged: (open) => menus.push(open),
    reload: async () => {}, keepCurrent: () => { context.reload.visible = false; },
    ...overrides,
  });
  return { controller, context, page, changes, failures, menus };
}

test("recovery posts once, closes the menu and publishes immutable busy snapshots", async () => {
  let resolve;
  const calls = [];
  const { controller, page, changes, menus } = fixture({
    request: (path, options) => {
      calls.push([path, JSON.parse(options.body)]);
      return new Promise((done) => { resolve = done; });
    },
  });
  const before = controller.getSnapshot();
  assert.equal(controller.getSnapshot(), before);
  controller.commands.setMenuOpen(true);
  const request = controller.commands.recover("static");
  void controller.commands.recover("static");
  assert.deepEqual(calls, [["/api/session/session/execution", { key: "a", preference: "static" }]]);
  assert.deepEqual(menus, [true, false]);
  assert.equal(controller.getSnapshot().busy, true);
  assert.equal(before.busy, false);
  assert.equal(Object.isFrozen(controller.getSnapshot()), true);
  resolve({ page: { ...page, executionPreference: "static" } });
  await request;
  assert.equal(changes.length, 1);
  assert.equal(controller.getSnapshot().busy, false);
});

test("recovery ignores an old frame response even when navigation returns to the same page", async () => {
  let resolve;
  const { controller, context, page, changes, failures } = fixture({
    request: () => new Promise((done) => { resolve = done; }),
  });
  const request = controller.commands.recover("static");
  context.identity.generation += 2;
  resolve({ page });
  await request;
  assert.deepEqual(changes, []);
  assert.deepEqual(failures, []);
});

test("malformed recovery responses surface a retryable error rather than success", async () => {
  const { controller, failures, changes } = fixture({ request: async () => ({ page: { key: "a" } }) });
  await controller.commands.recover("static");
  assert.equal(failures.length, 1);
  assert.equal(controller.getSnapshot().statusError, true);
  assert.match(controller.getSnapshot().status, /invalid page response.*Retry from More/);
  assert.equal(controller.getSnapshot().canRecover, true);
  assert.deepEqual(changes, []);
});

test("failed frame recovery can reload once while normal loading prevents another reload", async () => {
  let resolve;
  let reloads = 0;
  const { controller, context } = fixture({
    reload: () => { reloads++; return new Promise((done) => { resolve = done; }); },
  });
  context.loading = true;
  context.frameError = "Ready unavailable";
  context.reload = { visible: true, message: "Reload keeps comment drafts.", error: true };
  controller.publish();
  assert.equal(controller.getSnapshot().canReload, true);
  const request = controller.commands.reload();
  void controller.commands.reload();
  controller.commands.keepCurrent();
  assert.equal(reloads, 1);
  assert.equal(context.reload.visible, true);
  resolve();
  await request;
  context.frameError = null;
  controller.publish();
  assert.equal(controller.getSnapshot().canReload, false);
});

test("Changes and shutdown suppress notices and commands without mutating reload ownership", async () => {
  let requests = 0;
  const { controller, context } = fixture({ request: async () => { requests++; return {}; } });
  context.reload = { visible: true, message: "Keep this draft", error: false };
  controller.commands.setMenuOpen(true);
  context.comparing = true;
  controller.publish();
  assert.equal(controller.getSnapshot().reloadVisible, false);
  assert.equal(controller.getSnapshot().menuOpen, false);
  assert.equal(context.reload.visible, true);
  await controller.commands.recover("static");
  assert.equal(requests, 0);
  context.comparing = false;
  context.ended = true;
  await controller.commands.recover("static");
  assert.equal(requests, 0);
});

test("disposal aborts recovery and prevents late publication or page mutation", async () => {
  let resolve;
  let signal;
  const { controller, page, changes, failures } = fixture({
    request: (_path, options) => {
      signal = options.signal;
      return new Promise((done) => { resolve = done; });
    },
  });
  let publications = 0;
  controller.subscribe(() => { publications++; });
  const request = controller.commands.recover("static");
  controller.dispose();
  const before = publications;
  assert.equal(signal.aborted, true);
  resolve({ page });
  await request;
  assert.equal(publications, before);
  assert.deepEqual(changes, []);
  assert.deepEqual(failures, []);
});

test("a late iframe dismissal cancels pending menu focus restoration", () => {
  const { controller, menus } = fixture();
  controller.commands.setMenuOpen(true);
  controller.commands.setMenuOpen(false);
  controller.commands.setMenuOpen(false, { restoreFocus: false });
  assert.equal(controller.getSnapshot().restoreMenuFocus, false);
  assert.deepEqual(menus, [true, false]);
});
