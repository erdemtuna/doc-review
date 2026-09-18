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
  let source;
  let autoTheme = overrides.autoTheme !== false;
  const makeSource = () => {
    const window = { postMessage(message, origin) {
      messages.push({ message, origin, source: window });
      if (autoTheme && message.type === "eh:setTheme") queueMicrotask(() => {
        controller.handleThemeMessage({
          source: window, origin: "null", data: { ...message, type: "eh:themeApplied" },
        });
      });
    } };
    return window;
  };
  source = makeSource();
  let load;
  let removed;
  let previous = null;
  let disposed = false;
  let readyCount = 0;
  const timers = clock();
  const host = {
    get previous() { return previous; },
    get currentWindow() { return source; },
    get previousWindow() { return previous?.source || null; },
    onPreviousRemoved(fn) { removed = fn; return () => { removed = null; }; },
    onLoad(fn) { load = fn; return () => { load = null; }; },
    navigate(path, replacing) {
      paths.push(path);
      if (replacing && !previous) previous = { source };
      source = makeSource();
    },
    finishReplacement() { previous = null; removed?.(); },
    suspend() {},
    ready() { readyCount++; },
    send(message, origin) { source.postMessage(message, origin); },
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
  return { controller, host, start, messages, failures, paths, timers,
    get source() { return source; }, get readyCount() { return readyCount; },
    set autoTheme(value) { autoTheme = value; },
    ack(message = messages.filter(({ message, source: sentTo }) => message.type === "eh:setTheme" && sentTo === source).at(-1)?.message, window = source, extra = {}) {
      return controller.handleThemeMessage({ source: window, origin: "null", data: { ...message, type: "eh:themeApplied", ...extra } });
    },
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

test("initial theme is acknowledged before exposure and confirming admits only ready/theme acknowledgments", async () => {
  const f = frameFixture({ autoTheme: false });
  f.controller.setTheme("dark");
  const generation = await f.start();
  const ready = f.controller.ready();
  await drain();
  assert.equal(f.readyCount, 0);
  assert.equal(f.controller.loading, true);
  assert.equal(f.controller.state.phase.kind, "confirming");
  assert.equal(f.controller.themeSync.status, "pending");
  const envelope = { capability: "c", generation, pageKey: "p" };
  for (const type of ["eh:edit", "eh:target", "eh:configurationApplied", "eh:setTheme"]) {
    assert.equal(f.controller.accepts({ source: f.source, origin: "null", data: { ...envelope, type } }), false);
  }
  assert.equal(f.controller.accepts({
    source: f.source, origin: "null", data: { ...envelope, type: "eh:themeApplied", theme: "dark", themeRevision: 2 },
  }), true);
  assert.equal(f.controller.accepts({
    source: f.source, origin: "null", data: { ...envelope, type: "eh:themeApplied", theme: "light", themeRevision: 1 },
  }), false);
  f.controller.send({ type: "eh:anchors", comments: [] });
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].message.theme, "dark");
  await f.timers.tick(2999);
  assert.equal(f.readyCount, 0);
  f.ack();
  assert.equal((await ready).executionMode, "static");
  assert.equal(f.readyCount, 1);
  assert.equal(f.controller.themeSync.status, "applied");
  assert.equal(f.timers.size, 0);
  f.controller.dispose();
});

test("invalid, foreign, unsolicited, and stale theme traffic cannot acknowledge synchronization", async () => {
  const diagnostics = [];
  const f = frameFixture({ autoTheme: false, diagnostic: (code) => diagnostics.push(code) });
  const generation = await f.start();
  f.controller.handleThemeMessage({ source: f.source, origin: "null", data: {
    type: "eh:themeApplied", capability: "c", generation, pageKey: "p", theme: "light", themeRevision: 1,
  } });
  const ready = f.controller.ready();
  await drain();
  const data = { ...f.messages[0].message, type: "eh:themeApplied" };
  for (const patch of [
    { capability: "wrong" }, { generation: generation + 1 }, { pageKey: "wrong" },
    { theme: "dark" }, { themeRevision: 2 }, { themeRevision: 0 }, { themeRevision: "1" },
    { theme: null }, { themeRevision: null }, { theme: "system" }, { type: "eh:setTheme" },
  ]) {
    f.ack(data, f.source, patch);
    assert.equal(f.readyCount, 0);
  }
  for (const event of [
    { source: {}, origin: "null", data },
    { source: null, origin: "null", data },
    { source: f.source, origin: "http://foreign", data },
  ]) f.controller.handleThemeMessage(event);
  assert.equal(f.readyCount, 0);
  assert.deepEqual(diagnostics, ["invalid-theme-acknowledgment"]);
  f.ack();
  await ready;
  f.ack();
  assert.equal(f.readyCount, 1);
  f.controller.dispose();
});

