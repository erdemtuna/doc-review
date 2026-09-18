import test from "node:test";
import assert from "node:assert/strict";
import { createChangesController, changesSelection } from "../lib/changes-controller.js";
import { createHistoryController } from "../lib/history-coordinator.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides = {}) {
  const calls = [];
  const content = { available: true, counts: { added: 0, modified: 2, removed: 0 }, changes: [
    { id: "a", kind: "modified", label: "First", before: "Before", after: "After" },
    { id: "b", kind: "modified", label: "Second", before: "Before two", after: "After two" },
  ], limitations: ["visible_only"], beforeCapturedAt: 1000, afterCapturedAt: 4000 };
  const round = { roundId: "round", ordinal: 1, feedbackStatus: "acknowledged", acknowledgedAt: 3000,
    targets: [
      { key: "page", filename: "first.html", capture: { status: "pending" }, comparison: { content, source: { ...content } } },
      { key: "other", filename: "other.html", capture: { status: "failed" } },
    ] };
  const history = {
    rounds: [round], round, selectedId: "round", targetKey: "page", mode: "content", preferredMode: null,
    index: 0, loading: false, error: null, captureBusy: false, finalizing: false, failures: new Map(),
  };
  const context = { history, ended: false, comparing: true, sending: false,
    current: { key: "page", kind: "file", ready: true, pendingReload: false, dirty: false, sourceHash: "hash", sessionId: "session", generation: 1 } };
  const controller = createChangesController({
    read: () => context,
    selectRound: async (id) => calls.push(["round", id]),
    selectTarget: async (key) => calls.push(["target", key]),
    selectMode: (mode) => { calls.push(["mode", mode]); history.preferredMode = mode; history.index = 0; controller.publish(); },
    selectIndex: (index) => { calls.push(["index", index]); history.index = index; controller.publish(); },
    capture: async () => calls.push("capture"), finish: async () => calls.push("finish"),
    refresh: async () => calls.push("refresh"), failed: (message) => calls.push(["failure", message]),
    ...overrides,
  });
  return { controller, context, history, content, calls };
}

test("Changes projection is cached, immutable and never normalizes by mutating its owner", () => {
  const { controller, history, content } = fixture();
  history.index = 999; history.preferredMode = "unavailable"; controller.publish();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.index, 1);
  assert.equal(snapshot.mode, "content");
  assert.equal(snapshot.rounds[0].shortLabel, "Round 1");
  assert.equal(snapshot.rounds[0].label, "Round 1 · acknowledged");
  assert.equal(history.index, 999);
  assert.equal(history.preferredMode, "unavailable");
  assert.equal(controller.getSnapshot(), snapshot);
  assert.equal(controller.publish(), undefined);
  assert.equal(controller.getSnapshot(), snapshot);
  assert.throws(() => snapshot.targets.push({ value: "bad", label: "bad" }), TypeError);
  content.changes[0].label = "new label";
  assert.match(snapshot.changes[0].label, /First/);
  controller.publish();
  assert.match(controller.getSnapshot().changes[0].label, /new label/);
});

test("normalization retains Source fallback, explicit preference and hidden stale round data", () => {
  const { history } = fixture();
  history.round.targets[0].comparison.content.available = false;
  history.preferredMode = "content";
  assert.equal(changesSelection(history).mode, "source");
  history.round.targets[0].comparison.content.available = true;
  assert.equal(changesSelection(history).mode, "content");
  history.selectedId = "different";
  const selection = changesSelection(history);
  assert.equal(selection.round, null);
  assert.equal(selection.target, null);
  assert.deepEqual(selection.modes, []);
});

test("guarded selection validates current choices and navigation does not wrap or accept stale keys", async () => {
  const { controller, calls, history } = fixture();
  await controller.commands.selectRound("unknown");
  await controller.commands.selectTarget("unknown");
  controller.commands.selectMode("invalid");
  controller.commands.jump(1, "stale");
  controller.commands.jump(-1, "round:page");
  controller.commands.jump(0.5, "round:page");
  assert.deepEqual(calls, []);
  controller.commands.jump(1, "round:page");
  assert.deepEqual(calls, [["index", 1]]);
  assert.deepEqual(controller.getSnapshot().scrollRequest, { sequence: 1, key: "round:page", mode: "content", index: 1 });
  assert.equal(controller.getSnapshot().nextDisabled, true);
  controller.commands.selectMode("source");
  assert.equal(history.index, 0);
  assert.equal(controller.getSnapshot().mode, "source");
  history.loading = true;
  controller.commands.selectMode("content");
  await controller.commands.selectTarget("other");
  assert.equal(calls.length, 2);
  assert.equal(controller.getSnapshot().scrollRequest, null);
});

