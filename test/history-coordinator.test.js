import test from "node:test";
import assert from "node:assert/strict";
import { createCaptureCoordinator, createHistoryController, deliverFeedback, historyPresentation,
  requireCaptureSuccess, transientCaptureError } from "../lib/history-coordinator.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const transient = () => Object.assign(new Error("Still changing"), { code: "CAPTURE_UNSTABLE" });

function clock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, delay) { const id = ++sequence; timers.set(id, { fn, due: now + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of timers) if (timer.due <= now) { timers.delete(id); timer.fn(); }
      await settle();
    },
    get pending() { return timers.size; },
  };
}

test("transient capture retries have exactly 1, 2, 4 second backoff then stop", async () => {
  const time = clock();
  const starts = [];
  const coordinator = createCaptureCoordinator({
    ...time, candidates: () => [{ id: "round" }], ready: () => true,
    capture: async () => { starts.push(time.now()); throw transient(); },
  });
  coordinator.tick();
  await settle();
  assert.deepEqual(starts, [0]);
  await time.advance(999);
  assert.equal(starts.length, 1);
  await time.advance(1);
  await time.advance(2000);
  await time.advance(4000);
  assert.deepEqual(starts, [0, 1000, 3000, 7000]);
  coordinator.tick();
  await time.advance(10000);
  assert.equal(starts.length, 4);
  assert.equal(time.pending, 0);
  coordinator.stop();
});

test("delayed or exhausted rounds do not starve another eligible round", async () => {
  const time = clock();
  const seen = [];
  const coordinator = createCaptureCoordinator({
    ...time, candidates: () => [{ id: "older" }, { id: "newer" }], ready: () => true,
    capture: async ({ id }) => { seen.push(id); if (id === "older") throw transient(); },
  });
  coordinator.tick();
  await settle();
  assert.deepEqual(seen, ["older", "newer"]);
  await time.advance(1000);
  assert.deepEqual(seen, ["older", "newer", "older"]);
  coordinator.stop();
});

test("ownership/view/source conflicts are not retried automatically", async () => {
  for (const code of ["history_capture_owner", "history_view_mismatch", "history_source_changed", "CAPTURE_UNAVAILABLE"]) {
    const time = clock();
    let count = 0;
    const coordinator = createCaptureCoordinator({
      ...time, candidates: () => [{ id: "round" }], ready: () => true,
      capture: async () => { count++; throw Object.assign(new Error(code), { code, status: 409 }); },
    });
    coordinator.tick();
    await settle();
    await time.advance(10000);
    assert.equal(count, 1);
    coordinator.stop();
  }
  assert.equal(transientCaptureError({ code: "CAPTURE_BUSY" }), true);
  assert.equal(transientCaptureError({ status: 503 }), true);
  assert.equal(transientCaptureError({ status: 500 }), false);
  assert.equal(transientCaptureError(new TypeError("Cannot read properties of null")), false);
  assert.equal(transientCaptureError(new TypeError("Failed to fetch")), true);
});

test("navigation aborts active work and end-review cancels delayed retries", async () => {
  const time = clock();
  const pending = deferred();
  let signal;
  let count = 0;
  const coordinator = createCaptureCoordinator({
    ...time, candidates: () => [{ id: "round" }], ready: () => true,
    capture: async (_, value) => { count++; signal = value; await pending.promise; throw transient(); },
  });
  coordinator.tick();
  await settle();
  coordinator.reset();
  assert.equal(signal.aborted, true);
  pending.resolve();
  await settle();
  assert.equal(time.pending, 0);
  coordinator.tick();
  await settle();
  assert.equal(count, 2);
  coordinator.stop();
  await time.advance(10000);
  coordinator.tick();
  assert.equal(count, 2);
});

test("readiness pauses retries until a meaningful ready signal", async () => {
  const time = clock();
  let ready = true;
  let count = 0;
  const coordinator = createCaptureCoordinator({
    ...time, candidates: () => [{ id: "round" }], ready: () => ready,
    capture: async () => { count++; throw transient(); },
  });
  coordinator.tick();
  await settle();
  ready = false;
  await time.advance(1000);
  assert.equal(count, 1);
  ready = true;
  coordinator.tick();
  await settle();
  assert.equal(count, 2);
  coordinator.stop();
});

test("HTTP 200 recorded capture failure is not a successful result", () => {
  assert.throws(() => requireCaptureSuccess({ ok: false, round: {
    targets: [{ key: "page", capture: { error: "No stable Content" } }],
  } }, "page"), { code: "CAPTURE_UNAVAILABLE", message: "No stable Content" });
  const success = { ok: true };
  assert.equal(requireCaptureSuccess(success, "page"), success);
});

