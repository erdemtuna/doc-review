import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { isFrameIdentity, isThemePayload } from "../lib/contracts/frame.js";
import { isPageResponse, isRenderExecution } from "../lib/contracts/page.js";
import { applyBodyReviewMode, keepBodyInReviewMode, normalizeReviewMode, reviewConfiguration, savePolicyForPage } from "../lib/review-mode.js";
import { framePolicy, interactiveFileCsp, TRUSTED_SDK_MODULE_PATHS } from "../lib/frame-policy.js";
import { normalizeCaptureProvenance, normalizeSemanticSnapshot } from "../lib/revision-schema.js";
import * as contract from "../lib/contracts/index.js";
import { MAX_EDIT_CHARACTERS } from "../lib/edit-limits.js";
import { REVISION_LIMITS } from "../lib/revision-schema.js";
import { conversationFixture } from "./fixtures/conversation-contracts.js";
import { readFile } from "node:fs/promises";

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

test("trusted SDK module whitelist stays exact after TypeScript emission", async () => {
  assert.deepEqual(TRUSTED_SDK_MODULE_PATHS, [
    "/sdk.js", "/anchor-text.js", "/click-target.js", "/comment-target.js",
    "/editing.js", "/frame-channel.js", "/icons.js", "/review-mode.js",
    "/semantic-snapshot.js", "/serialize.js", "/positioning.js",
    "/revision-schema.js", "/view-identity.js",
    "/thread-anchor-controller.js", "/contracts/frame.js", "/contracts/feedback.js", "/contracts/validation.js",
  ]);
  assert.ok(Object.isFrozen(TRUSTED_SDK_MODULE_PATHS));
  const csp = interactiveFileCsp("http://localhost:4321");
  for (const route of TRUSTED_SDK_MODULE_PATHS) assert.ok(csp.includes(`http://localhost:4321${route}`));
  assert.ok(!csp.split(/\s+/).includes("http://localhost:4321/contracts/"));
  assert.ok(!csp.includes("/contracts/index.js"));
  for (const route of TRUSTED_SDK_MODULE_PATHS) {
    const source = await readFile(new URL(`../lib${route}`, import.meta.url), "utf8");
    for (const [, dependency] of source.matchAll(/^import\s+(?:[^"';]+?\s+from\s+)?["']([^"']+)["']/gm)) {
      assert.ok(dependency.startsWith("."), `SDK import must be a local immutable module: ${dependency}`);
      const target = new URL(dependency, `http://localhost:4321${route}`).pathname;
      assert.ok(TRUSTED_SDK_MODULE_PATHS.includes(target), `Missing CSP module dependency: ${route} -> ${target}`);
    }
  }
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
function rejectsCode(code, action) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof contract.ContractError);
    assert.equal(error.code, code);
    assert.equal(error.status, contract.ERROR_STATUS[code]);
    return true;
  });
}

test("conversation schemas validate complete fixtures without mutating or borrowing legacy fields", () => {
  const f = conversationFixture();
  for (const [decoder, value] of [
    [contract.reviewSchema, f.review], [contract.conversationThreadSchema, f.thread],
    [contract.reviewerMessageSchema, f.message], [contract.agentMessageSchema, f.reply],
    [contract.directEditSchema, f.edit], [contract.directEditSchema, f.savedEdit],
    [contract.submissionSchema, f.submission], [contract.sendRequestSchema, f.send],
    [contract.completeResponseSchema, f.response], [contract.submissionResultSchema, f.result],
    [contract.handlingReceiptSchema, f.receipt],
  ]) {
    const original = structuredClone(value);
    assert.deepEqual(decoder.parse(value), value);
    assert.deepEqual(value, original);
    rejectsCode("INVALID_INPUT", () => decoder.parse({ ...value, unexpected: true }));
  }
  assert.equal(contract.CONVERSATION_STATE_FILE, "conversation-state.json");
  assert.equal(contract.DEFAULT_REVIEWER_INTENT, "discuss");
  assert.equal(contract.intentBadge("discuss"), "Discussion");
  assert.equal(contract.intentBadge("request-change"), "Change requested");
});

test("absent fields differ from null, undefined, empty, coercible, and server-owned inputs", () => {
  const f = conversationFixture();
  assert.equal(Object.hasOwn(contract.sendRequestSchema.parse(f.send), "overallNote"), false);
  for (const overallNote of [null, undefined, "", { body: "" }, { body: "  ", intent: "discuss" },
    { body: "Note" }, { body: "Note", intent: null }, { body: "Note", intent: "apply" }]) {
    rejectsCode("INVALID_INPUT", () => contract.sendRequestSchema.parse({ ...f.send, overallNote }));
  }
  for (const intent of [undefined, null, true, "Discuss", "applied", ""]) {
    rejectsCode("INVALID_INPUT", () => contract.reviewerMessageSchema.parse({ ...f.message, intent }));
  }
  for (const extra of [{ author: "reviewer" }, { source: f.savedEdit.source }, { version: 1 }, { protocol: 2 }]) {
    rejectsCode("INVALID_INPUT", () => contract.reviewerMutationSchema.parse({
      ...f.base, operation: "record-edit", pageKey: "page", content: f.edit.content, ...extra,
    }));
  }
  rejectsCode("INVALID_INPUT", () => contract.reviewSchema.parse({ ...f.review, endedAt: undefined }));
  rejectsCode("INVALID_INPUT", () => contract.reviewSchema.parse({ ...f.review, state: "ended" }));
  rejectsCode("INVALID_INPUT", () => contract.reviewerMessageSchema.parse({ ...f.message, body: 42 }));
});

