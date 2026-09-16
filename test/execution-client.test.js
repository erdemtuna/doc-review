import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createExecutionControls, executionPresentation } from "../src/execution-client.js";

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

test("recovery posts preference, coalesces clicks, and leaves reload to the server event", async () => {
  const dom = new JSDOM("<details id='menu' open><summary>More</summary><button id='static'></button><button id='auto'></button></details><p id='status'></p><p id='details'></p><small id='editDescription'></small>");
  const elements = Object.fromEntries(["static", "auto", "status", "details", "editDescription", "menu"]
    .map((id) => [id, dom.window.document.getElementById(id)]));
  const calls = [];
  const changes = [];
  const controls = createExecutionControls({
    elements, sessionId: "session",
    api: async (path, options) => {
      calls.push([path, JSON.parse(options.body)]);
      return { ok: true, page: { key: "a", executionPreference: "static" }, reloadRequired: true };
    },
    changed: (page) => changes.push(page), failed: (error) => assert.fail(error.message),
  });
  controls.render({ key: "a", kind: "file", executionPreference: "auto" },
    { executionMode: "interactive", savePolicy: "feedback-only" }, {});
  elements.static.click();
  elements.static.click();
  assert.equal(elements.menu.open, false);
  assert.equal(dom.window.document.activeElement.tagName, "SUMMARY");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [["/api/session/session/execution", { key: "a", preference: "static" }]]);
  assert.equal(changes.length, 1);
  controls.render({ key: "a", kind: "file", executionPreference: "static" },
    { executionMode: "static", savePolicy: "feedback-only" }, {});
  assert.equal(elements.static.hidden, true);
  assert.equal(elements.auto.hidden, false);
  assert.equal(elements.status.hidden, true);
  assert.match(elements.editDescription.textContent, /agent/);
  controls.render({ key: "live", kind: "url" }, { executionMode: "application", savePolicy: "feedback-only" }, {});
  assert.equal(elements.menu.hidden, true);
  assert.equal(elements.static.hidden, true);
  assert.equal(elements.auto.hidden, true);
  dom.window.close();
});

test("a recovery response for a navigated-away page cannot change the current page", async () => {
  const dom = new JSDOM("<button id='static'></button><button id='auto'></button><p id='status'></p>");
  const elements = Object.fromEntries(["static", "auto", "status"].map((id) =>
    [id, dom.window.document.getElementById(id)]));
  let resolve;
  const controls = createExecutionControls({
    elements, sessionId: "session", api: () => new Promise((yes) => { resolve = yes; }),
    changed: () => assert.fail("stale response"), failed: (error) => assert.fail(error.message),
  });
  controls.render({ key: "a", kind: "file" }, null, {});
  elements.static.click();
  controls.render({ key: "b", kind: "file" }, null, {});
  resolve({ ok: true, page: { key: "a", executionPreference: "static" } });
  await new Promise((done) => setImmediate(done));
  assert.equal(elements.static.disabled, false);
  dom.window.close();
});
