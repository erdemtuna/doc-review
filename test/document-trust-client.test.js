import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createDocumentTrustControls } from "../src/document-trust-client.js";

const page = { key: "a", kind: "file", filename: "test.html" };
const trust = (approved = false, sourceHash = "hash-a") => ({ approved, sourceHash });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(handler) {
  const dom = new JSDOM("<div id='controls'></div>");
  const root = dom.window.document.querySelector("#controls");
  const calls = [], changes = [], errors = [];
  const controls = createDocumentTrustControls({
    sessionId: "session",
    container: root,
    api: async (url, options) => {
      const request = options ? JSON.parse(options.body) : null;
      calls.push(request);
      return handler ? handler(request) : { trust: trust() };
    },
    onChanged: (result) => changes.push(result),
    onError: (error) => errors.push(error),
  });
  return { ...controls, root, dom, calls, changes, errors, button: root.querySelector("[role=switch]") };
}

test("checking, refresh, focus and hover never approve; unsupported targets hide the control", async () => {
  const pending = deferred();
  const ui = setup(() => pending.promise);
  const loading = ui.refresh(page);
  assert.equal(ui.button.getAttribute("aria-disabled"), "true");
  assert.match(ui.root.querySelector("#scriptStatus").textContent, /Checking/);
  pending.resolve({ trust: trust() });
  await loading;
  ui.button.focus();
  ui.button.dispatchEvent(new ui.dom.window.MouseEvent("mouseover"));
  await ui.refresh(page);
  assert.ok(ui.calls.every((request) => request === null));
  assert.equal(ui.root.querySelector("dialog"), null);
  assert.equal(ui.button.getAttribute("aria-disabled"), "false");
  for (const target of [{ ...page, markdown: true }, { key: "url", kind: "url" }]) {
    await ui.refresh(target);
    assert.equal(ui.root.hidden, true);
    assert.equal(ui.button.getAttribute("aria-disabled"), "true");
  }
  assert.equal(ui.calls.length, 2);
});

test("one deliberate activation sends the exact hash; busy clicks cannot duplicate it", async () => {
  const pending = deferred();
  let saved = trust();
  const ui = setup((request) => request ? pending.promise : { trust: saved });
  await ui.refresh(page);
  ui.button.click();
  ui.button.click();
  assert.deepEqual(ui.calls.filter(Boolean), [{ action: "grant", key: "a", sourceHash: "hash-a" }]);
  assert.equal(ui.button.getAttribute("aria-disabled"), "true");
  assert.equal(ui.button.getAttribute("aria-checked"), "false");
  saved = trust(true);
  pending.resolve({ trust: saved, page });
  await tick();
  assert.equal(ui.button.getAttribute("aria-checked"), "true");
  assert.equal(ui.button.getAttribute("aria-disabled"), "false");
  assert.deepEqual(ui.changes, [page]);
});

test("rechecking a known version disables activation without flickering its switch off", async () => {
  const pending = deferred();
  let checking = false;
  const ui = setup(() => checking ? pending.promise : { trust: trust(true) });
  await ui.refresh(page);
  checking = true;
  const refresh = ui.refresh(page);
  assert.equal(ui.button.getAttribute("aria-disabled"), "true");
  assert.equal(ui.button.getAttribute("aria-checked"), "true");
  assert.equal(ui.button.querySelector(".script-switch-value").textContent, "On");
  pending.resolve({ trust: trust(true) });
  await refresh;
  assert.equal(ui.button.getAttribute("aria-disabled"), "false");
});

test("saved permission never conceals scripts running in a retained older frame", async () => {
  let saved = trust(true);
  const ui = setup((request) => {
    if (request) saved = trust(false);
    return { trust: saved, page };
  });
  await ui.refresh(page);
  ui.setRenderState({ sourceHash: "hash-a", trustedInteractive: true });
  ui.button.click();
  await tick();
  assert.equal(ui.button.getAttribute("aria-checked"), "false");
  assert.match(ui.root.querySelector("#scriptStatus").textContent, /still running/);
  ui.setRenderState({ sourceHash: "hash-a", trustedInteractive: false });
  assert.equal(ui.root.querySelector("#scriptStatus").hidden, true);
});

