import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { captureSemanticSnapshot } from "../lib/semantic-snapshot.js";
import { serializeDocument, UI_ATTR } from "../lib/serialize.js";

test("shadow block markers never enter source or semantic content", () => {
  const { document } = new JSDOM("<!doctype html><p>Original paragraph</p><button>Authored control</button>").window;
  const source = serializeDocument(document);
  const semantic = captureSemanticSnapshot(document);
  const host = document.createElement("div");
  host.setAttribute(UI_ATTR, "");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = '<div class="block-marker"></div><button class="block-badge">◧ 2</button>';
  document.documentElement.append(host);
  assert.equal(serializeDocument(document), source);
  assert.deepEqual(captureSemanticSnapshot(document), semantic);
  assert.equal(document.querySelector("p").outerHTML, "<p>Original paragraph</p>");
});