test("rapid initial and live toggles supersede deadlines without mode, reload, or stale failure", async () => {
  const f = frameFixture({ autoTheme: false });
  await f.start();
  const ready = f.controller.ready();
  await drain();
  const old = f.messages[0].message;
  await f.timers.tick(2000);
  f.controller.setTheme("dark");
  assert.equal(await ready, null);
  f.ack(old);
  assert.equal(f.readyCount, 0);
  await f.timers.tick(1500);
  assert.equal(f.controller.themeSync.status, "pending");
  f.ack();
  assert.equal(f.readyCount, 1);
  const identity = f.controller.identity();
  const execution = f.controller.state.execution;
  f.controller.setTheme("light");
  const intermediate = f.messages.at(-1).message;
  f.controller.setTheme("dark");
  f.ack(intermediate);
  assert.equal(f.controller.themeSync.status, "pending");
  f.ack();
  await f.timers.tick(6000);
  assert.equal(f.controller.themeSync.status, "applied");
  assert.deepEqual(f.controller.identity(), identity);
  assert.equal(f.controller.state.execution, execution);
  assert.equal(f.paths.length, 1);
  assert.equal(f.readyCount, 1);
  assert.ok(f.messages.every(({ message }) => message.type === "eh:setTheme"));
  assert.deepEqual(f.messages.map(({ message }) => message.themeRevision), [1, 2, 3, 4]);
  assert.deepEqual(f.failures, []);
  f.controller.dispose();
});

test("initial theme failure preserves confirmed policy and retry resumes without registration or reload", async () => {
  let confirmations = 0, activations = 0;
  const f = frameFixture({
    autoTheme: false, activated: () => { activations++; },
    request: async (path) => {
      if (path.endsWith("/ready")) {
        confirmations++;
        return { executionMode: "static", savePolicy: "writable", sourceHash: "h" };
      }
      return { renderId: "r", capability: "c", sourceHash: "h", path: "/artifact/r/index.html" };
    },
  });
  await f.start();
  const ready = f.controller.ready();
  await drain();
  const initial = f.messages[0].message;
  const identity = f.controller.identity();
  const execution = f.controller.state.execution;
  await f.timers.tick(3000);
  assert.equal(await ready, null);
  assert.equal(f.controller.themeSync.status, "failed");
  assert.match(f.controller.themeSync.message, /Retry theme without reloading/);
  assert.equal(f.controller.state.phase.kind, "confirming");
  assert.equal(f.controller.state.execution, execution);
  assert.equal(f.controller.state.pendingReload, false);
  await f.timers.tick(20000);
  f.ack(initial);
  assert.equal(f.readyCount, 0);
  assert.equal(f.messages.length, 1);
  const retry = f.controller.retryTheme();
  assert.deepEqual(f.messages.at(-1).message, initial);
  f.ack();
  assert.equal(await retry, true);
  assert.equal(f.readyCount, 1);
  assert.equal(activations, 1);
  assert.equal(confirmations, 1);
  assert.equal(f.paths.length, 1);
  assert.deepEqual({ ...f.controller.identity(), loading: true }, identity);
  assert.equal(f.controller.themeSync.status, "applied");
  assert.deepEqual(f.failures, []);
  f.controller.dispose();
});

test("live timeout retains last applied theme and readiness; retry sends only latest theme", async () => {
  const f = frameFixture();
  await f.start();
  await f.controller.ready();
  const identity = f.controller.identity();
  f.autoTheme = false;
  f.controller.setTheme("dark");
  await f.timers.tick(3000);
  assert.equal(f.controller.themeSync.status, "failed");
  assert.equal(f.controller.themeSync.appliedRevision, 1);
  assert.deepEqual(f.controller.identity(), identity);
  const retry = f.controller.retryTheme();
  f.controller.setTheme("light");
  assert.equal(await retry, false);
  f.ack();
  assert.equal(f.controller.themeSync.status, "applied");
  assert.equal(f.readyCount, 1);
  assert.equal(f.paths.length, 1);
  f.controller.dispose();
});

test("policy confirmation uses the latest selected theme and stale confirmations cannot revive navigation", async () => {
  const policy = deferred();
  const f = frameFixture({ autoTheme: false, request: (path) => path.endsWith("/ready") ? policy.promise :
    Promise.resolve({ renderId: "r", capability: "c", sourceHash: "h", path: "/artifact/r/index.html" }) });
  await f.start();
  const ready = f.controller.ready();
  f.controller.setTheme("dark");
  assert.equal(f.messages.length, 0);
  policy.resolve({ executionMode: "static", savePolicy: "writable" });
  await drain();
  assert.equal(f.messages.at(-1).message.theme, "dark");
  const oldSource = f.source;
  const oldMessage = f.messages.at(-1).message;
  f.controller.begin("next");
  assert.equal(await ready, null);
  f.ack(oldMessage, oldSource);
  assert.equal(f.readyCount, 0);
  assert.equal(f.controller.state.execution, null);
  assert.equal(f.timers.size, 0);
  f.controller.dispose();
});