test("anchors have exact discriminants and preserve existing UTF-16 bounds without truncation", () => {
  const valid = { kind: "selection", anchor: { quote: "x".repeat(4_000), prefix: "p".repeat(1_000),
    suffix: "", selector: "s".repeat(2_000) } };
  assert.deepEqual(contract.conversationTargetSchema.parse(valid), valid);
  assert.ok(contract.conversationTargetSchema.parse({ kind: "element", anchor: { selector: "p", label: "l".repeat(500) } }));
  for (const target of [null, {}, { kind: "selection", anchor: null }, { kind: "selection", anchor: { selector: "p" } },
    { kind: "element", anchor: { quote: "text" } }, { kind: "element", anchor: { selector: "" } },
    { kind: "other", anchor: { quote: "text" } }, { kind: "selection", anchor: { quote: "text", prefix: null } },
    { kind: "selection", anchor: { quote: "text", body: "leak" } }]) {
    rejectsCode("INVALID_INPUT", () => contract.conversationTargetSchema.parse(target));
  }
  for (const [field, count] of [["quote", 4_001], ["prefix", 1_001], ["suffix", 1_001], ["selector", 2_001]]) {
    rejectsCode("INPUT_TOO_LARGE", () => contract.conversationTargetSchema.parse({
      kind: "selection", anchor: { quote: "text", [field]: "x".repeat(count) },
    }));
  }
  rejectsCode("INPUT_TOO_LARGE", () => contract.conversationTargetSchema.parse({
    kind: "selection", anchor: { quote: "\u{1f600}".repeat(2_001) },
  }));
});

test("JSON request boundaries reject malformed/over-limit data and count actual UTF-8 bytes", () => {
  for (const raw of ["", "{", '{"x":', "undefined"]) {
    rejectsCode("MALFORMED_JSON", () => contract.parseContractJson(raw, contract.openReviewRequestSchema));
  }
  for (const raw of ["null", "[]", "1", "true", "{}"]) {
    rejectsCode("INVALID_INPUT", () => contract.parseContractJson(raw, contract.openReviewRequestSchema));
  }
  const prefix = '{"operation":"open","requestId":"r","target":"';
  const suffix = '"}';
  const exact = prefix + "x".repeat(contract.CONTRACT_LIMITS.requestBytes - prefix.length - suffix.length) + suffix;
  assert.equal(contract.parseContractJson(exact, contract.openReviewRequestSchema).requestId, "r");
  rejectsCode("INPUT_TOO_LARGE", () => contract.parseContractJson(`${exact} `, contract.openReviewRequestSchema));
  for (const value of ["ASCII", "\u00e9", "\u{1f600}", "\ud800", "\udfff"]) {
    assert.equal(contract.utf8Length(value), Buffer.byteLength(value, "utf8"));
  }
});

test("edit safety preserves HTML, move/delete, assets and explicit truncation; no submission count cap", () => {
  const f = conversationFixture();
  assert.equal(contract.CONTRACT_LIMITS.editCodePoints, MAX_EDIT_CHARACTERS);
  const content = { ...f.edit.content, after: "\u{1f600}".repeat(MAX_EDIT_CHARACTERS) };
  assert.equal(contract.directEditContentSchema.parse(content).after, content.after);
  rejectsCode("INPUT_TOO_LARGE", () => contract.directEditContentSchema.parse({ ...content, after: content.after + "a" }));
  for (const kind of ["moved", "deleted"]) {
    const edit = { ...f.edit.content, kind, ...(kind === "moved" ? { moved_after: "Heading", moved_before: "" } : {}) };
    assert.deepEqual(contract.directEditContentSchema.parse(edit), edit);
  }
  rejectsCode("INVALID_INPUT", () => contract.directEditContentSchema.parse({ ...f.edit.content, kind: "moved" }));
  rejectsCode("INVALID_INPUT", () => contract.directEditContentSchema.parse({ ...f.edit.content, truncated: true }));
  rejectsCode("INPUT_TOO_LARGE", () => contract.directEditContentSchema.parse({
    ...f.edit.content, staged_assets: Array.from({ length: 21 }, (_, i) => ({ id: `${i}`, preview_src: `/asset/${i}` })),
  }));
  const many = { ...f.send, messages: Array.from({ length: 1001 }, (_, i) => ({
    threadId: "thread", messageId: `message-${i}`, version: 1,
  })) };
  assert.equal(contract.sendRequestSchema.parse(many).messages.length, 1001);
  assert.deepEqual(REVISION_LIMITS, {
    sourceBytes: 8 * 1024 * 1024, semanticBytes: 4 * 1024 * 1024, totalBytes: 12 * 1024 * 1024,
    blocks: 2_000, textCharacters: 100_000, totalTextCharacters: 1_000_000, runsPerBlock: 1_000,
    depth: 64, attributeCharacters: 4_096, selectorCharacters: 4_096,
  });
  assert.throws(() => normalizeSemanticSnapshot({ version: 1, blocks: [
    { id: "p", tag: "p", text: "x".repeat(100_001) },
  ] }), (error) => error.code === "SNAPSHOT_TOO_LARGE");
});

