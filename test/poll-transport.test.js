import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createDeadline, DEFAULT_POLL_SECONDS, pollUntilDeadline, requestRaw,
} from "../lib/poll-transport.js";

function fakeClock({ automatic = false } = {}) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const time = {
    now: () => now,
    timers,
    setTimeout(fn, ms) {
      const id = ++nextId;
      timers.set(id, { fn, end: now + ms });
      if (automatic) queueMicrotask(() => {
        if (timers.has(id)) time.advance(timers.get(id).end - now);
      });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.end <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
  return time;
}

const dropped = () => Object.assign(new Error("dropped socket"), { code: "ECONNRESET" });

test("the default deadline is exactly 12 hours including discovery and capped retry sleeps", async () => {
  const time = fakeClock({ automatic: true });
  const deadline = createDeadline(undefined, time);
  let discoveries = 0;
  let polls = 0;
  const result = await pollUntilDeadline({
    target: "review.html", deadline,
    discover: async (received) => {
      assert.equal(received, deadline);
      discoveries++;
      await received.sleep(60 * 60 * 1000);
      return {};
    },
    poll: async () => { polls++; throw dropped(); },
  });
  assert.equal(DEFAULT_POLL_SECONDS, 43200);
  assert.equal(result.status, "timeout");
  assert.equal(result.waited_seconds, 43200);
  assert.equal(time.now(), 43200000);
  assert.equal(discoveries, 12);
  assert.equal(polls, 11);
  assert.equal(time.timers.size, 0);
});

test("an explicit deadline is spent on startup without allowing a subsequent poll", async () => {
  const time = fakeClock({ automatic: true });
  const deadline = createDeadline(0.05, time);
  const result = await pollUntilDeadline({
    target: "review.html", deadline,
    discover: async (received) => {
      await received.sleep(100);
      assert.fail("startup must not outlive the deadline");
    },
    poll: () => assert.fail("no budget for polling"),
  });
  assert.equal(result.waited_seconds, 0.05);
  assert.equal(time.now(), 50);
});

test("retry backoff is bounded by the original explicit deadline", async () => {
  const time = fakeClock({ automatic: true });
  let attempts = 0;
  const result = await pollUntilDeadline({
    target: "review.html", deadline: createDeadline(0.6, time),
    discover: async () => ({}),
    poll: async () => { attempts++; throw dropped(); },
  });
  assert.equal(result.status, "timeout");
  assert.equal(attempts, 2);
  assert.equal(time.now(), 600);
});

test("recovery exceeds three drops, rediscovering and retrying only the exact explicit ack", async () => {
  const time = fakeClock({ automatic: true });
  const acknowledgements = [];
  const servers = [];
  const delays = [];
  let discoveries = 0;
  const deadline = createDeadline(100, time);
  const sleep = deadline.sleep;
  deadline.sleep = (ms) => { delays.push(ms); return sleep(ms); };
  const batch = { status: "feedback", batch_id: "b_new", pages: [] };
  const result = await pollUntilDeadline({
    target: "review.html", ackId: "b_explicit", deadline,
    discover: async () => ({ instance: ++discoveries }),
    poll: async (server, _target, ackId) => {
      servers.push(server.instance);
      acknowledgements.push(ackId);
      if (discoveries < 10) throw dropped();
      return batch;
    },
  });
  assert.equal(result, batch);
  assert.deepEqual(servers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(acknowledgements, Array(10).fill("b_explicit"));
  assert.deepEqual(delays, [250, 500, 1000, 2000, 4000, 5000, 5000, 5000, 5000]);
});

test("unclassified errors are terminal rather than retried for twelve hours", async () => {
  for (const code of ["EACCES", "SERVER_RESPONSE_INVALID", "SERVER_RESPONSE_ERROR", "ABORT_ERR"]) {
    let calls = 0;
    await assert.rejects(pollUntilDeadline({
      target: "review.html",
      discover: async () => { calls++; throw Object.assign(new Error(code), { code }); },
    }), { code });
    assert.equal(calls, 1);
  }
});

function fakeTransport() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const destroy = (emitter) => () => {
    if (emitter.destroyed) return;
    emitter.destroyed = true;
    queueMicrotask(() => emitter.emit("close"));
  };
  req.destroy = destroy(req);
  req.end = () => {};
  res.destroy = destroy(res);
  res.setEncoding = () => {};
  res.complete = false;
  res.statusCode = 200;
  return { req, res, makeRequest: () => req };
}

async function assertClean(transport, time) {
  await Promise.resolve();
  assert.equal(time.timers.size, 0);
  assert.equal(transport.req.destroyed, true);
  assert.equal(transport.res.destroyed, true);
  assert.deepEqual(transport.req.eventNames(), []);
  assert.deepEqual(transport.res.eventNames(), []);
}

for (const event of ["error", "aborted", "close"]) {
  test(`an incomplete response ${event} settles once and cleans up`, async () => {
    const transport = fakeTransport();
    const time = fakeClock();
    const pending = requestRaw({ port: 1 }, {}, undefined, {
      timeoutMs: 100, time, makeRequest: transport.makeRequest,
    });
    transport.req.emit("response", transport.res);
    transport.res.emit("data", '{"status":"feed');
    transport.res.emit(event, dropped());
    await assert.rejects(pending, (err) => ["ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE"].includes(err.code));
    await assertClean(transport, time);
  });
}

test("request errors, response completion, cancellation, and deadline clean their resources", async () => {
  for (const outcome of ["request-error", "end", "cancel", "timeout"]) {
    const transport = fakeTransport();
    const time = fakeClock();
    const controller = new AbortController();
    const pending = requestRaw({ port: 1 }, {}, undefined, {
      timeoutMs: 100, time, makeRequest: transport.makeRequest,
      signal: controller.signal, timeoutCode: "POLL_DEADLINE",
    });
    transport.req.emit("response", transport.res);
    transport.res.emit("data", '{"status":"closed"}');
    if (outcome === "end") {
      transport.res.complete = true;
      transport.res.emit("end");
      assert.deepEqual(await pending, { status: 200, raw: '{"status":"closed"}' });
    } else {
      if (outcome === "request-error") transport.req.emit("error", dropped());
      if (outcome === "cancel") controller.abort();
      if (outcome === "timeout") time.advance(100);
      await assert.rejects(pending, {
        code: { "request-error": "ECONNRESET", cancel: "ABORT_ERR", timeout: "POLL_DEADLINE" }[outcome],
      });
    }
    await assertClean(transport, time);
  }
});

test("response activity does not reset the absolute request deadline", async () => {
  const transport = fakeTransport();
  const time = fakeClock();
  const pending = requestRaw({ port: 1 }, {}, undefined, {
    timeoutMs: 100, time, makeRequest: transport.makeRequest, timeoutCode: "POLL_DEADLINE",
  });
  transport.req.emit("response", transport.res);
  for (let i = 0; i < 4; i++) {
    transport.res.emit("data", " ");
    time.advance(25);
  }
  await assert.rejects(pending, { code: "POLL_DEADLINE" });
  await assertClean(transport, time);
});