test("changed bytes reset the switch and explain renewed approval even while reload is held", async () => {
  let saved = trust(true);
  const ui = setup(() => ({ trust: saved }));
  await ui.refresh(page);
  ui.setRenderState({ sourceHash: "hash-a", trustedInteractive: true, pendingReload: true });
  saved = trust(false, "hash-b");
  await ui.refresh(page);
  assert.equal(ui.button.getAttribute("aria-checked"), "false");
  assert.match(ui.root.textContent, /File changed - enable again/);
  assert.match(ui.root.textContent, /still running/);
});

test("failed grant and revoke reconcile server state and require a new explicit activation", async () => {
  for (const approved of [false, true]) {
    const ui = setup((request) => {
      if (request) throw new Error("Connection lost");
      return { trust: trust(approved) };
    });
    await ui.refresh(page);
    ui.button.click();
    await tick();
    assert.equal(ui.button.getAttribute("aria-checked"), String(approved));
    assert.equal(ui.button.getAttribute("aria-disabled"), "false");
    assert.match(ui.root.querySelector("#scriptError").textContent, /Connection lost/);
    assert.equal(ui.calls.filter(Boolean).length, 1);
    ui.root.querySelector(".script-retry").click();
    await tick();
    assert.equal(ui.calls.filter(Boolean).length, 1);
    assert.equal(ui.root.querySelector("#scriptError").hidden, true);
    assert.equal(ui.errors.length, 1);
  }
});

test("stale hash failure refreshes the version but never silently grants the new hash", async () => {
  let saved = trust();
  const ui = setup((request) => {
    if (request) {
      saved = trust(false, "hash-b");
      throw new Error("Source changed; check again");
    }
    return { trust: saved };
  });
  await ui.refresh(page);
  ui.button.click();
  await tick();
  assert.equal(ui.button.getAttribute("aria-checked"), "false");
  assert.match(ui.root.textContent, /File changed - enable again/);
  assert.equal(ui.calls.filter(Boolean).length, 1);
  assert.equal(ui.calls.find(Boolean).sourceHash, "hash-a");
});

test("refresh failure disables stale permission and exposes a check-only recovery", async () => {
  let fail = false;
  const ui = setup(() => {
    if (fail) throw new Error("Offline");
    return { trust: trust(true) };
  });
  await ui.refresh(page);
  fail = true;
  await ui.refresh(page);
  assert.equal(ui.button.getAttribute("aria-disabled"), "true");
  assert.equal(ui.button.querySelector(".script-switch-value").textContent, "-");
  ui.button.click();
  assert.equal(ui.calls.filter(Boolean).length, 0);
  fail = false;
  ui.root.querySelector(".script-retry").click();
  await tick();
  assert.equal(ui.button.getAttribute("aria-disabled"), "false");
  assert.equal(ui.button.getAttribute("aria-checked"), "true");
});

test("navigation rejects stale refreshes and mutations, including navigating back to the same key", async () => {
  const pending = deferred();
  let getCount = 0;
  const ui = setup((request) => request || ++getCount === 1 ? pending.promise : { trust: trust(false, "hash-b") });
  const first = ui.refresh(page);
  await ui.refresh({ ...page, key: "b" });
  pending.resolve({ trust: trust(true) });
  await first;
  assert.equal(ui.button.getAttribute("aria-checked"), "false");

  const write = deferred();
  const mutation = setup((request) => request ? write.promise : { trust: trust() });
  await mutation.refresh(page);
  mutation.button.click();
  await mutation.refresh({ ...page, key: "b" });
  await mutation.refresh(page);
  write.resolve({ trust: trust(true), page });
  await tick();
  assert.equal(mutation.button.getAttribute("aria-checked"), "false");
  assert.equal(mutation.changes.length, 0);
});