test("review/page/thread/message/edit scope is shared across tabs, not borrowed across entry reviews", () => {
  const f = conversationFixture();
  contract.validateReviewerMutation(f.send, f.scope, f.items, []);
  rejectsCode("UNAUTHORIZED", () => contract.validateReviewerMutation(f.send, { ...f.scope, authenticated: false }, f.items, []));
  for (const request of [
    { ...f.send, reviewId: "other-review" }, { ...f.send, entryKey: "other-entry" },
    { ...f.send, pageKeys: ["unvisited-by-review"] },
  ]) rejectsCode("SCOPE_MISMATCH", () => contract.validateReviewerMutation(request, f.scope, f.items, []));
  for (const [field, missing] of [["messages", "messageId"], ["edits", "editId"]]) {
    const request = structuredClone(f.send);
    request[field][0][missing] = "unknown";
    rejectsCode("NOT_FOUND", () => contract.validateSendSelection(request, f.scope, f.items));
  }
  const foreign = structuredClone(f.items);
  foreign.messages[0].reviewId = "other-review";
  rejectsCode("SCOPE_MISMATCH", () => contract.validateSendSelection(f.send, f.scope, foreign));
  foreign.messages = f.items.messages;
  foreign.edits[0].reviewId = "other-review";
  rejectsCode("SCOPE_MISMATCH", () => contract.validateSendSelection(f.send, f.scope, foreign));
  rejectsCode("NOT_FOUND", () => contract.assertEntityScope(f.scope, f.base, undefined));
  rejectsCode("SCOPE_MISMATCH", () => contract.assertEntityScope(f.scope, f.base, { reviewId: "another-review" }));
  const submitted = { ...f.items, messages: [f.submission.messages[0].message] };
  rejectsCode("MESSAGE_IMMUTABLE", () => contract.validateSendSelection(f.send, f.scope, submitted));
  rejectsCode("VERSION_CONFLICT", () => contract.validateReviewerMutation({ ...f.send, expectedVersion: 6 }, f.scope, f.items, []));
});

test("End freezes reviewer content while late response and abandonment remain independent", () => {
  const f = conversationFixture();
  const ended = { ...f.review, state: "ended", endedAt: 110, version: 8 };
  const endedScope = { ...f.scope, review: ended };
  for (const request of [f.send,
    { ...f.base, operation: "reply", threadId: f.thread.threadId, body: "Follow up", intent: "discuss" },
    { ...f.base, operation: "set-thread-status", threadId: f.thread.threadId, status: "resolved" },
    { ...f.base, operation: "end", confirmUnsentReadOnly: true }]) {
    rejectsCode("REVIEW_ENDED", () => contract.validateReviewerMutation(request, endedScope, f.items, []));
  }
  assert.ok(contract.validateResponseCoverage(f.response, f.submission));
  assert.ok(contract.validateAbandonment(f.abandon, f.submission));
  assert.ok(contract.pollResponseSchema.parse({ state: "work", review: ended, submission: f.submission }));
  assert.ok(contract.pollResponseSchema.parse({ state: "ended", review: ended }));
  rejectsCode("INVALID_INPUT", () => contract.pollResponseSchema.parse({ state: "waiting", review: ended }));
  rejectsCode("INVALID_INPUT", () => contract.pollResponseSchema.parse({
    state: "work", review: { ...ended, reviewId: "fresh-review" }, submission: f.submission,
  }));
});

test("explicit Resolve/delete guards do not equate replies or abandonment to resolution", () => {
  const f = conversationFixture();
  const resolve = { ...f.base, operation: "set-thread-status", threadId: f.thread.threadId, status: "resolved" };
  rejectsCode("THREAD_BUSY", () => contract.validateReviewerMutation(resolve, f.scope, f.items, []));
  const submittedItems = { ...f.items, messages: [f.submission.messages[0].message] };
  rejectsCode("THREAD_BUSY", () => contract.validateReviewerMutation(resolve, f.scope, submittedItems, [f.submission]));
  const handled = { ...f.submission, version: f.submission.version + 1, state: "handled", completedAt: 120, resultId: f.result.resultId };
  contract.validateReviewerMutation(resolve, f.scope, submittedItems, [handled]);
  assert.equal(f.thread.status, "open");
  rejectsCode("MESSAGE_IMMUTABLE", () => contract.validateReviewerMutation({
    ...f.base, operation: "delete-thread", threadId: f.thread.threadId,
  }, f.scope, submittedItems, [handled]));
  contract.validateReviewerMutation({ ...f.base, operation: "delete-thread", threadId: f.thread.threadId }, f.scope, f.items, []);
});

