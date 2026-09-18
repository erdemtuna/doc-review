import test from "node:test";
import assert from "node:assert/strict";
import { createReviewApi, ApiError } from "../lib/chrome-api.js";
import { createFrameController } from "../lib/frame-controller.js";
import { createSaveController } from "../lib/save-controller.js";
import { createFeedbackController } from "../lib/feedback-controller.js";
import { createReviewController } from "../lib/review-controller.js";
import { createFrameHost } from "../lib/frame-host.js";
import { JSDOM } from "jsdom";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const drain = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
const pageResponse = (extra = {}) => ({
  key: "p", kind: "file", file: "test.html", filename: "test.html", markdown: false,
  executionMode: "static", savePolicy: "writable", feedbackOnly: false, canRevert: true,
  pollCommand: "doc-review poll test.html", historySupported: true, comments: [], edits: [],
  ...extra,
});

function clock() {
  const jobs = new Map();
  let now = 0, id = 0;
  return {
    setTimer(fn, ms) { const key = ++id; jobs.set(key, { fn, at: now + ms }); return key; },
    clearTimer(key) { jobs.delete(key); },
    async tick(ms) {
      now += ms;
      for (const [key, job] of [...jobs]) if (job.at <= now) { jobs.delete(key); job.fn(); }
      await drain();
    },
    get size() { return jobs.size; },
  };
}

function frameFixture(overrides = {}) {
  const messages = [], failures = [], paths = [];
  const source = {};
  let load;
  let previous = null;
  let disposed = false;
  const timers = clock();
  const host = {
    get previous() { return previous; },
    onLoad(fn) { load = fn; return () => { load = null; }; },
    navigate(path, replacing) { paths.push(path); if (replacing) previous = {}; },
    finishReplacement() { previous = null; },
    suspend() {},
    ready() {},
    send(message, origin) { messages.push({ message, origin }); },
    acceptsSource(value) { return value === source; },
    setPolicy() {},
    afterPaint(fn) { fn(); },
    dispose() { disposed = true; },
  };
  const controller = createFrameController({
    sessionId: "s", host, suspended() {}, failed: (message) => failures.push(message),
    now: () => 42, ...timers,
    request: async (path, options) => path.endsWith("/ready")
      ? { executionMode: "static", savePolicy: "writable", sourceHash: "h" }
      : { renderId: `r${JSON.parse(options.body).generation}`, capability: "c", sourceHash: "h", path: "/artifact/r/index.html" },
    ...overrides,
  });
  controller.setPolicy({ sandbox: "allow-scripts", incomingOrigin: "null", targetOrigin: "*" });
  const start = async () => {
    const generation = controller.begin("p");
    controller.startReload();
    await controller.register("p", generation);
    return generation;
  };
  return { controller, host, start, messages, failures, paths, timers, source,
    loaded: () => load?.(), get disposed() { return disposed; } };
}

test("API retains token, binary content type, HTTP error metadata, and no mutation retry", async () => {
  const calls = [];
  const api = createReviewApi({ token: "secret", fetch: async (url, options) => {
    calls.push(options);
    return new Response(JSON.stringify({ error: "changed", code: "CONFLICT", targets: ["p"] }), { status: 409 });
  } });
  await assert.rejects(api.request("/save", { method: "POST", headers: { "content-type": "application/octet-stream" } }), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "CONFLICT");
    assert.deepEqual(error.targets, ["p"]);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get("x-doc-review-token"), "secret");
  assert.equal(calls[0].headers.get("content-type"), "application/octet-stream");
  api.dispose();
  await assert.rejects(api.request("/page"), /closed/);
});

test("API preserves non-JSON HTTP failures and aborts owned requests", async () => {
  const api = createReviewApi({ token: "t", fetch: async () => new Response("broken", { status: 502 }) });
  await assert.rejects(api.request("/page"), /Request failed \(502\)/);
  let signal;
  const pending = createReviewApi({ token: "t", fetch: async (_, options) => {
    signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  } });
  const request = pending.request("/page");
  pending.dispose();
  assert.equal(signal.aborted, true);
  await assert.rejects(request, /Review ended/);
});