test("primary state keeps available Source ahead of missing or failed Content", () => {
  const round = { feedbackStatus: "acknowledged" };
  const view = historyPresentation({
    round, target: { capture: { status: "failed" } }, failure: "No stable snapshot",
    comparison: { source: { available: true }, content: { available: false, counts: null } },
  });
  assert.equal(view.state, "partial");
  assert.deepEqual(view.modes, ["source"]);
  assert.match(view.message, /Source available/);
  assert.equal(historyPresentation({ loading: true }).state, "loading");
  assert.equal(historyPresentation({}).state, "empty");
  assert.equal(historyPresentation({ error: new Error("Offline") }).state, "failed");
  assert.equal(historyPresentation({ round }).state, "waiting");
  assert.equal(historyPresentation({ round, comparison: {
    content: { available: true }, source: { available: true },
  } }).state, "available");
});

test("history refresh publishes atomically and never labels an old round as the new selection", async () => {
  const pending = deferred();
  let hold = false;
  const observed = [];
  const controller = createHistoryController({
    changed: () => observed.push({ selected: controller.state.selectedId, round: controller.state.round?.roundId }),
    request: async (path) => {
      if (!path) return { rounds: [{ roundId: "one" }, { roundId: "two" }] };
      if (path === "/two" && hold) return pending.promise;
      if (path.includes("/compare")) return { available: true, counts: { added: 1 } };
      return { round: { roundId: path.slice(1), targets: [{ key: "page" }] } };
    },
  });
  await controller.refresh();
  assert.equal(controller.state.round.roundId, "one");
  hold = true;
  const loading = controller.selectRound("two");
  assert.equal(controller.state.round, null);
  assert.equal(controller.state.loading, true);
  await settle();
  await controller.selectRound("one");
  pending.resolve({ round: { roundId: "two", targets: [{ key: "page" }] } });
  await loading;
  assert.equal(controller.state.round.roundId, "one");
  assert.ok(observed.every((item) => !item.round || item.round === item.selected));
});

test("history preserves round/page/explicit format and independently loads Source", async () => {
  const controller = createHistoryController({
    request: async (path) => {
      if (!path) return { rounds: [{ roundId: "round" }] };
      if (path.endsWith("mode=content")) throw new Error("Content unavailable");
      if (path.includes("/compare")) return { available: true, counts: null };
      return { round: { roundId: "round", targets: [{ key: "a" }, { key: "b" }] } };
    },
  });
  await controller.refresh();
  await controller.selectTarget("b");
  controller.state.preferredMode = "source";
  await controller.refresh();
  assert.equal(controller.state.selectedId, "round");
  assert.equal(controller.state.targetKey, "b");
  assert.equal(controller.state.preferredMode, "source");
  assert.equal(controller.state.round.targets[1].comparison.source.available, true);
  assert.equal(controller.state.round.targets[1].comparison.content.available, false);
  assert.equal(controller.state.round.targets[1].comparison.content.counts, null);
});

test("required save failure prevents optional capture and delivery", async () => {
  const never = () => assert.fail("must not run");
  await assert.rejects(deliverFeedback({
    save: async () => { throw new Error("Save conflict"); }, capture: never, deliver: never,
    committed: never, refresh: never,
  }), /Save conflict/);
});

test("optional capture failure sends once; post-success refresh failure never retries delivery", async () => {
  const order = [];
  const outcome = await deliverFeedback({
    save: async () => { order.push("save"); },
    capture: async () => { order.push("capture"); throw transient(); },
    deliver: async (snapshot) => { order.push("send"); assert.equal(snapshot, null); },
    committed: () => { order.push("committed"); },
    refresh: async () => { order.push("refresh"); throw new Error("Offline"); },
  });
  assert.deepEqual(order, ["save", "capture", "send", "committed", "refresh"]);
  assert.equal(outcome.captureFailure.code, "CAPTURE_UNSTABLE");
  assert.equal(outcome.refreshFailure.message, "Offline");
});

test("successful active semantic baseline survives missing coverage on other pages", async () => {
  const snapshot = { semantic: { blocks: ["active page"] } };
  let committed = 0;
  await deliverFeedback({
    save: async () => {}, capture: async () => snapshot,
    deliver: async (value) => assert.equal(value, snapshot),
    committed: () => { committed++; }, refresh: async () => true,
  });
  assert.equal(committed, 1);
});

test("ambiguous delivery failure is neither retried nor committed", async () => {
  let deliveries = 0;
  await assert.rejects(deliverFeedback({
    save: async () => {}, capture: async () => null,
    deliver: async () => { deliveries++; throw new TypeError("Network failure"); },
    committed: () => assert.fail("not confirmed"), refresh: () => assert.fail("not sent"),
  }), /Network failure/);
  assert.equal(deliveries, 1);
});