test("outstanding entry/known-page targets block Send/edit/save/revert, including note-only submissions", () => {
  const f = conversationFixture();
  const noteOnly = { ...f.submission, reviewId: "older-review", entryKey: "other-entry",
    messages: [], edits: [], overallNote: { body: "Discuss this page.", intent: "discuss" },
    exclusionKeys: ["other-entry", "page"] };
  assert.deepEqual(contract.outstandingSubmissions(["page"], [noteOnly]), [noteOnly.submissionId]);
  const writes = [
    f.send,
    { ...f.base, operation: "record-edit", pageKey: "page", content: f.edit.content },
    { ...f.base, operation: "save-edit", pageKey: "page", editId: f.edit.editId, editVersion: 1, expectedSourceHash: "current-source", html: "<p>After</p>" },
    { ...f.base, operation: "revert", pageKey: "page", expectedSourceHash: "current-source", baselineRevisionId: "baseline-1" },
  ];
  for (const request of writes) {
    rejectsCode("WORK_OUTSTANDING", () => contract.validateReviewerMutation(request, f.scope, f.items, [noteOnly]));
  }
  contract.validateReviewerMutation({
    ...f.base, operation: "create-thread", pageKey: "page", target: f.target, body: "Prepare more discussion", intent: "discuss",
  }, f.scope, f.items, [noteOnly]);
  assert.deepEqual(contract.exclusionKeys("entry", ["page", "entry", "page"]), ["entry", "page"]);
  rejectsCode("INVALID_INPUT", () => contract.submissionSchema.parse({ ...noteOnly, exclusionKeys: ["other-entry"] }));
  const abandoned = { ...noteOnly, version: noteOnly.version + 1, state: "abandoned", completedAt: 110, abandonment: { requestId: "a", at: 110, reason: "Stop delivery" } };
  assert.deepEqual(contract.outstandingSubmissions(["page"], [abandoned]), []);
  contract.validateReviewerMutation(f.send, f.scope, f.items, [abandoned]);
});

test("save evidence binds exact edit version, review and current source; revert is review-local", () => {
  const f = conversationFixture();
  contract.validateSaveEvidence(f.savedEdit, "current-source", true);
  for (const [hash, writable] of [["changed", true], ["current-source", false], [null, true]]) {
    rejectsCode("SAVE_EVIDENCE_CONFLICT", () => contract.validateSaveEvidence(f.savedEdit, hash, writable));
  }
  rejectsCode("SAVE_EVIDENCE_CONFLICT", () => contract.directEditSchema.parse({ ...f.savedEdit, version: 2 }));
  const items = { ...f.items, edits: [f.savedEdit] };
  contract.validateSendSelection(f.send, f.scope, items);
  rejectsCode("SAVE_EVIDENCE_CONFLICT", () => contract.validateSendSelection(f.send, f.scope, {
    ...items, sources: [{ ...items.sources[0], sourceHash: "changed-by-another-review" }],
  }));
  const revert = { ...f.base, operation: "revert", pageKey: "page",
    expectedSourceHash: "current-source", baselineRevisionId: "baseline-1" };
  contract.validateReviewerMutation(revert, f.scope, f.items, []);
  rejectsCode("SAVE_EVIDENCE_CONFLICT", () => contract.validateReviewerMutation({
    ...revert, baselineRevisionId: "other-review-baseline",
  }, f.scope, f.items, []));
});

test("complete response requires exact once coverage, scoped versions, bodies and independent overall intent", () => {
  const f = conversationFixture();
  contract.validateResponseCoverage(f.response, f.submission);
  for (const response of [
    { ...f.response, responses: [] }, { ...f.response, editOutcomes: [] },
    { ...f.response, responses: [f.response.responses[0], f.response.responses[0]] },
    { ...f.response, editOutcomes: [f.response.editOutcomes[0], f.response.editOutcomes[0]] },
    { ...f.response, responses: [{ ...f.response.responses[0], threadId: "wrong" }] },
    { ...f.response, responses: [{ ...f.response.responses[0], messageVersion: 2 }] },
    { ...f.response, editOutcomes: [{ ...f.response.editOutcomes[0], editVersion: 2 }] },
    { ...f.response, responses: [{ ...f.response.responses[0], outcome: "applied" }] },
    { ...f.response, overallOutcome: "answered" },
  ]) rejectsCode("RESPONSE_COVERAGE", () => contract.validateResponseCoverage(response, f.submission));
  rejectsCode("INVALID_INPUT", () => contract.validateResponseCoverage({ ...f.response, resultNote: "" }, f.submission));
  rejectsCode("SCOPE_MISMATCH", () => contract.validateResponseCoverage({ ...f.response, reviewId: "other" }, f.submission));
  const withNote = { ...f.submission, overallNote: { body: "Make a change if needed.", intent: "request-change" } };
  rejectsCode("RESPONSE_COVERAGE", () => contract.validateResponseCoverage(f.response, withNote));
  contract.validateResponseCoverage({ ...f.response, overallOutcome: "deferred" }, withNote);
  rejectsCode("RESPONSE_COVERAGE", () => contract.validateResponseCoverage({
    ...f.response, overallOutcome: "applied", responses: [{ ...f.response.responses[0], outcome: "applied" }],
  }, withNote));
  rejectsCode("RESPONSE_COVERAGE", () => contract.validateResponseCoverage({ ...f.response, overallOutcome: "applied" },
    { ...withNote, overallNote: { body: "Discuss only.", intent: "discuss" } }));
  const duplicate = structuredClone(f.submission);
  duplicate.messages.push({ ...duplicate.messages[0], message: { ...duplicate.messages[0].message, messageId: "message-2" } });
  rejectsCode("RESPONSE_COVERAGE", () => contract.validateResponseCoverage({
    ...f.response, responses: [f.response.responses[0], f.response.responses[0]],
  }, duplicate));
  const requested = structuredClone(f.submission);
  requested.messages[0].message.intent = "request-change";
  contract.validateResponseCoverage({ ...f.response, responses: [{ ...f.response.responses[0], outcome: "answered" }] }, requested);
});