test("frame controller correlates messages, holds policy, and completes replacement after configuration", async () => {
  const f = frameFixture();
  const generation = await f.start();
  const event = { source: f.source, origin: "null", data: { type: "eh:ready", capability: "c", generation, pageKey: "p" } };
  assert.equal(f.controller.accepts(event), true);
  assert.equal(f.controller.accepts({ ...event, origin: "http://localhost" }), false);
  assert.equal(f.controller.accepts({ ...event, source: {} }), false);
  assert.equal(f.controller.accepts({ ...event, data: { ...event.data, generation: 0 } }), false);
  await f.controller.ready();
  const execution = f.controller.state.execution;
  f.controller.holdReload();
  assert.equal(f.controller.state.execution, execution);
  assert.equal(f.controller.state.pendingReload, true);
  assert.ok(f.host.previous);
  const configuration = f.controller.configure("edit", "writable");
  f.controller.configured("edit", "writable");
  assert.equal(await configuration, true);
  assert.equal(f.host.previous, null);
  assert.equal(f.messages.at(-1).origin, "*");
  f.controller.dispose();
  assert.equal(f.timers.size, 0);
  assert.equal(f.disposed, true);
});

test("stale frame registration and readiness responses cannot update the next generation", async () => {
  const old = deferred();
  const f = frameFixture({ request: () => old.promise });
  const generation = f.controller.begin("p");
  const registration = f.controller.register("p", generation);
  f.controller.begin("other");
  old.resolve({ renderId: "old", capability: "old", path: "/artifact/old/index.html" });
  assert.equal(await registration, false);
  assert.equal(f.controller.state.renderId, null);
  assert.deepEqual(f.paths, []);
  f.controller.dispose();
});

test("frame readiness has one five-second retry and disposal settles strict flush/configuration", async () => {
  const f = frameFixture();
  await f.start();
  await f.timers.tick(5000);
  assert.equal(f.paths.length, 2);
  await f.timers.tick(5000);
  assert.equal(f.failures.length, 1);
  assert.equal(f.controller.state.phase.kind, "failed");
  f.controller.dispose();
  const ready = frameFixture();
  await ready.start();
  await ready.controller.ready();
  const flush = ready.controller.flush(true);
  const rejection = assert.rejects(flush, /did not finish saving/);
  const configuration = ready.controller.configure("edit", "writable");
  ready.controller.dispose();
  await rejection;
  assert.equal(await configuration, false);
  assert.equal(ready.timers.size, 0);
});

test("configuration timeout is visible and an old configuration waiter is settled", async () => {
  const f = frameFixture();
  await f.start();
  await f.controller.ready();
  const first = f.controller.configure("view", "writable");
  const second = f.controller.configure("edit", "writable");
  assert.equal(await first, false);
  await f.timers.tick(3000);
  assert.equal(await second, false);
  await f.timers.tick(2000);
  assert.match(f.failures[0], /review settings/);
  f.controller.dispose();
});

for (const wait of [false, true]) {
  test(`confirmed configuration stays ready while replacement paint is paused (wait=${wait})`, async () => {
    const f = frameFixture();
    const paints = [];
    f.host.afterPaint = (callback) => paints.push(callback);
    const generation = await f.start();
    await f.controller.ready();
    const identity = f.controller.identity();
    const execution = f.controller.state.execution;
    const configuration = f.controller.configure("view", "writable", wait);
    assert.equal(f.controller.configured("view", "writable"), true);
    assert.equal(await configuration, true);
    await f.timers.tick(6000);
    assert.deepEqual(f.failures, []);
    assert.deepEqual(f.controller.identity(), identity);
    assert.equal(f.controller.state.execution, execution);
    assert.equal(f.controller.state.configurationGeneration, generation);
    assert.equal(f.controller.state.pendingReload, false);
    assert.equal(f.controller.accepts({
      source: f.source, origin: "null",
      data: { type: "eh:scroll", capability: "c", generation, pageKey: "p" },
    }), true);
    assert.ok(f.host.previous);
    assert.equal(paints.length, 1);
    paints.shift()();
    assert.equal(f.host.previous, null);
    assert.equal(f.timers.size, 0);
    f.controller.dispose();
  });
}

