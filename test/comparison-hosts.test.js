import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

test("shell preserves permanent comparison, diagnostics and iframe hosts", () => {
  const dom = new JSDOM(readFileSync(new URL("../lib/chrome.html", import.meta.url), "utf8"));
  const document = dom.window.document;
  const byId = (id) => document.getElementById(id);
  assert.ok(byId("toolbarRoot").closest(".toolbar"));
  assert.equal(byId("toolbarRoot").contains(byId("frame")), false);
  assert.equal(byId("noticesRoot").closest(".toolbar"), null);
  assert.ok(byId("frame").closest(".document-host"));
  assert.equal(byId("historyPanel").contains(byId("frame")), false);
  assert.equal(byId("changesNavigationRoot").parentElement, byId("comparisonHeader"));
  assert.equal(document.querySelector(".comparison-heading-slot").parentElement, byId("comparisonHeader"));
  assert.equal(byId("changeDetail").previousElementSibling, byId("comparisonHeader"));
  assert.equal(byId("changeDetail").nextElementSibling, byId("changesDiagnosticsRoot"));
  for (const id of ["changesControlsRoot", "changesNavigationRoot", "changesDiagnosticsRoot", "changeDetail"]) {
    assert.equal(byId(id).childElementCount, 0);
    assert.equal(byId(id).closest("#historyPanel"), byId("historyPanel"));
  }
  assert.ok(byId("drawer").querySelector("#commentsSection"));
  dom.window.close();
});