test("atomic response artifacts preserve attribution and distinguish saved human edits from agent work", () => {
  const f = conversationFixture();
  assert.deepEqual(contract.validateResponseCommit(f.submission, f.response, f.result, f.receipt), { result: f.result, receipt: f.receipt });
  rejectsCode("RESPONSE_COVERAGE", () => contract.validateResponseCommit(f.submission, f.response,
    { ...f.result, responses: [] }, f.receipt));
  rejectsCode("RESPONSE_COVERAGE", () => contract.validateResponseCommit(f.submission, f.response, f.result,
    { ...f.receipt, value: { ...f.receipt.value, resultId: "another-result" } }));
  const saved = { ...f.submission, edits: [f.savedEdit] };
  const response = { ...f.response, editOutcomes: [{ ...f.response.editOutcomes[0], outcome: "already-saved" }] };
  contract.validateResponseCoverage(response, saved);
  assert.equal(contract.responseEffect(response), "reply-only");
  assert.equal(contract.resultTitle(response), "What changed");
  rejectsCode("SAVE_EVIDENCE_CONFLICT", () => contract.validateResponseCoverage(response, f.submission));
  rejectsCode("SAVE_EVIDENCE_CONFLICT", () => contract.validateResponseCoverage(f.response, saved));
  const truncated = structuredClone(f.submission);
  truncated.edits[0].content.truncated = true;
  truncated.edits[0].content.truncated_fields = ["after"];
  rejectsCode("SAVE_EVIDENCE_CONFLICT", () => contract.validateResponseCoverage(f.response, truncated));
  const deferred = { ...f.response, editOutcomes: [{ ...f.response.editOutcomes[0], outcome: "deferred" }] };
  contract.validateResponseCoverage(deferred, truncated);
  assert.equal(contract.resultTitle(deferred), "Agent response");
});

test("serialized abandonment/completion race is terminal in either order and never claims cancellation", () => {
  const f = conversationFixture();
  contract.validateAbandonment(f.abandon, f.submission);
  rejectsCode("INVALID_INPUT", () => contract.validateAbandonment({ ...f.abandon, confirmExternalWorkMayContinue: false }, f.submission));
  const handled = { ...f.submission, version: f.submission.version + 1, state: "handled", completedAt: 120, resultId: f.result.resultId };
  rejectsCode("ALREADY_HANDLED", () => contract.validateAbandonment(f.abandon, handled));
  const abandoned = { ...f.submission, version: f.submission.version + 1, state: "abandoned", completedAt: 120,
    abandonment: { requestId: f.abandon.requestId, at: 120, reason: f.abandon.reason } };
  rejectsCode("SUBMISSION_ABANDONED", () => contract.validateResponseCoverage(f.response, abandoned));
  assert.equal(contract.submissionSchema.parse(abandoned).messages[0].message.body, f.message.body);
  assert.deepEqual(contract.outstandingSubmissions(["entry"], [abandoned]), []);
});

test("exact replay precedes stale versions, End, exclusions and handled state; changed payload conflicts", () => {
  const f = conversationFixture();
  const previous = { canonicalPayload: contract.canonicalJson(f.response), receipt: f.receipt };
  const reordered = Object.fromEntries(Object.entries(f.response).reverse());
  assert.deepEqual(contract.exactReplay(reordered, previous), f.receipt);
  const handled = { ...f.submission, state: "handled", version: 3, completedAt: 120, resultId: f.result.resultId };
  assert.deepEqual(contract.exactReplay(f.response, previous) ?? contract.validateResponseCoverage(f.response, handled), f.receipt);
  for (const changed of [{ ...f.response, resultNote: "Different" }, { ...f.response, expectedVersion: 3 }]) {
    rejectsCode("REQUEST_CONFLICT", () => contract.exactReplay(changed, previous));
  }
  for (const request of [f.send, { ...f.base, operation: "end", confirmUnsentReadOnly: true },
    { ...f.base, operation: "reply", threadId: f.thread.threadId, body: "Hello", intent: "discuss" }]) {
    const receipt = { ...f.receipt, requestId: request.requestId, operation: request.operation,
      value: { reviewVersion: 8, ...(request.operation === "send" ? { submissionId: "submission-1" } :
        request.operation === "reply" ? { threadId: "thread-1", messageId: "message-2" } : {}) } };
    const old = { canonicalPayload: contract.canonicalJson(request), receipt };
    assert.deepEqual(contract.exactReplay(request, old) ??
      contract.validateReviewerMutation(request, { ...f.scope, review: { ...f.review, version: 9, state: "ended", endedAt: 120 } }, f.items, [f.submission]), receipt);
  }
  assert.equal(contract.exactReplay(f.send, undefined), null);
});