test("mismatched configuration cannot cancel the replacement deadline", async () => {
  const f = frameFixture();
  await f.start();
  await f.controller.ready();
  await f.controller.configure("view", "writable", false);
  assert.equal(f.controller.configured("edit", "writable"), false);
  assert.equal(f.controller.configured("view", "feedback-only"), false);
  await f.timers.tick(5000);
  assert.match(f.failures[0], /review settings/);
  assert.equal(f.controller.state.phase.kind, "failed");
  f.controller.dispose();
});

test("a prior configuration paint cannot finish a newer configuration on the same frame", async () => {
  const f = frameFixture();
  const paints = [];
  f.host.afterPaint = (callback) => paints.push(callback);
  await f.start();
  await f.controller.ready();
  await f.controller.configure("view", "writable", false);
  f.controller.configured("view", "writable");
  await f.controller.configure("edit", "writable", false);
  await f.controller.configure("view", "writable", false);
  paints.shift()();
  assert.ok(f.host.previous);
  await f.timers.tick(5000);
  assert.match(f.failures[0], /review settings/);
  f.controller.dispose();
});

for (const transition of ["reload", "suspend", "dispose"]) {
  test(`a confirmed replacement paint cannot outlive ${transition}`, async () => {
    const f = frameFixture();
    const paints = [];
    f.host.afterPaint = (callback) => paints.push(callback);
    await f.start();
    await f.controller.ready();
    await f.controller.configure("view", "writable", false);
    f.controller.configured("view", "writable");
    if (transition === "reload") {
      await f.start();
      await f.controller.ready();
      await f.controller.configure("view", "writable", false);
    } else {
      f.controller[transition]();
    }
    paints.shift()();
    assert.ok(f.host.previous);
    if (transition === "reload") {
      await f.timers.tick(5000);
      assert.match(f.failures[0], /review settings/);
    } else {
      await f.timers.tick(6000);
      assert.deepEqual(f.failures, []);
      assert.equal(f.timers.size, 0);
    }
    f.controller.dispose();
  });
}

test("iframe self-navigation invalidates draft geometry and save baseline through the transition hook", async () => {
  let transitions = 0;
  const f = frameFixture({ transitioning() { transitions++; } });
  await f.start();
  f.loaded();
  await f.controller.ready();
  const before = f.controller.state.generation;
  f.loaded();
  await drain();
  assert.equal(f.controller.state.generation, before + 1);
  assert.equal(transitions, 2);
  f.controller.dispose();
});

function saveFixture(overrides = {}) {
  let identity = { key: "p", renderId: "r", generation: 1, loading: false };
  const calls = [], pages = [], failures = [], hashes = [];
  const timers = clock();
  const controller = createSaveController({
    sessionId: "s", current: () => identity, policy: () => "writable",
    request: async (path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return { hash: "next", page: pageResponse() }; },
    flush: async () => {}, send() {}, sourceHash: (hash) => hashes.push(hash),
    pageChanged: (page) => pages.push(page), conflict() {}, failed: (message) => failures.push(message),
    diagnostic() {}, sending: () => false, clock: () => "now", ...timers, ...overrides,
  });
  controller.baseline("original");
  return { controller, calls, pages, failures, hashes, timers, switchPage() { identity = { ...identity, generation: 2, renderId: "new" }; } };
}

