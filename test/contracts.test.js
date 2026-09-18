import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { isFrameIdentity, isThemePayload } from "../lib/contracts/frame.js";
import { isPageResponse, isRenderExecution } from "../lib/contracts/page.js";
import { applyBodyReviewMode, keepBodyInReviewMode, normalizeReviewMode, reviewConfiguration, savePolicyForPage } from "../lib/review-mode.js";
import { framePolicy, interactiveFileCsp, TRUSTED_SDK_MODULE_PATHS } from "../lib/frame-policy.js";
import { normalizeCaptureProvenance, normalizeSemanticSnapshot } from "../lib/revision-schema.js";

test("policy helpers normalize raw input without assuming Page", () => {
  for (const input of [undefined, null, false, 0, "", "edit", [], {}]) {
    assert.equal(savePolicyForPage(input), "writable");
    assert.equal(normalizeReviewMode(input), input === "edit" ? "edit" : "view");
  }
  for (const input of [{ markdown: "truthy" }, { feedbackOnly: 1 }, { kind: "url" },
    { savePolicy: "feedback-only" }, Object.create({ markdown: true })]) {
    assert.equal(savePolicyForPage(input), "feedback-only");
  }
  assert.deepEqual(reviewConfiguration({ extra: "allowed", kind: "file" }, "invalid"), {
    mode: "view", savePolicy: "writable",
  });
});

test("page response guard checks envelope without reinterpreting stored feedback", () => {
  const page = {
    key: "page", kind: "file", file: "document.html", filename: "document.html",
    markdown: false, executionMode: "static", savePolicy: "writable", feedbackOnly: false,
    comments: [{ legacy: "unvalidated" }, null], edits: [{ legacy: "unvalidated" }],
    canRevert: true, pollCommand: "doc-review poll document.html", historySupported: true,
  };
  const before = structuredClone(page);
  assert.equal(isPageResponse(page), true);
  assert.deepEqual(page, before);
  assert.equal(isPageResponse({ ...page, extra: "allowed" }), true);
  assert.equal(isPageResponse({ ...page, kind: "url", url: "http://localhost:3000" }), true);
  for (const invalid of [null, [], {}, { ...page, comments: {} }, { ...page, kind: "url" },
    { ...page, executionMode: "unknown" }, { ...page, feedbackOnly: 1 }, { ...page, executionPreference: "interactive" }]) {
    assert.equal(isPageResponse(invalid), false);
  }
  assert.equal(isRenderExecution({ ...page, executionNotice: null }), true);
  assert.equal(isRenderExecution({ ...page, executionNotice: "Feedback only" }), true);
  assert.equal(isRenderExecution(page), false);
});

test("files keep opaque origins while arbitrary URL page metadata keeps its origin", () => {
  const origin = "http://localhost:4321";
  for (const page of [undefined, null, 42, "", {}, { markdown: true }, { kind: "file", arbitrary: 1 }]) {
    assert.deepEqual(framePolicy(page, origin), {
      sandbox: "allow-scripts allow-forms allow-modals", incomingOrigin: "null", targetOrigin: "*",
    });

  }
  assert.deepEqual(framePolicy({ kind: "url", arbitrary: "metadata" }, origin), {
    sandbox: "allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-same-origin",
    incomingOrigin: origin, targetOrigin: origin,
  });
});

test("body mode survives hydration and disconnect stops enforcement", async () => {
  const dom = new JSDOM("<body></body>");
  try {
    const body = dom.window.document.body;
    assert.equal(applyBodyReviewMode(body, "edit"), "edit");
    assert.equal(body.getAttribute("contenteditable"), "true");
    assert.equal(body.getAttribute("spellcheck"), "false");
    const controller = keepBodyInReviewMode(body, "edit");
    body.removeAttribute("contenteditable");
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    assert.equal(body.getAttribute("contenteditable"), "true");
    assert.equal(controller.setMode("unexpected"), "view");
    assert.equal(controller.mode, "view");
    assert.equal(body.hasAttribute("contenteditable"), false);
    assert.equal(body.hasAttribute("spellcheck"), false);
    controller.disconnect();
    body.setAttribute("contenteditable", "true");
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    assert.equal(body.getAttribute("contenteditable"), "true");
  } finally {
    dom.window.close();
  }
});

test("trusted SDK module whitelist stays exact after TypeScript emission", () => {
  assert.deepEqual(TRUSTED_SDK_MODULE_PATHS, [
    "/sdk.js", "/anchor-text.js", "/click-target.js", "/comment-target.js",
    "/editing.js", "/frame-channel.js", "/icons.js", "/review-mode.js",
    "/semantic-snapshot.js", "/serialize.js", "/positioning.js",
    "/revision-schema.js", "/view-identity.js",
  ]);
  assert.ok(Object.isFrozen(TRUSTED_SDK_MODULE_PATHS));
  const csp = interactiveFileCsp("http://localhost:4321");
  for (const route of TRUSTED_SDK_MODULE_PATHS) assert.ok(csp.includes(`http://localhost:4321${route}`));
  assert.ok(!csp.includes("contracts"));
  for (const invalid of ["file:///review", "https://user@example.com", "https://example.com/path",
    "https://example.com/?query", "https://example.com/#hash"]) {
    assert.throws(() => interactiveFileCsp(invalid), TypeError);
  }
});

test("identity validation does not claim payload validation", () => {
  for (const input of [null, undefined, [], "frame", {}, { capability: "c", generation: "1", pageKey: "p" }]) {
    assert.equal(isFrameIdentity(input), false);
  }
  assert.equal(isFrameIdentity({ capability: "c", generation: 1, pageKey: "p", type: "unknown" }), true);
});

test("theme payload requires a recognized theme and positive safe integer revision", () => {
  for (const theme of ["light", "dark"]) {
    assert.equal(isThemePayload({ theme, themeRevision: 1 }), true);
    assert.equal(isThemePayload({ theme, themeRevision: Number.MAX_SAFE_INTEGER }), true);
  }
  for (const theme of [undefined, null, "", "system", {}, 1]) {
    assert.equal(isThemePayload({ theme, themeRevision: 1 }), false);
  }
  for (const themeRevision of [undefined, null, "1", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isThemePayload({ theme: "light", themeRevision }), false);
  }
  for (const value of [null, undefined, "dark", [], {}, { css: "body{color:red}" }]) {
    assert.equal(isThemePayload(value), false);
  }
});

test("snapshot normalization distinguishes raw fields, nullable parent, and persisted provenance", () => {
  const snapshot = normalizeSemanticSnapshot({
    version: 1, blocks: [{ id: "one", tag: "p", text: "Hello", path: "p", attrs: { id: "intro" }, parentId: null }],
  });
  assert.deepEqual(snapshot, {
    version: 1, blocks: [{
      id: "one", tag: "p", text: "Hello", path: ["p"], selector: "",
      attributes: { id: "intro" }, runs: [{ text: "Hello", marks: [] }],
    }], limitations: [],
  });
  assert.deepEqual(normalizeCaptureProvenance({ feedbackOnly: true, feedbackOnlyEdits: "true" }), {
    feedbackOnlyEdits: false,
  });
  assert.deepEqual(normalizeCaptureProvenance({ feedbackOnlyEdits: true, generation: 0 }), {
    generation: 0, feedbackOnlyEdits: true,
  });
});