test("transport uncertainty is not rejection or acceptance, including Send/End receipt lookup misses", () => {
  const f = conversationFixture();
  const decoder = contract.transportOutcomeSchema(contract.acceptedMutationSchema);
  for (const reason of ["timeout", "disconnected", "invalid-response", "unavailable"]) {
    assert.deepEqual(decoder.parse({ state: "unknown", requestId: f.send.requestId, reason }),
      { state: "unknown", requestId: f.send.requestId, reason });
  }
  const error = new contract.ContractError("STATE_PERSIST_FAILED", "Atomic write failed.");
  const failure = contract.contractFailure(error);
  assert.equal(failure.error.retryable, true);
  assert.ok(decoder.parse({ state: "rejected", failure }));
  assert.ok(decoder.parse({ state: "accepted", value: { ok: true, receipt: f.receipt } }));
  rejectsCode("INVALID_INPUT", () => decoder.parse({ state: "accepted" }));
  rejectsCode("INVALID_INPUT", () => contract.failureSchema.parse({ ...failure, error: { ...failure.error, status: 200 } }));
  rejectsCode("INVALID_INPUT", () => decoder.parse({ state: "unknown", requestId: "r", reason: "timeout", ok: true }));
  assert.deepEqual(contract.receiptLookupSchema.parse({ state: "not-found", requestId: "r" }), { state: "not-found", requestId: "r" });
  assert.ok(contract.statusObservationSchema.parse({ state: "unknown", reason: "offline" }));
});

test("bounded paging defaults, endpoints, high-water stability and cross-scope cursors", () => {
  const { pagingScope } = conversationFixture();
  const records = Array.from({ length: 121 }, (_, i) => ({ sequence: i + 1 }));
  const first = contract.paginate(records, pagingScope, {}, 121);
  assert.equal(first.items.length, 50);
  assert.equal(first.items[0].sequence, 121);
  assert.equal(first.totalCount, 121);
  const next = contract.paginate([...records, { sequence: 122 }], pagingScope, { cursor: first.nextCursor, limit: 100 }, 122);
  assert.equal(next.items.length, 71);
  assert.equal(next.nextCursor, null);
  assert.equal(next.totalCount, 121);
  assert.equal(new Set([...first.items, ...next.items].map((item) => item.sequence)).size, 121);
  assert.equal(contract.paginate(records, pagingScope, { limit: 1 }, 121).items.length, 1);
  assert.equal(contract.paginate(records, pagingScope, { limit: 100 }, 121).items.length, 100);
  assert.deepEqual(contract.paginate([], pagingScope, {}, 0), { items: [], nextCursor: null, totalCount: 0, highWater: 0 });
  for (const limit of [0, 101, 1.5, "50", null, undefined]) {
    rejectsCode("INVALID_INPUT", () => contract.paginate(records, pagingScope, { limit }, 121));
  }
  for (const cursor of ["garbage", "{}", JSON.stringify({ scope: pagingScope, highWater: 2, before: 3 })]) {
    rejectsCode("INVALID_CURSOR", () => contract.paginate(records, pagingScope, { cursor }, 121));
  }
  for (const changed of [{ ...pagingScope, reviewId: "other" }, { ...pagingScope, pageKey: "page" }, { ...pagingScope, status: "all" }]) {
    rejectsCode("INVALID_CURSOR", () => contract.paginate(records, changed, { cursor: first.nextCursor }, 121));
  }
  rejectsCode("INPUT_TOO_LARGE", () => contract.pagedSchema(contract.object({ sequence: contract.integer(1) })).parse({
    items: records, nextCursor: null, totalCount: records.length, highWater: 121,
  }));
});

test("latest/context projections associate actual exchanges, never an old reply with a new follow-up", () => {
  const f = conversationFixture();
  const reviewer = f.submission.messages[0].message;
  const followup = { ...f.message, messageId: "followup", sequence: 8, body: "New question" };
  const latest = contract.latestExchange([reviewer, followup], [f.reply]);
  assert.equal(latest.reviewer.messageId, "followup");
  assert.equal(latest.response, null);
  const scope = { ...f.pagingScope, collection: "context", threadId: f.thread.threadId, status: "all" };
  const first = contract.contextWindow([reviewer, followup], [f.reply], scope, { limit: 1 }, 8);
  assert.equal(first.items[0].reviewer.messageId, "followup");
  const laterReply = { ...f.reply, messageId: "later", sequence: 9, replyToMessageId: "followup" };
  const earlier = contract.contextWindow([reviewer, followup], [f.reply, laterReply], scope, { cursor: first.nextCursor }, 9);
  assert.equal(earlier.items[0].response.messageId, f.reply.messageId);
  assert.equal(earlier.nextCursor, null);
  const all = contract.contextWindow([reviewer, followup], [f.reply], scope, {}, 8);
  assert.deepEqual(all.items.map((item) => item.sequence), [2, 8]);
  rejectsCode("INVALID_INPUT", () => contract.exchangeSchema.parse({ sequence: 8, reviewer: followup, response: f.reply }));
  rejectsCode("SCOPE_MISMATCH", () => contract.contextWindow([reviewer], [f.reply], { ...scope, threadId: "other" }, {}, 8));
});