test("save controller serializes writes with the latest hash and authoritative identity", async () => {
  const f = saveFixture();
  await Promise.all([f.controller.save("one"), f.controller.save("two")]);
  assert.deepEqual(f.calls.map((call) => call.body.baseHash), ["original", "next"]);
  assert.deepEqual(f.calls.map((call) => call.body.renderId), ["r", "r"]);
  assert.equal(f.controller.state.dirty, false);
  assert.equal(f.controller.state.savedAt, "now");
  await f.controller.barrier();
  f.controller.dispose();
});

test("old same-page save/edit responses do not replace new render state", async () => {
  const old = deferred();
  const f = saveFixture({ request: () => old.promise });
  const saving = f.controller.save("one");
  const edit = f.controller.persistEdit("p", { label: "a", kind: "text", after: "one" });
  await drain();
  f.switchPage();
  f.controller.reset();
  old.resolve({ hash: "old", page: { key: "p", stale: true } });
  await Promise.all([saving, edit]);
  assert.equal(f.controller.state.baseHash, null);
  assert.deepEqual(f.pages, []);
  assert.deepEqual(f.hashes, []);
  f.controller.dispose();
});

test("source conflict blocks the save barrier without retries or losing dirty edits", async () => {
  let calls = 0;
  const f = saveFixture({ request: async () => { calls++; throw new ApiError("changed", 409, "CONFLICT", []); } });
  assert.equal(await f.controller.save("one"), false);
  assert.equal(f.controller.state.conflict, true);
  assert.equal(f.controller.state.dirty, true);
  await assert.rejects(f.controller.barrier(), /save conflict/);
  assert.equal(calls, 1);
  f.controller.dispose();
});

test("revert waits for queued saves and retains frame/hash identity", async () => {
  const old = deferred();
  const calls = [];
  const f = saveFixture({ request: async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return path.endsWith("/save") ? old.promise : { page: pageResponse() };
  } });
  const saving = f.controller.save("one");
  const reverting = f.controller.revert();
  await drain();
  assert.equal(calls.length, 1);
  old.resolve({ hash: "saved" });
  await Promise.all([saving, reverting]);
  assert.equal(calls[1].body.baseHash, "saved");
  assert.equal(calls[1].body.renderId, "r");
  assert.equal(calls[1].body.generation, 1);
  f.controller.dispose();
});

for (const newerEdit of [false, true]) {
  test(`successful revert clears discarded edits after reload and preserves newer edits: ${newerEdit}`, async () => {
    const response = deferred(), started = deferred();
    const edits = [];
    const f = saveFixture({ request: async (path, options) => {
      if (path.endsWith("/revert")) { started.resolve(); return response.promise; }
      edits.push(JSON.parse(options.body).after);
      throw new Error("edit unavailable");
    } });
    await f.controller.persistEdit("p", { label: "a", kind: "text", after: "discarded" });
    const reverting = f.controller.revert();
    await started.promise;
    f.switchPage();
    f.controller.reset();
    if (newerEdit) {
      await f.controller.persistEdit("p", { label: "a", kind: "text", after: "new" });
    }
    response.resolve({ page: pageResponse() });
    await reverting;
    assert.equal(f.controller.queued("p"), newerEdit);
    assert.deepEqual(f.pages, []);
    edits.length = 0;
    if (newerEdit) {
      await assert.rejects(f.controller.barrier(), /edit unavailable/);
      assert.deepEqual(edits, ["new"]);
    } else {
      await f.controller.barrier();
      assert.deepEqual(edits, []);
    }
    f.controller.dispose();
  });
}

test("failed revert retains unpersisted edits for the next save barrier", async () => {
  const edits = [];
  const f = saveFixture({ request: async (path, options) => {
    if (path.endsWith("/revert")) throw new Error("revert unavailable");
    edits.push(JSON.parse(options.body).after);
    throw new Error("edit unavailable");
  } });
  await f.controller.persistEdit("p", { label: "a", kind: "text", after: "keep" });
  await assert.rejects(f.controller.revert(), /revert unavailable/);
  assert.equal(f.controller.queued("p"), true);
  edits.length = 0;
  await assert.rejects(f.controller.barrier(), /edit unavailable/);
  assert.deepEqual(edits, ["keep"]);
  f.controller.dispose();
});