test("diagnostics preserve disclosure and report both modes' limitations, timing and freshness", () => {
  const { controller, history } = fixture();
  history.round.targets[0].comparison.source.limitations = ["visible_only", "source-limited"];
  controller.commands.disclose("diagnostics", true);
  controller.commands.disclose("limitations", true);
  controller.publish();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.diagnosticsOpen, true);
  assert.equal(snapshot.limitationsOpen, true);
  assert.deepEqual(snapshot.limitations, ["visible only", "source limited"]);
  assert.match(snapshot.delay, /1 seconds after acknowledgment/);
  assert.match(snapshot.freshness, /unverified/);
  assert.equal(snapshot.timing.length, 3);
});

test("unavailable/limited formats never produce successful zero-count output", () => {
  const { controller, history } = fixture();
  history.round.targets[0].comparison = {
    content: { available: false, reason: "Processing limits", limitations: ["max_blocks"], counts: null },
    source: { available: false, reason: "No source", counts: null },
  };
  history.round.targets[0].resultRevisionId = "after";
  controller.publish();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.status, "partial");
  assert.equal(snapshot.counts, null);
  assert.equal(snapshot.hasComparison, false);
  assert.match(snapshot.unavailable[0], /Processing limits/);
});

for (const action of ["capture", "finish"]) {
  test(`${action} is single-flight and errors remain explicit, scoped to their target`, async () => {
    const pending = deferred();
    let count = 0;
    const { controller, history, calls } = fixture({ [action]: async () => { count++; await pending.promise; } });
    const flight = controller.commands[action]("round:page");
    await controller.commands[action]("round:page");
    assert.equal(count, 1);
    assert.equal(controller.getSnapshot().captureDisabled, true);
    assert.equal(controller.getSnapshot().finishDisabled, true);
    pending.reject(new Error("Service unavailable"));
    await flight;
    assert.equal(controller.getSnapshot().error, "Service unavailable");
    assert.deepEqual(calls, [["failure", "Service unavailable"]]);
    history.targetKey = "other"; controller.publish();
    assert.equal(controller.getSnapshot().error, "");
  });
}

test("inactive targets can finalize but cannot capture; reload/send/end block guarded actions", async () => {
  const { controller, history, context, calls } = fixture();
  history.targetKey = "other"; controller.publish();
  await controller.commands.capture("round:other");
  await controller.commands.finish("round:other");
  assert.deepEqual(calls, ["finish"]);
  history.targetKey = "page"; context.current.pendingReload = true; controller.publish();
  await controller.commands.capture("round:page");
  context.sending = true;
  await controller.commands.finish("round:page");
  context.ended = true;
  controller.commands.jump(1, "round:page");
  assert.deepEqual(calls, ["finish"]);
});

test("detail version notifies a renderer about changed payloads without copying rows into controls", () => {
  const { controller, history } = fixture();
  const before = controller.getSnapshot();
  const value = history.round.targets[0].comparison.content;
  history.round.targets[0].comparison.content = { ...value, rows: [{ id: "new" }] };
  controller.publish();
  assert.equal(controller.getSnapshot().detailVersion, before.detailVersion + 1);
  assert.equal("rows" in controller.getSnapshot(), false);
  assert.equal(controller.getDetail().value.rows[0].id, "new");
});

test("authoritative refresh normalizes index and fallback before changed notification", async () => {
  let controller;
  const observed = [];
  controller = createHistoryController({
    changed: () => { if (!controller.state.loading) observed.push([controller.state.mode, controller.state.index]); },
    request: async (route) => {
      if (!route) return { rounds: [{ roundId: "round" }] };
      if (route.endsWith("mode=content")) return { available: false };
      if (route.includes("/compare")) return { available: true, changes: [{ id: "only" }] };
      return { round: { roundId: "round", targets: [{ key: "page" }] } };
    },
  });
  controller.state.index = 99;
  await controller.refresh();
  assert.deepEqual(observed, [["source", 0]]);
});