test("frame projections carry only anchor metadata/current geometry, never messages or API credentials", () => {
  const f = conversationFixture();
  const projection = { type: "eh:threadAnchors", capability: "frame-only-capability", reviewId: f.review.reviewId, pageKey: "page", renderId: "render",
    generation: 1, projectionRevision: 1, anchors: [{ threadId: f.thread.threadId, target: f.target }] };
  assert.ok(contract.frameAnchorsSchema.parse(projection));
  for (const extra of [{ body: "secret" }, { apiToken: "secret" }, { messages: [f.message] }]) {
    rejectsCode("INVALID_INPUT", () => contract.frameAnchorsSchema.parse({ ...projection, ...extra }));
    rejectsCode("INVALID_INPUT", () => contract.frameAnchorsSchema.parse({
      ...projection, anchors: [{ ...projection.anchors[0], ...extra }],
    }));
  }
  const base = { ...projection, type: "eh:threadAnchorStates" };
  for (const state of [
    { state: "found", rects: [{ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }],
      viewport: { width: 100, height: 100 }, relation: "visible" },
    { state: "missing" }, { state: "ambiguous", candidateCount: 2 },
    { state: "unavailable", reason: "render-loading" },
  ]) {
    const states = { ...base, anchors: [{ threadId: f.thread.threadId, ...state }] };
    assert.ok(contract.validateFrameAnchorStates(states, projection));
    rejectsCode("SCOPE_MISMATCH", () => contract.validateFrameAnchorStates({ ...states, generation: 2 }, projection));
  }
  rejectsCode("INVALID_INPUT", () => contract.anchorStateSchema.parse({ threadId: "t", state: "ambiguous", candidateCount: 1 }));
  rejectsCode("INVALID_INPUT", () => contract.conversationRectSchema.parse({ left: NaN, top: 0, right: 1, bottom: 1, width: 1, height: 1 }));
});

test("read outputs cannot claim partial completion or attach a result from another submission", () => {
  const f = conversationFixture();
  assert.ok(contract.submissionReadSchema.parse({ submission: f.submission, result: null, receipt: null }));
  const handled = { ...f.submission, version: f.submission.version + 1, state: "handled", completedAt: 106, resultId: f.result.resultId };
  const full = { submission: handled, result: f.result, receipt: f.receipt };
  assert.deepEqual(contract.submissionReadSchema.parse(full), full);
  rejectsCode("INVALID_INPUT", () => contract.submissionReadSchema.parse({
    ...full, submission: { ...handled, version: 1 },
  }));
  rejectsCode("RESPONSE_COVERAGE", () => contract.submissionReadSchema.parse({ ...full, result: null }));
  rejectsCode("RESPONSE_COVERAGE", () => contract.submissionReadSchema.parse({ ...full, receipt: null }));
  rejectsCode("RESPONSE_COVERAGE", () => contract.submissionReadSchema.parse({ ...full, result: { ...f.result, responses: [] } }));
  rejectsCode("RESPONSE_COVERAGE", () => contract.submissionReadSchema.parse({
    ...full, result: { ...f.result, submissionId: "another-submission" },
  }));
  rejectsCode("INVALID_INPUT", () => contract.submissionReadSchema.parse({ ...full, submission: f.submission }));
  const historyItem = {
    sequence: 4, reviewId: f.review.reviewId, submissionId: f.submission.submissionId, createdAt: 104, state: "handled",
    result: { resultId: f.result.resultId, body: f.result.body, createdAt: 106, title: f.result.title, effect: f.result.effect },
    comparisonStatus: "failed", comparisonCount: 1,
  };
  assert.ok(contract.submissionHistoryItemSchema.parse(historyItem));
  rejectsCode("INVALID_INPUT", () => contract.submissionHistoryItemSchema.parse({
    ...historyItem, result: { ...historyItem.result, responses: f.result.responses },
  }));
  assert.ok(contract.threadSummarySchema.parse({
    thread: f.thread, sequence: f.thread.sequence, messageCount: 1, pendingMessageCount: 1,
    latestExchange: contract.latestExchange([f.message], []),
  }));
});

