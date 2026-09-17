import test from "node:test";
import assert from "node:assert/strict";
import { createControllerStore } from "../lib/controller-store.js";
import { createSaveController } from "../lib/save-controller.js";
import { createFeedbackController } from "../lib/feedback-controller.js";

const identity = { key: "p", renderId: "r", generation: 1, loading: false };
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
};

test("snapshots isolate nested mutable records, arrays, and projected map values", () => {
  const drafts = new Map([["p", { text: "first", selection: [1, 2] }]]);
  const state = { phase: { kind: "idle" }, unchanged: { label: "same" } };
  const store = createControllerStore(() => ({ ...state, drafts: [...drafts] }));
  const first = store.getSnapshot();
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.drafts[0][1].selection));
  assert.throws(() => { first.drafts[0][1].text = "wrong"; }, TypeError);
  assert.throws(() => first.drafts.push(["other", {}]), TypeError);
  drafts.get("p").text = "second";
  drafts.get("p").selection.push(3);
  state.phase.kind = "saving";
  assert.equal(first.drafts[0][1].text, "first");
  assert.deepEqual(first.drafts[0][1].selection, [1, 2]);
  assert.equal(first.phase.kind, "idle");
  assert.equal(store.getSnapshot(), first);
  assert.equal(store.publish(), true);
  const next = store.getSnapshot();
  assert.equal(next.drafts[0][1].text, "second");
  assert.deepEqual(next.drafts[0][1].selection, [1, 2, 3]);
  assert.equal(next.unchanged, first.unchanged);
  assert.equal(store.publish(), false);
  assert.equal(store.getSnapshot(), next);
});

test("reads are cached and unchanged publications never notify", () => {
  let reads = 0, notifications = 0;
  const state = { count: 0 };
  const store = createControllerStore(() => { reads++; return state; });
  const unsubscribe = store.subscribe(() => notifications++);
  const initial = store.getSnapshot();
  for (let i = 0; i < 10; i++) assert.equal(store.getSnapshot(), initial);
  assert.equal(reads, 1);
  assert.equal(store.publish(), false);
  assert.equal(notifications, 0);
  state.count++;
  assert.equal(store.publish(), true);
  assert.equal(notifications, 1);
  assert.equal(store.publish(), false);
  unsubscribe();
  unsubscribe();
  state.count++;
  store.publish();
  assert.equal(notifications, 1);
  assert.equal(store.getSnapshot().count, 2);
});

test("subscriptions are independent even for the same callback and survive remount", () => {
  const state = { count: 0 };
  const store = createControllerStore(() => state);
  let calls = 0;
  const listener = () => calls++;
  const first = store.subscribe(listener);
  const second = store.subscribe(listener);
  first();
  state.count++;
  store.publish();
  assert.equal(calls, 1);
  second();
  const third = store.subscribe(listener);
  state.count++;
  store.publish();
  assert.equal(calls, 2);
  third();
  store.dispose();
  store.dispose();
  state.count++;
  assert.equal(store.publish(), false);
  assert.equal(store.getSnapshot().count, 2);
  assert.throws(() => store.subscribe(listener), /disposed/);
});

test("one store cannot publish into or dispose another store", () => {
  const state = { count: 0 };
  const first = createControllerStore(() => state);
  const second = createControllerStore(() => state);
  let firstCalls = 0, secondCalls = 0;
  first.subscribe(() => firstCalls++);
  second.subscribe(() => secondCalls++);
  state.count++;
  first.publish();
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 0);
  assert.equal(second.getSnapshot().count, 0);
  first.dispose();
  second.publish();
  assert.equal(secondCalls, 1);
});

test("listener removal during publication is honored and failures are not swallowed", () => {
  const state = { count: 0 };
  const store = createControllerStore(() => state);
  let calls = 0, removeSecond;
  store.subscribe(() => { removeSecond(); throw new Error("listener broke"); });
  removeSecond = store.subscribe(() => assert.fail("removed listener ran"));
  store.subscribe(() => calls++);
  state.count++;
  assert.throws(() => store.publish(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].message, "listener broke");
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(store.getSnapshot().count, 1);
});

test("unsupported mutable data fails explicitly without corrupting the last snapshot", () => {
  let state = { value: 1 };
  const store = createControllerStore(() => state);
  const first = store.getSnapshot();
  for (const value of [new Map(), new Set(), new Date(), () => {}]) {
    state = { value };
    assert.throws(() => store.publish(), TypeError);
    assert.equal(store.getSnapshot(), first);
  }
  state = {};
  state.self = state;
  assert.throws(() => store.publish(), /cycles/);
  state = { get value() { assert.fail("accessor was evaluated"); } };
  assert.throws(() => store.publish(), /accessors/);
  state = { value: 2 };
  assert.equal(store.publish(), true);
});

