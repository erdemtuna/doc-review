import test from "node:test";
import assert from "node:assert/strict";

let sequence = 0;
const freshChannel = () => import(`../lib/frame-channel.js?test=${++sequence}`);

test("frame channel requires initialization, coerces bootstrap values, and initializes once", async () => {
  const channel = await freshChannel();
  assert.throws(() => channel.frameMessage("eh:ready"), /not initialized/);
  assert.equal(channel.matchesFrameMessage({}), false);
  channel.initializeChannel(123, "4", 456);
  assert.deepEqual(channel.frameMessage("eh:ready", {
    capability: "forged", generation: 99, pageKey: "wrong", type: "wrong", scrollHeight: 300,
  }), { type: "eh:ready", capability: "123", generation: 4, pageKey: "456", scrollHeight: 300 });
  assert.throws(() => channel.initializeChannel("new", 5, "new"), /already initialized/);
  assert.deepEqual(channel.frameMessage("eh:clean"), {
    type: "eh:clean", capability: "123", generation: 4, pageKey: "456",
  });
});

test("matching is exact correlation, not a payload or message-type assertion", async () => {
  const channel = await freshChannel();
  channel.initializeChannel("secret", 1, "page");
  const identity = { capability: "secret", generation: 1, pageKey: "page" };
  assert.equal(channel.matchesFrameMessage(identity), true);
  assert.equal(channel.matchesFrameMessage({ ...identity, type: "arbitrary" }), true);
  for (const value of [null, false, "secret", 1, {},
    { ...identity, generation: "1" }, { ...identity, capability: "other" }, { ...identity, pageKey: "other" }]) {
    assert.equal(channel.matchesFrameMessage(value), false);
  }
});

test("document bootstrap is removed before validation and cannot reinitialize a channel", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  let script = null;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { querySelector(selector) {
      assert.equal(selector, "script[data-eh-sdk][data-eh-bootstrap]");
      return script;
    } },
  });
  try {
    const channel = await freshChannel();
    assert.throws(() => channel.initializeChannelFromDocument(), /missing/);
    let removals = 0;
    const bootstrap = (nonce, generation, pageKey) => ({
      nonce, dataset: { generation, pageKey }, remove() { removals++; },
    });
    for (const values of [["", "1", "p"], ["c", "1.5", "p"], ["c", "1", ""], ["c", "NaN", "p"]]) {
      script = bootstrap(...values);
      assert.throws(() => channel.initializeChannelFromDocument(), /invalid/);
    }
    assert.equal(removals, 4);
    script = bootstrap("c", "2", "p");
    channel.initializeChannelFromDocument();
    assert.equal(removals, 5);
    assert.equal(channel.matchesFrameMessage({ capability: "c", generation: 2, pageKey: "p" }), true);
    assert.throws(() => channel.initializeChannelFromDocument(), /already initialized/);
    assert.equal(removals, 6);
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else delete globalThis.document;
  }
});