test("page output validates requested size, actual order and cursor continuation", () => {
  const f = conversationFixture();
  const decoder = contract.object({ sequence: contract.integer(1) });
  const records = [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }];
  const first = contract.paginate(records, f.pagingScope, { limit: 2 }, 3);
  assert.deepEqual(contract.validatePageOutput(first, decoder, f.pagingScope, { limit: 2 }), first);
  rejectsCode("INVALID_INPUT", () => contract.validatePageOutput(first, decoder, f.pagingScope, { limit: 1 }));
  rejectsCode("INVALID_INPUT", () => contract.validatePageOutput({
    ...first, items: [...first.items].reverse(),
  }, decoder, f.pagingScope, { limit: 2 }));
  rejectsCode("INVALID_CURSOR", () => contract.validatePageOutput({
    ...first, nextCursor: contract.encodePageCursor({ scope: f.pagingScope, highWater: 3, before: 1 }),
  }, decoder, f.pagingScope, { limit: 2 }));
  rejectsCode("INVALID_INPUT", () => contract.conversationListRequestSchema.parse({
    operation: "list", scope: { ...f.pagingScope, collection: "context" }, query: {},
  }));
  rejectsCode("INVALID_INPUT", () => contract.conversationListRequestSchema.parse({
    operation: "list", scope: { ...f.pagingScope, collection: "comparisons", status: "all" }, query: {},
  }));
  const contextScope = { ...f.pagingScope, collection: "context", threadId: f.thread.threadId, status: "all" };
  const original = f.submission.messages[0].message;
  const followup = { ...f.message, messageId: "followup", sequence: 8 };
  const window = contract.contextWindow([original, followup], [], contextScope, { limit: 1 }, 8);
  const late = { ...f.reply, sequence: 9 };
  const older = contract.contextWindow([original, followup], [late], contextScope, { cursor: window.nextCursor }, 9);
  assert.equal(older.items[0].response, null);
  const refreshed = contract.contextWindow([original, followup], [late], contextScope, {}, 9);
  assert.equal(refreshed.items[0].response.messageId, late.messageId);
});

test("new command schemas exclude ack, caller attribution and ambiguous edit updates", () => {
  const f = conversationFixture();
  rejectsCode("INVALID_INPUT", () => contract.reviewerMutationSchema.parse({ ...f.base, operation: "ack" }));
  rejectsCode("INVALID_INPUT", () => contract.completeResponseSchema.parse({
    ...f.base, operation: "respond", submissionId: f.submission.submissionId,
  }));
  const join = { ...f.base, operation: "join-page", target: "C:\\fixture\\another.html" };
  assert.ok(contract.validateReviewerMutation(join, f.scope, f.items, []));
  rejectsCode("REVIEW_ENDED", () => contract.validateReviewerMutation(join,
    { ...f.scope, review: { ...f.review, state: "ended", endedAt: 110 } }, f.items, []));
  rejectsCode("INVALID_INPUT", () => contract.validateReviewerMutation({
    ...f.base, operation: "record-edit", pageKey: "page", editId: f.edit.editId, content: f.edit.content,
  }, f.scope, f.items, []));
  rejectsCode("NOT_FOUND", () => contract.validateReviewerMutation({
    ...f.base, operation: "reply", threadId: "unknown", body: "Question", intent: "discuss",
  }, f.scope, f.items, []));
  const twoEdits = { ...f.submission, edits: [f.edit, { ...f.edit, editId: "edit-2" }] };
  rejectsCode("RESPONSE_COVERAGE", () => contract.validateResponseCoverage({
    ...f.response, editOutcomes: [f.response.editOutcomes[0], f.response.editOutcomes[0]],
  }, twoEdits));
});

test("strict decoders reject sparse arrays, inherited records and corrupted replay receipts", () => {
  rejectsCode("INVALID_INPUT", () => contract.array(contract.id).parse(new Array(1)));
  rejectsCode("INVALID_INPUT", () => contract.canonicalJson(new Array(1)));
  const f = conversationFixture();
  rejectsCode("INVALID_INPUT", () => contract.openReviewRequestSchema.parse(Object.create({
    operation: "open", requestId: "r", target: "target",
  })));
  rejectsCode("INVALID_INPUT", () => contract.handlingReceiptSchema.parse({
    ...f.receipt, operation: "end",
  }));
  rejectsCode("INVALID_INPUT", () => contract.exactReplay(f.response, {
    canonicalPayload: contract.canonicalJson(f.response), receipt: { ...f.receipt, reviewId: "wrong-review" },
  }));
  const projection = {
    type: "eh:threadAnchors", capability: "frame-only", reviewId: f.review.reviewId, pageKey: "page", renderId: "render",
    generation: 1, projectionRevision: 1, anchors: [{ threadId: f.thread.threadId, target: f.target }],
  };
  rejectsCode("SCOPE_MISMATCH", () => contract.validateFrameAnchorStates({
    ...projection, type: "eh:threadAnchorStates", capability: "stale", anchors: [{ threadId: f.thread.threadId, state: "missing" }],
  }, projection));
});

test("currently served page guards remain self-contained until producer integration", async () => {
  const source = await readFile(new URL("../lib/contracts/page.js", import.meta.url), "utf8");
  const standalone = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  assert.equal(standalone.isPageResponse({}), false);
  assert.equal(standalone.isExecutionPolicy({
    executionMode: "static", savePolicy: "writable", feedbackOnly: false,
  }), true);
});