function saveController(overrides = {}) {
  return createSaveController({
    sessionId: "s", current: () => identity, policy: () => "writable",
    request: async () => ({ hash: "next" }), flush: async () => {}, send() {},
    sourceHash() {}, pageChanged() {}, conflict() {}, failed() {}, diagnostic() {},
    sending: () => false, clock: () => "now", ...overrides,
  });
}

test("save snapshots publish baseline, dirty completion, conflict, and reset transitions", async () => {
  const controller = saveController();
  const initial = controller.getSnapshot();
  let calls = 0;
  controller.subscribe(() => calls++);
  controller.baseline("original");
  assert.equal(controller.getSnapshot().baseHash, "original");
  controller.baseline("original");
  assert.equal(calls, 1);
  const baseline = controller.getSnapshot();
  const saving = controller.save("html");
  assert.equal(controller.getSnapshot().dirty, true);
  await saving;
  assert.equal(controller.getSnapshot().dirty, false);
  assert.equal(controller.getSnapshot().status, "saved");
  assert.equal(baseline.dirty, false);
  assert.equal(initial.baseHash, null);
  controller.markSaving();
  controller.hold();
  assert.equal(controller.getSnapshot().conflict, true);
  assert.equal(controller.getSnapshot().baseHash, null);
  controller.reset();
  assert.deepEqual(controller.getSnapshot(), initial);
  controller.markConflict();
  assert.equal(controller.getSnapshot().conflict, true);
  const final = controller.getSnapshot();
  controller.dispose();
  controller.markDynamic();
  assert.equal(controller.getSnapshot(), final);
});

function feedbackController(overrides = {}) {
  return createFeedbackController({
    sessionId: "s", current: () => identity, sourceHash: () => "hash",
    save: { barrier: async () => {}, settled: async () => {}, settleEdits: async () => {},
      state: { conflict: false, status: "saved", dynamic: false, dirty: false, baseHash: "hash" } },
    policy: () => "writable", capture: async () => ({}), refresh: async () => {},
    request: async () => ({ ok: true }), note: () => "note", clearNote() {},
    pauseCapture() {}, resumeCapture() {}, failed() {}, warning() {}, announce() {},
    ...overrides,
  });
}

test("feedback snapshots expose sending/sent across commit, refresh, and reset", async () => {
  const refresh = deferred();
  const committed = deferred();
  const controller = feedbackController({
    refresh: () => { committed.resolve(); return refresh.promise; },
  });
  const snapshots = [];
  controller.subscribe(() => snapshots.push(controller.getSnapshot()));
  const initial = controller.getSnapshot();
  const flight = controller.send();
  assert.deepEqual(controller.getSnapshot(), { phase: "saving", sending: true, sent: false });
  await committed.promise;
  assert.deepEqual(controller.getSnapshot(), { phase: "delivered", sending: true, sent: true });
  refresh.resolve();
  await flight;
  assert.deepEqual(controller.getSnapshot(), { phase: "delivered", sending: false, sent: true });
  assert.equal(initial.phase, "idle");
  assert.ok(snapshots.every(Object.isFrozen));
  controller.clearSent();
  assert.deepEqual(controller.getSnapshot(), initial);
  const count = snapshots.length;
  controller.clearSent();
  assert.equal(snapshots.length, count);
  controller.dispose();
});

test("disposal prevents late feedback responses from notifying subscribers", async () => {
  const request = deferred();
  const started = deferred();
  const controller = feedbackController({
    request: () => { started.resolve(); return request.promise; },
  });
  let calls = 0;
  controller.subscribe(() => calls++);
  const flight = controller.send();
  await started.promise;
  controller.dispose();
  const final = controller.getSnapshot(), count = calls;
  request.resolve({ ok: true });
  await flight;
  assert.equal(calls, count);
  assert.equal(controller.getSnapshot(), final);
});

test("failed feedback snapshots retain the error and expose completed sending state", async () => {
  const controller = feedbackController({
    request: async () => { throw new Error("connection lost"); },
  });
  await controller.send();
  const failed = controller.getSnapshot();
  assert.equal(failed.phase, "uncertain");
  assert.match(failed.message, /connection lost/);
  assert.equal(failed.sending, false);
  assert.equal(failed.sent, false);
  controller.clearSent();
  assert.equal(controller.getSnapshot().phase, "idle");
  assert.equal(failed.phase, "uncertain");
  controller.dispose();
});