function feedbackFixture(overrides = {}) {
  const failures = [], warnings = [], sent = [];
  let note = "old note";
  const saving = saveFixture();
  const controller = createFeedbackController({
    sessionId: "s", current: () => ({ key: "p", renderId: "r", generation: 1, loading: false }),
    sourceHash: () => "h", save: saving.controller, policy: () => "writable",
    capture: async () => { throw new Error("optional capture unavailable"); },
    refresh: async () => false,
    request: async (_, options) => { sent.push(JSON.parse(options.body)); return { ok: true }; },
    note: () => note, clearNote: (value) => { if (note === value) note = ""; },
    pauseCapture() {}, resumeCapture() {}, failed: (message) => failures.push(message),
    warning: (message) => warnings.push(message), announce() {}, ...overrides,
  });
  return { controller, saving, failures, warnings, sent, setNote(value) { note = value; }, get note() { return note; } };
}

test("optional capture and refresh failure cannot undo or resend committed feedback", async () => {
  const refresh = deferred();
  const refreshing = deferred();
  const f = feedbackFixture({ refresh: () => { refreshing.resolve(); return refresh.promise; } });
  const flight = f.controller.send();
  await refreshing.promise;
  assert.equal(f.sent.length, 1);
  assert.equal(f.controller.sent, true);
  assert.equal(f.controller.sending, true);
  await f.controller.send();
  assert.equal(f.sent.length, 1);
  refresh.resolve(false);
  await flight;
  assert.equal(f.controller.sent, true);
  assert.equal(f.note, "");
  assert.equal(f.failures.length, 0);
  assert.match(f.warnings[0], /does not need to be sent again/);
  f.controller.dispose();
  f.saving.controller.dispose();
});

test("ambiguous delivery is not retried and newly entered note text survives commitment", async () => {
  let attempts = 0;
  const failed = feedbackFixture({ request: async () => { attempts++; throw new Error("connection lost"); } });
  await failed.controller.send();
  assert.equal(attempts, 1);
  assert.equal(failed.controller.state.phase, "uncertain");
  assert.equal(failed.note, "old note");
  assert.match(failed.failures[0], /No automatic retry/);
  failed.controller.dispose();
  failed.saving.controller.dispose();
  const delivery = deferred();
  const success = feedbackFixture({ request: () => delivery.promise });
  const flight = success.controller.send();
  await drain();
  success.setNote("new note");
  delivery.resolve({ ok: true });
  await flight;
  assert.equal(success.note, "new note");
  success.controller.dispose();
  success.saving.controller.dispose();
});

test("optional capture notice preserves committed delivery and never offers a second send", async () => {
  const f = feedbackFixture({
    refresh: async () => true,
  });
  await f.controller.send();
  assert.equal(f.controller.state.phase, "delivered");
  assert.match(f.controller.state.notice, /comparison may be incomplete/);
  assert.equal(f.note, "");
  assert.equal(f.failures.length, 0);
  await f.controller.send();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].history.allowUnavailable, true);
  f.controller.dispose();
  f.saving.controller.dispose();
});

test("review coordinator rejects stale same-page refresh and connects/disposes once", async () => {
  const requests = [deferred(), deferred()];
  const pages = [];
  let index = 0, connects = 0, closes = 0, stopped = 0;
  const controller = createReviewController({
    sessionId: "s", key: () => "p", generation: () => 1,
    request: () => requests[index++].promise, refreshPage: (page) => pages.push(page),
    beforeRefresh() {}, load: async () => {}, reload: async () => {}, history: async () => {},
    save: async () => {}, suspend() {}, hasDrafts: () => false, agent() {}, ended() {},
    failed(error) { throw error; },
    eventSource: () => { connects++; return { addEventListener() {}, close() { closes++; } }; },
  });
  controller.own(() => { stopped++; });
  controller.connect();
  controller.connect();
  const first = controller.refresh(), second = controller.refresh();
  requests[1].resolve(pageResponse({ latest: true }));
  await second;
  requests[0].resolve({ old: true });
  await first;
  assert.deepEqual(pages, [pageResponse({ latest: true })]);
  controller.dispose();
  controller.dispose();
  assert.equal(connects, 1);
  assert.equal(closes, 1);
  assert.equal(stopped, 1);
});

