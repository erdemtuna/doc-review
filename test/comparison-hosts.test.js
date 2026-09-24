import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

test("shell preserves the document host without shipping a second legacy Feedback or comparison host", () => {
  const dom = new JSDOM(readFileSync(new URL("../lib/chrome.html", import.meta.url), "utf8"));
  const document = dom.window.document;
  const byId = (id) => document.getElementById(id);
  assert.ok(byId("toolbarRoot").closest(".toolbar"));
  assert.equal(byId("toolbarRoot").contains(byId("frame")), false);
  assert.ok(byId("frame").closest(".document-host"));
  for (const id of ["historyPanel", "drawer", "compose", "alignedCard", "changeDetail"]) assert.equal(byId(id), null);
  assert.equal(document.querySelectorAll("iframe").length, 1);
  assert.equal(document.querySelector('script[type="module"]').getAttribute("src"), "/chrome.js");
  dom.window.close();
});
