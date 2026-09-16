import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { observeView, normalizeView, compareCapturedViews, sameObservedView } from "../src/view-identity.js";

test.beforeEach((t) => t.mock.method(Date, "now", () => 1000));

function document() {
  return new JSDOM(`<nav role="tablist">
    <button id="product" role="tab" aria-selected="true" aria-controls="product-panel">Product</button>
    <button id="screens" role="tab" aria-selected="false" aria-controls="screens-panel">Screens</button>
    </nav><section role="tabpanel" id="product-panel">Product content</section>
    <section role="tabpanel" id="screens-panel" hidden>Screens content</section>`).window.document;
}

test("view identity uses authored tab and panel IDs without requiring a tablist ID", () => {
  const doc = document();
  const view = observeView(doc);
  assert.equal(view.status, "identified");
  assert.equal(view.tabs[0].label, "Product");
  doc.querySelector("#product").textContent = "Updated product label";
  assert.equal(sameObservedView(view, observeView(doc)), true);
  assert.equal(compareCapturedViews(view, observeView(doc)).status, "matched");
});

test("switching panels requests the original tab, not an empty or different comparison", () => {
  const doc = document();
  const before = observeView(doc);
  doc.querySelector("#product").setAttribute("aria-selected", "false");
  doc.querySelector("#screens").setAttribute("aria-selected", "true");
  doc.querySelector("#product-panel").hidden = true;
  doc.querySelector("#screens-panel").hidden = false;
  const after = observeView(doc);
  assert.equal(after.status, "identified");
  assert.equal(sameObservedView(before, after), false);
  assert.deepEqual(compareCapturedViews(before, after), {
    status: "mismatch", message: "Return to Product to capture the result.",
  });
});

test("missing or malformed widget identity is explicit and cannot bypass a known before view", () => {
  const doc = document();
  const before = observeView(doc);
  doc.querySelector("#product").removeAttribute("aria-controls");
  const after = observeView(doc);
  assert.equal(after.status, "unverified");
  assert.equal(compareCapturedViews(before, after).status, "mismatch");
  assert.equal(compareCapturedViews(undefined, after).status, "unverified");
  assert.equal(observeView(new JSDOM("<p>Plain document</p>").window.document).status, "unverified");
});

test("duplicate identifiers, multiple selected tabs, and invisible selected panels are unverified", () => {
  for (const mutate of [
    (doc) => doc.querySelector("#screens").id = "product",
    (doc) => doc.querySelector("#screens").setAttribute("aria-selected", "true"),
    (doc) => doc.querySelector("#product-panel").hidden = true,
  ]) {
    const doc = document();
    mutate(doc);
    assert.equal(observeView(doc).status, "unverified");
  }
});

test("view data is bounded and excludes unrelated payload fields", () => {
  const view = observeView(document());
  assert.deepEqual(normalizeView({ ...view, token: "do not store" }), view);
  assert.throws(() => normalizeView({ ...view, tabs: [...view.tabs, ...view.tabs] }), { code: "INVALID_REVISION" });
  assert.throws(() => normalizeView({ version: 1, status: "unverified", tabs: view.tabs }), { code: "INVALID_REVISION" });
});

test("an exhausted observation budget is explicitly unverified", (t) => {
  const doc = document();
  let calls = 0;
  t.mock.method(Date, "now", () => calls++ === 0 ? 1000 : 2000);
  const result = observeView(doc);
  assert.equal(result.status, "unverified");
  assert.match(result.reason, /limits/);
});