test("frame host keeps the visible policy during handoff and removes old listeners", () => {
  const dom = new JSDOM('<iframe id="frame" src="http://localhost:9999/old"></iframe>', { url: "http://127.0.0.1:9999" });
  const initial = dom.window.document.querySelector("iframe");
  initial.dataset.executionMode = "static";
  initial.dataset.savePolicy = "writable";
  const host = createFrameHost(initial, "http://localhost:9999");
  let loads = 0;
  host.onLoad(() => { loads++; });
  host.navigate("/artifact/new/index.html", true);
  assert.equal(host.previous, initial);
  assert.notEqual(host.current, initial);
  host.ready({ executionMode: "interactive", savePolicy: "feedback-only", executionNotice: null });
  assert.equal(host.visibleExecution.savePolicy, "writable");
  initial.dispatchEvent(new dom.window.Event("load"));
  assert.equal(loads, 0);
  host.current.dispatchEvent(new dom.window.Event("load"));
  assert.equal(loads, 1);
  host.finishReplacement();
  assert.equal(initial.isConnected, false);
  assert.equal(host.visibleExecution.savePolicy, "feedback-only");
  host.dispose();
  host.current.dispatchEvent(new dom.window.Event("load"));
  assert.equal(loads, 1);
  dom.window.close();
});

test("a source reload cannot discard a navigation already submitted to the server", async () => {
  const response = deferred(), requested = deferred();
  const loaded = [];
  let generation = 1;
  const controller = createReviewController({
    sessionId: "s", key: () => "first", generation: () => generation,
    request: async () => { requested.resolve(); return response.promise; },
    refreshPage() {}, beforeRefresh() {},
    load: async (key) => { loaded.push(key); }, reload: async () => {}, history: async () => {},
    save: async () => {}, suspend() {}, hasDrafts: () => false, agent() {}, ended() {},
    failed(error) { throw error; },
  });
  const navigation = controller.navigate({ href: "./second.html" });
  await requested.promise;
  generation++;
  controller.invalidate();
  response.resolve({ key: "second" });
  await navigation;
  assert.deepEqual(loaded, ["second"]);
  controller.dispose();
});

test("disposing save retries settles their promises and prevents late publication", async () => {
  let calls = 0;
  const f = saveFixture({ request: async () => { calls++; throw new Error("offline"); } });
  let changes = 0;
  f.controller.subscribe(() => { changes++; });
  const flight = f.controller.save("one");
  await drain();
  assert.equal(f.timers.size, 1);
  f.controller.dispose();
  const before = changes;
  assert.equal(await flight, false);
  assert.equal(f.timers.size, 0);
  assert.equal(calls, 1);
  assert.equal(changes, before);
});

test("failed required save blocks feedback without attempting capture or delivery", async () => {
  const saving = saveFixture();
  saving.controller.markConflict();
  let captures = 0, deliveries = 0;
  const f = feedbackFixture({
    save: saving.controller,
    capture: async () => { captures++; return {}; },
    request: async () => { deliveries++; return { ok: true }; },
  });
  await f.controller.send();
  assert.equal(captures, 0);
  assert.equal(deliveries, 0);
  assert.equal(f.controller.state.phase, "failed");
  assert.equal(f.note, "old note");
  f.controller.dispose();
  f.saving.controller.dispose();
  saving.controller.dispose();
});