test("retained iframe has only a theme channel, and removal cancels its deadline and failure", async () => {
  const f = frameFixture();
  await f.start();
  await f.controller.ready();
  await f.controller.configure("view", "writable", false);
  f.controller.configured("view", "writable");
  const oldSource = f.source;
  const oldGeneration = f.controller.state.generation;
  await f.start();
  f.autoTheme = false;
  const ready = f.controller.ready();
  await drain();
  f.controller.setTheme("dark");
  await ready;
  const currentMessage = f.messages.filter((entry) => entry.source === f.source).at(-1).message;
  const previousMessage = f.messages.filter((entry) => entry.source === oldSource).at(-1).message;
  assert.equal(previousMessage.theme, "dark");
  assert.equal(previousMessage.generation, oldGeneration);
  const oldEvent = { source: oldSource, origin: "null", data: { ...previousMessage, type: "eh:edit" } };
  assert.equal(f.controller.accepts(oldEvent), false);
  assert.equal(f.controller.handleThemeMessage(oldEvent), false);
  f.ack(previousMessage, oldSource);
  assert.equal(f.controller.loading, true);
  f.ack(currentMessage);
  assert.equal(f.controller.loading, false);
  f.controller.setTheme("light");
  f.ack();
  await f.timers.tick(3000);
  assert.equal(f.controller.themeSync.status, "failed");
  f.host.finishReplacement();
  assert.equal(f.controller.themeSync.status, "applied");
  assert.equal(f.timers.size, 0);
  f.ack(previousMessage, oldSource);
  assert.equal(f.controller.themeSync.status, "applied");
  f.controller.dispose();
});

test("replacement paints recheck latest theme and exact configuration before handoff", async () => {
  const f = frameFixture();
  const paints = [];
  f.host.afterPaint = (fn) => paints.push(fn);
  await f.start();
  await f.controller.ready();
  await f.controller.configure("view", "writable", false);
  f.controller.configured("view", "writable");
  f.autoTheme = false;
  f.controller.setTheme("dark");
  paints.shift()();
  assert.ok(f.host.previous);
  f.ack();
  assert.equal(paints.length, 1);
  await f.controller.configure("edit", "writable", false);
  paints.shift()();
  assert.ok(f.host.previous);
  f.controller.setTheme("light");
  f.ack();
  assert.equal(paints.length, 0);
  f.controller.configured("edit", "writable");
  paints.shift()();
  assert.equal(f.host.previous, null);
  f.controller.dispose();
});

test("a second replacement retains only the original visible theme channel and cancels all others", async () => {
  const f = frameFixture();
  await f.start();
  await f.controller.ready();
  await f.controller.configure("view", "writable", false);
  f.controller.configured("view", "writable");
  const visible = f.source;
  await f.start();
  await f.controller.ready();
  const removed = f.source;
  f.autoTheme = false;
  f.controller.setTheme("dark");
  const removedMessage = f.messages.findLast((entry) => entry.source === removed).message;
  await f.start();
  const ready = f.controller.ready();
  await drain();
  assert.equal(f.host.previousWindow, visible);
  f.ack(removedMessage, removed);
  assert.equal(f.controller.loading, true);
  f.ack();
  assert.ok(await ready);
  const previousMessage = f.messages.findLast((entry) => entry.source === visible).message;
  f.ack(previousMessage, visible);
  assert.equal(f.controller.themeSync.status, "applied");
  const retry = f.controller.retryTheme();
  f.controller.dispose();
  assert.equal(await retry, false);
  assert.equal(f.timers.size, 0);
});

for (const transition of ["begin", "suspend", "dispose"]) {
  test(`theme waiters and late acknowledgments are canceled by ${transition}`, async () => {
    const f = frameFixture({ autoTheme: false });
    await f.start();
    const ready = f.controller.ready();
    await drain();
    const message = f.messages.at(-1).message;
    const source = f.source;
    const retry = f.controller.retryTheme();
    assert.equal(await ready, null);
    f.controller[transition]();
    assert.equal(await retry, false);
    f.ack(message, source);
    await f.timers.tick(10000);
    assert.equal(f.readyCount, 0);
    assert.equal(f.timers.size, 0);
    assert.deepEqual(f.failures, []);
    f.controller.dispose();
  });
}

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
  let removals = 0;
  host.onPreviousRemoved(() => { removals++; });
  host.onLoad(() => { loads++; });
  host.navigate("/artifact/new/index.html", true);
  assert.equal(host.previous, initial);
  assert.notEqual(host.current, initial);
  assert.equal(host.currentWindow, host.current.contentWindow);
  assert.equal(host.previousWindow, initial.contentWindow);
  host.ready({ executionMode: "interactive", savePolicy: "feedback-only", executionNotice: null });
  assert.equal(host.visibleExecution.savePolicy, "writable");
  initial.dispatchEvent(new dom.window.Event("load"));
  assert.equal(loads, 0);
  host.current.dispatchEvent(new dom.window.Event("load"));
  assert.equal(loads, 1);
  host.finishReplacement();
  assert.equal(initial.isConnected, false);
  assert.equal(host.previousWindow, null);
  assert.equal(removals, 1);
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
