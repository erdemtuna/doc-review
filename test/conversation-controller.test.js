import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fixture, responseFor, editContent } from "./fixtures/agent-loop.js";
import { createConversationController } from "../lib/conversation-controller.js";
import { createSaveController } from "../lib/save-controller.js";
import { createReviewApi } from "../lib/chrome-api.js";

async function controller(t, configure = {}) {
  const f = await fixture(t);
  const target = f.file();
  const opened = await f.open(target);
  const ref = { reviewId: opened.review.reviewId, entryKey: opened.review.entryKey };
  const calls = [];
  let intercept;
  const api = createReviewApi({ token: f.server.token, fetch: async (route, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    calls.push(body);
    const response = await fetch(`http://127.0.0.1:${f.server.port}${route}`, options);
    if (intercept) return intercept(body, response);
    return response;
  } });
  const owner = createConversationController({
    ...ref, request: api.request, barrier: async () => {}, baseline: async () => {},
    navigate: async () => {}, jump() {}, revert: async () => {}, ...configure,
  });
  t.after(() => { owner.dispose(); api.dispose(); });
  await owner.refresh();
  return { f, ref, target, owner, calls, intercept(value) { intercept = value; } };
}
const target = { kind: "element", anchor: { selector: "p", label: "Paragraph" } };
test("empty and whitespace-only drafts retarget and reset permission consistently with Save eligibility", async (t) => {
  const c = await controller(t);
  const other = { kind: "element", anchor: { selector: "h2", label: "Second heading" } };
  c.owner.commands.begin(c.ref.entryKey, target, true);
  c.owner.commands.update("new", { intent: "request-change" });
  c.owner.commands.open(false);
  assert.equal(c.owner.commands.begin(c.ref.entryKey, other, true), true);
  assert.deepEqual(c.owner.getSnapshot().newMessage.target, other);
  assert.equal(c.owner.getSnapshot().newMessage.draft.intent, "discuss");
  c.owner.commands.update("new", { text: " \n\t " });
  await c.owner.commands.saveDraft("new");
  assert.equal(c.calls.filter((body) => body.operation === "create-thread").length, 0);
  c.owner.commands.open(false);
  assert.equal(c.owner.commands.begin(c.ref.entryKey, target, true), true);
  assert.equal(c.owner.getSnapshot().newMessage.draft.text, "");
  c.owner.commands.cancelDraft("new");
  assert.equal(c.owner.commands.begin(c.ref.entryKey, target, true), true);
});

test("dirty and IME drafts survive hiding; cancellation requires explicit discard and preserves caret", async (t) => {
  const c = await controller(t);
  c.owner.commands.begin(c.ref.entryKey, target, true);
  c.owner.commands.update("new", { composing: true, selectionStart: 0, selectionEnd: 0 });
  c.owner.commands.open(false);
  assert.throws(() => c.owner.commands.begin(c.ref.entryKey, target), /Save or cancel/);
  c.owner.commands.cancelDraft("new");
  assert.equal(c.owner.getSnapshot().draftCancellation, null);
  assert.ok(c.owner.getSnapshot().newMessage);
  c.owner.commands.compose();
  c.owner.commands.update("new", { composing: false, text: "Keep this wording", selectionStart: 2, selectionEnd: 7 });
  const before = structuredClone(c.owner.getSnapshot().newMessage);
  c.owner.commands.open(false);
  c.owner.commands.open(true);
  assert.deepEqual(c.owner.getSnapshot().newMessage, before);
  assert.throws(() => c.owner.commands.begin(c.ref.entryKey, target), /Save or cancel/);
  c.owner.commands.cancelDraft("new");
  assert.equal(c.owner.getSnapshot().draftCancellation, "new");
  c.owner.commands.keepEditing();
  assert.deepEqual(c.owner.getSnapshot().newMessage, before);
  c.owner.commands.cancelDraft("new");
  c.owner.commands.discardDraft();
  assert.equal(c.owner.getSnapshot().newMessage, null);
  assert.equal(c.owner.getSnapshot().confirmation, null);
});

test("UX baseline: saving and uncertain acceptance cannot discard or retarget even after clearing text", async (t) => {
  const c = await controller(t);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { started = resolve; });
  let first;
  c.intercept(async (body, response) => {
    if (body.operation === "create-thread" && !first) {
      first = body; started(); await gate;
      throw new TypeError("UX fixture lost accepted save response");
    }
    return response;
  });
  c.owner.commands.begin(c.ref.entryKey, target, true);
  c.owner.commands.update("new", { text: "Accepted original" });
  const saving = c.owner.commands.saveDraft("new");
  await reached;
  c.owner.commands.update("new", { text: "" });
  c.owner.commands.cancelDraft("new");
  assert.ok(c.owner.getSnapshot().newMessage);
  assert.throws(() => c.owner.commands.begin(c.ref.entryKey, target), /Save or cancel/);
  release();
  await assert.rejects(saving, /lost accepted/);
  assert.equal(c.owner.getSnapshot().uncertain.requestId, first.requestId);
  c.owner.commands.cancelDraft("new");
  assert.ok(c.owner.getSnapshot().newMessage);
  assert.equal(c.owner.commands.begin(c.ref.entryKey, target), false);
  await c.owner.commands.reconcile(false);
  const calls = c.calls.filter(body => body.operation === "create-thread");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(c.owner.getSnapshot().threads.length, 1);
  assert.equal(c.owner.getSnapshot().threads[0].latestExchange.reviewer.body, "Accepted original");
  assert.equal(c.owner.getSnapshot().newMessage.draft.text, "");
  assert.equal(c.owner.getSnapshot().uncertain, null);
});

test("contextual and Feedback hosts share one memory draft and reject IME or nonempty retargets", async (t) => {
  const c = await controller(t);
  assert.equal(c.owner.commands.begin(c.ref.entryKey, target, true), true);
  assert.equal(c.owner.getSnapshot().host, "compose");
  c.owner.commands.update("new", { composing: true, selectionStart: 2, selectionEnd: 4 });
  assert.throws(() => c.owner.commands.begin(c.ref.entryKey, target, true), /Save or cancel/);
  c.owner.commands.update("new", { composing: false, text: "One draft" });
  const original = c.owner.getSnapshot().newMessage;
  c.owner.commands.focus(null);
  assert.equal(c.owner.getSnapshot().host, "feedback");
  c.owner.commands.compose(); c.owner.commands.open(false);
  assert.deepEqual(c.owner.getSnapshot().newMessage, original);
  assert.throws(() => c.owner.commands.begin(c.ref.entryKey, target), /Save or cancel/);
  c.owner.commands.compose();
  await c.owner.commands.saveDraft("new");
  assert.equal(c.owner.getSnapshot().newMessage, null);
  assert.equal(c.owner.getSnapshot().threads[0].latestExchange.reviewer.body, "One draft");
  assert.equal(c.owner.getSnapshot().status.work, null);
});
async function draft(c, body, intent = "discuss") {
  c.owner.commands.begin(c.ref.entryKey, target);
  c.owner.commands.update("new", { text: body, intent });
  await c.owner.commands.saveDraft("new");
  return c.owner.getSnapshot().threads[0].thread.threadId;
}

test("reply and saved-edit cancellation compares text and independent permission against the saved baseline", async (t) => {
  const c = await controller(t);
  const id = await draft(c, "Saved baseline", "request-change");
  const message = c.owner.getSnapshot().threads[0].latestExchange.reviewer;
  c.owner.commands.reply(id);
  c.owner.commands.update(id, { text: " \n ", intent: "request-change" });
  c.owner.commands.cancelDraft(id);
  assert.equal(c.owner.getSnapshot().threads[0].draft, null);
  assert.equal(c.owner.getSnapshot().draftCancellation, null);
  c.owner.commands.edit(message);
  c.owner.commands.cancelDraft(id);
  assert.equal(c.owner.getSnapshot().threads[0].draft, null);
  c.owner.commands.edit(message);
  c.owner.commands.update(id, { intent: "discuss", selectionStart: 2, selectionEnd: 5 });
  c.owner.commands.cancelDraft(id);
  assert.equal(c.owner.getSnapshot().draftCancellation, id);
  assert.throws(() => c.owner.commands.edit(message), /Save or cancel/);
  c.owner.commands.keepEditing();
  assert.deepEqual(c.owner.getSnapshot().threads[0].draft, {
    text: message.body, intent: "discuss", selectionStart: 2, selectionEnd: 5, composing: false,
    messageId: message.messageId, messageVersion: message.version,
  });
  c.owner.commands.update(id, { intent: message.intent });
  c.owner.commands.cancelDraft(id);
  assert.equal(c.owner.getSnapshot().threads[0].draft, null);
  c.owner.commands.edit(message);
  c.owner.commands.update(id, { text: "" });
  c.owner.commands.cancelDraft(id);
  assert.equal(c.owner.getSnapshot().draftCancellation, id);
  c.owner.commands.discardDraft();
  assert.equal(c.owner.getSnapshot().threads[0].latestExchange.reviewer.body, "Saved baseline");
  assert.equal(c.owner.getSnapshot().threads[0].latestExchange.reviewer.intent, "request-change");
  assert.equal(c.calls.filter(body => body.operation === "update-message").length, 0);
  c.owner.commands.reply(id);
  assert.equal(c.owner.getSnapshot().threads[0].draft.intent, "discuss");
  c.owner.commands.update(id, { text: "A meaningful reply" });
  c.owner.commands.cancelDraft(id);
  assert.equal(c.owner.getSnapshot().draftCancellation, id);
  c.owner.commands.keepEditing();
  assert.equal(c.owner.getSnapshot().threads[0].draft.text, "A meaningful reply");
});

test("a newer saved-message edit compares cancellation against the exact newly accepted baseline", async (t) => {
  const c = await controller(t);
  const id = await draft(c, "Original");
  c.owner.commands.edit(c.owner.getSnapshot().threads[0].latestExchange.reviewer);
  c.owner.commands.update(id, { text: "Accepted edit", intent: "request-change" });
  let started, release;
  const reached = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  c.intercept(async (body, response) => {
    if (body.operation === "update-message") { started(); await gate; }
    return response;
  });
  const saving = c.owner.commands.saveDraft(id);
  await reached;
  c.owner.commands.update(id, { text: "Newer text", selectionStart: 3, selectionEnd: 7 });
  c.owner.commands.cancelDraft(id);
  assert.equal(c.owner.getSnapshot().draftCancellation, null);
  release(); await saving;
  c.owner.commands.cancelDraft(id);
  assert.equal(c.owner.getSnapshot().draftCancellation, id);
  c.owner.commands.keepEditing();
  c.owner.commands.update(id, { text: "Accepted edit" });
  c.owner.commands.cancelDraft(id);
  assert.equal(c.owner.getSnapshot().threads[0].draft, null);
  assert.equal(c.owner.getSnapshot().threads[0].latestExchange.reviewer.body, "Accepted edit");
});

test("new intent is discuss; shared drafts survive collapse, filters and Focus; Save is not Send", async (t) => {
  const c = await controller(t);
  const id = await draft(c, "A checked question", "request-change");
  assert.equal(c.owner.getSnapshot().threads[0].latestExchange.reviewer.intent, "request-change");
  c.owner.commands.reply(id);
  c.owner.commands.update(id, { text: "Unsaved IME draft", selectionStart: 3, selectionEnd: 7, composing: true });
  c.owner.commands.collapse(id); c.owner.commands.focus(id); c.owner.commands.filter("open"); c.owner.commands.focus(null);
  assert.deepEqual(c.owner.getSnapshot().threads[0].draft, {
    text: "Unsaved IME draft", selectionStart: 3, selectionEnd: 7, composing: true,
    intent: "discuss", messageId: null, messageVersion: null,
  });
  assert.equal(c.owner.getSnapshot().status.work, null);
  c.owner.commands.update(id, { composing: false });
  await c.owner.commands.saveDraft(id);
  assert.equal(c.owner.getSnapshot().threads[0].pendingMessageCount, 2);
  assert.equal(c.owner.getSnapshot().threads[0].draft, null);
});

test("pending selection covers every authorized page and preserves independent overall permission", async (t) => {
  const c = await controller(t);
  const id = await draft(c, "Discuss without editing");
  const other = await c.f.mutate(c.ref, "join-page", { target: c.f.file("second.html") });
  const remote = await c.f.thread(c.ref, { pageKey: other.value.pageKey, body: "Another tab's message" });
  await c.owner.refresh();
  c.owner.commands.update("note", { text: "Change only the footer", intent: "request-change" });
  await c.owner.commands.send();
  const work = await c.f.read(c.ref, "poll");
  assert.equal(work.submission.messages.length, 2);
  assert.deepEqual(new Set(work.submission.messages.map((item) => item.message.threadId)), new Set([id, remote.value.threadId]));
  assert.equal(work.submission.messages.every((item) => item.message.intent === "discuss"), true);
  assert.equal(work.submission.overallNote.intent, "request-change");
  assert.equal(c.owner.getSnapshot().note.intent, "discuss");
});

test("derived selection matches Send versions/exclusions across paginated contexts and edit pages without counting drafts or attention", async (t) => {
  const c = await controller(t);
  const id = await draft(c, "First saved discussion");
  const joined = await c.f.mutate(c.ref, "join-page", { target: c.f.file("counts-other.html") });
  await c.f.thread(c.ref, { pageKey: joined.value.pageKey, body: "Other-page discussion" });
  for (let i = 0; i < 101; i++) await c.f.mutate(c.ref, "reply", { threadId: id, body: `Pending ${i}`, intent: "discuss" });
  for (let i = 0; i < 102; i++) await c.f.mutate(c.ref, "record-edit", {
    pageKey: i % 2 ? joined.value.pageKey : c.ref.entryKey, content: editContent(`Before ${i}`, `After ${i}`),
  });
  await c.owner.refresh();
  const beforeUpdate = c.owner.getSnapshot(), first = beforeUpdate.threads[0].exchanges[0].reviewer, edited = beforeUpdate.edits[1];
  await c.f.mutate(c.ref, "update-message", { threadId: first.threadId, messageId: first.messageId, messageVersion: first.version,
    body: "Updated saved discussion", intent: "discuss" });
  await c.f.mutate(c.ref, "record-edit", { pageKey: edited.pageKey, editId: edited.editId, editVersion: edited.version,
    content: editContent("Before revision", "Latest revision") });
  await c.owner.refresh();
  const loaded = c.owner.getSnapshot(), pending = loaded.threads.flatMap((thread) => thread.exchanges.map(({ reviewer }) => reviewer));
  assert.equal(pending.length, 103);
  assert.equal(loaded.selection.pendingCount, 205);
  assert.equal(pending.find((message) => message.messageId === first.messageId).version, first.version + 1);
  assert.equal(loaded.edits.find((edit) => edit.editId === edited.editId).version, edited.version + 1);
  const omittedMessage = pending[1], omittedEdit = loaded.edits[0];
  c.owner.commands.select(omittedMessage.messageId, false);
  c.owner.commands.select(omittedEdit.editId, false);
  c.owner.commands.reply(id);
  c.owner.commands.update(id, { text: "This memory-only reply is not selected", composing: true });
  c.owner.commands.update("note", { text: "Independent note permission", intent: "request-change" });
  const shown = c.owner.getSnapshot().selection;
  assert.deepEqual(shown, { pendingCount: 205, messages: 102, edits: 101, note: true, total: 204 });
  assert.equal(c.owner.getSnapshot().unsavedMessageDraftCount, 1);
  await c.owner.commands.send();
  const request = c.calls.findLast((body) => body.operation === "send");
  assert.equal(request.messages.length, shown.messages); assert.equal(request.edits.length, shown.edits);
  assert.equal(Number(!!request.overallNote), Number(shown.note));
  assert.deepEqual(request.messages, pending.filter((item) => item.messageId !== omittedMessage.messageId)
    .map(({ threadId, messageId, version }) => ({ threadId, messageId, version })));
  assert.deepEqual(request.edits, loaded.edits.filter((item) => item.editId !== omittedEdit.editId)
    .map(({ pageKey, editId, version }) => ({ pageKey, editId, version })));
  const work = (await c.f.read(c.ref, "poll")).submission;
  assert.ok(work.messages.every(({ message }) => message.intent === "discuss"));
  assert.deepEqual(work.overallNote, { body: "Independent note permission", intent: "request-change" });
  assert.equal(c.owner.getSnapshot().selection.pendingCount, 2);
  assert.equal(c.owner.getSnapshot().selection.total, 0);
  assert.equal(c.owner.getSnapshot().threads.find((item) => item.thread.threadId === id).draft.composing, true);
});

test("note-only selection is independent and counts become unknown during failed reads or disconnection, never false zero", async (t) => {
  const c = await controller(t);
  assert.deepEqual(c.owner.getSnapshot().selection, { pendingCount: 0, messages: 0, edits: 0, note: false, total: 0 });
  c.owner.commands.update("note", { text: "Only a discussion note" });
  assert.deepEqual(c.owner.getSnapshot().selection, { pendingCount: 0, messages: 0, edits: 0, note: true, total: 1 });
  assert.equal(c.owner.getSnapshot().unsavedMessageDraftCount, 0);
  c.owner.commands.connected(false); assert.equal(c.owner.getSnapshot().selection, null);
  c.owner.commands.connected(true);
  const refresh = c.owner.refresh();
  assert.equal(c.owner.getSnapshot().selection, null);
  await refresh;
  c.intercept((body, response) => { if (body.operation === "list") throw new Error("Counts unavailable"); return response; });
  await assert.rejects(c.owner.refresh(), /Counts unavailable/);
  assert.equal(c.owner.getSnapshot().selection, null);
  c.intercept(null);
  await c.owner.refresh();
  assert.equal(c.owner.getSnapshot().selection.total, 1);
  await c.owner.commands.send();
  const request = c.calls.findLast((body) => body.operation === "send");
  assert.deepEqual(request.messages, []); assert.deepEqual(request.edits, []);
  assert.deepEqual(request.pageKeys, [c.ref.entryKey]);
  assert.deepEqual(request.overallNote, { body: "Only a discussion note", intent: "discuss" });
  assert.equal(c.owner.getSnapshot().selection.total, 0);
  assert.equal(c.owner.getSnapshot().sendBlocked, true);
});

test("Send locks before its first asynchronous barrier and submits one logical request", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const c = await controller(t, { barrier: () => gate });
  await draft(c, "Send this once");
  const first = c.owner.commands.send(), second = c.owner.commands.send();
  assert.equal(c.owner.getSnapshot().busy, true);
  release();
  await Promise.all([first, second]);
  assert.equal(c.calls.filter((body) => body.operation === "send").length, 1);
  assert.equal((await c.f.read(c.ref, "status")).work.state, "queued");
  assert.equal(c.owner.getSnapshot().busy, false);
});

for (const action of ["delete", "resolve", "end", "abandon", "revert"]) {
  test(`${action} confirmation locks synchronously and cannot enqueue duplicate mutations`, async (t) => {
    let reverts = 0;
    const c = await controller(t, { revert: async () => { reverts++; await Promise.resolve(); } });
    const threadId = await draft(c, "One confirmed action");
    if (action === "resolve" || action === "abandon") await c.owner.commands.send();
    if (action === "resolve") {
      const work = await c.f.read(c.ref, "poll");
      await c.f.respond(c.ref, responseFor(work.submission));
      await c.owner.refresh();
    }
    const id = action === "abandon" ? c.owner.getSnapshot().status.work.submissionId : threadId;
    c.owner.commands.confirm(action, id);
    const confirmation = c.owner.getSnapshot().confirmation;
    const first = c.owner.commands.confirmAction(), second = c.owner.commands.confirmAction();
    assert.equal(c.owner.getSnapshot().busy, true);
    c.owner.commands.cancelConfirmation();
    assert.equal(c.owner.getSnapshot().confirmation, confirmation);
    await Promise.all([first, second]);
    const operation = { delete: "delete-thread", resolve: "set-thread-status", end: "end", abandon: "abandon" }[action];
    assert.equal(action === "revert" ? reverts : c.calls.filter((body) => body.operation === operation).length, 1);
    assert.equal(c.owner.getSnapshot().confirmation, null);
    assert.equal(c.owner.getSnapshot().busy, false);
  });
}

test("lost Send response retries the same logical request, including after End", async (t) => {
  const c = await controller(t);
  await draft(c, "A durable question");
  let lost;
  c.intercept((body, response) => {
    if (body.operation === "send" && !lost) { lost = body; throw new TypeError("Connection lost after acceptance"); }
    return response;
  });
  await assert.rejects(c.owner.commands.send(), /Connection lost/);
  assert.equal(c.owner.getSnapshot().uncertain.requestId, lost.requestId);
  assert.equal(c.owner.getSnapshot().selection, null);
  assert.equal(c.owner.commands.begin(c.ref.entryKey, target, true), false);
  await c.f.mutate(c.ref, "end", { confirmUnsentReadOnly: true });
  await c.owner.commands.reconcile(false);
  assert.equal(c.owner.getSnapshot().uncertain, null);
  assert.equal(c.owner.getSnapshot().review.state, "ended");
  assert.equal(c.owner.commands.begin(c.ref.entryKey, target, true), false);
  const sent = c.calls.filter((body) => body.operation === "send");
  assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]);
});

test("a receipt miss remains unknown, a newer draft survives accepted replay", async (t) => {
  const c = await controller(t);
  c.owner.commands.begin(c.ref.entryKey, target);
  c.owner.commands.update("new", { text: "Original draft" });
  let release, started;
  const hold = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { started = resolve; });
  c.intercept(async (body, response) => {
    if (body.operation === "create-thread") { await response.text(); started(); await hold; throw new TypeError("Dropped response"); }
    if (body.operation === "receipt") { await response.text(); return new Response(JSON.stringify({ state: "not-found", requestId: body.requestId })); }
    return response;
  });
  const saving = c.owner.commands.saveDraft("new");
  await began;
  c.owner.commands.update("new", { text: "Newer unsent text" });
  release();
  await assert.rejects(saving);
  assert.deepEqual(c.owner.getSnapshot().savingDraftIds, ["new"]);
  c.owner.commands.update("new", { text: "Newer text during reconciliation", selectionStart: 4, selectionEnd: 9 });
  await Promise.all([c.owner.commands.saveDraft("new"), c.owner.commands.saveDraft("new")]);
  assert.equal(c.calls.filter((body) => body.operation === "create-thread").length, 1);
  await c.owner.commands.reconcile(false);
  assert.match(c.owner.getSnapshot().uncertain.message, /remains unknown/);
  c.intercept(async (body, response) => {
    if (body.operation === "receipt") { await response.text(); return new Response(JSON.stringify({ error: "Receipt temporarily inaccessible" }), { status: 403 }); }
    return response;
  });
  await c.owner.commands.reconcile(false);
  assert.ok(c.owner.getSnapshot().uncertain);
  assert.deepEqual(c.owner.getSnapshot().savingDraftIds, ["new"]);
  c.intercept(async (body, response) => {
    if (body.operation === "create-thread") { await response.text(); return new Response(JSON.stringify({ error: "Retry authorization unavailable" }), { status: 403 }); }
    return response;
  });
  await c.owner.commands.reconcile(false);
  assert.ok(c.owner.getSnapshot().uncertain);
  assert.deepEqual(c.owner.getSnapshot().savingDraftIds, ["new"]);
  c.intercept(null);
  await c.owner.commands.reconcile(false);
  assert.equal(c.owner.getSnapshot().newMessage.draft.text, "Newer text during reconciliation");
  assert.equal(c.owner.getSnapshot().newMessage.draft.selectionEnd, 9);
  assert.deepEqual(c.owner.getSnapshot().savingDraftIds, []);
  assert.equal(c.owner.getSnapshot().threads.length, 1);
});

for (const mode of ["new", "reply", "edit"]) {
  test(`${mode} Save locks synchronously, creates one mutation, and retains newer typing`, async (t) => {
    const c = await controller(t);
    let id = "new";
    if (mode === "new") c.owner.commands.begin(c.ref.entryKey, target);
    else {
      id = await draft(c, "Original message");
      if (mode === "reply") c.owner.commands.reply(id);
      else c.owner.commands.edit(c.owner.getSnapshot().threads[0].latestExchange.reviewer);
    }
    c.owner.commands.update(id, { text: "First saved text" });
    const operation = mode === "new" ? "create-thread" : mode === "edit" ? "update-message" : "reply";
    let started, release;
    const began = new Promise((resolve) => { started = resolve; });
    const hold = new Promise((resolve) => { release = resolve; });
    c.intercept(async (body, response) => {
      if (body.operation === operation) { started(); await hold; }
      return response;
    });
    const first = c.owner.commands.saveDraft(id), duplicate = c.owner.commands.saveDraft(id);
    assert.ok(c.owner.getSnapshot().savingDraftIds.includes(id));
    await began;
    c.owner.commands.update(id, { text: "Newer unsent typing", selectionStart: 2, selectionEnd: 6 });
    c.owner.commands.cancelDraft(id);
    release();
    await Promise.all([first, duplicate]);
    const state = c.owner.getSnapshot();
    const retained = mode === "new" ? state.newMessage.draft : state.threads[0].draft;
    assert.equal(retained.text, "Newer unsent typing");
    assert.equal(retained.selectionStart, 2);
    assert.equal(retained.selectionEnd, 6);
    assert.equal(state.threads[0].messageCount, mode === "reply" ? 2 : 1);
    assert.equal(c.calls.filter((body) => body.operation === operation).length, 1);
    assert.deepEqual(state.savingDraftIds, []);
    if (mode === "edit") {
      assert.equal(retained.messageVersion, 2);
      c.intercept(null);
      await c.owner.commands.saveDraft(id);
      assert.equal(c.owner.getSnapshot().threads[0].latestExchange.reviewer.version, 3);
    }
  });
}

async function completeNotes(c, count) {
  for (let index = 0; index < count; index++) {
    await c.f.send(c.ref, [], [], { overallNote: { body: `Note ${index}`, intent: "discuss" } });
    await c.f.ok(responseFor((await c.f.read(c.ref, "poll")).submission));
  }
}
test("empty history reconnects across multiple pages and overlapping loads reach every submission once", async (t) => {
  const c = await controller(t);
  assert.equal(c.owner.getSnapshot().historyCursor, null);
  c.owner.commands.connected(false);
  await completeNotes(c, 55);
  c.owner.commands.connected(true);
  await c.owner.refresh();
  assert.equal(c.owner.getSnapshot().history.length, 50);
  assert.ok(c.owner.getSnapshot().historyCursor);
  c.owner.rememberReadingPosition("inventory", "feedback", 420);
  await Promise.all([c.owner.commands.historyEarlier(), c.owner.commands.historyEarlier(), c.owner.refresh()]);
  let state = c.owner.getSnapshot();
  assert.equal(state.history.length, 55);
  assert.equal(new Set(state.history.map((item) => item.submissionId)).size, 55);
  assert.equal(state.historyCursor, null);
  const oldIds = state.history.map((item) => item.submissionId);
  await completeNotes(c, 55);
  await c.owner.refresh();
  state = c.owner.getSnapshot();
  assert.equal(state.history.length, 110);
  assert.equal(new Set(state.history.map((item) => item.submissionId)).size, 110);
  assert.deepEqual(state.history.slice(-55).map((item) => item.submissionId), oldIds);
  assert.equal(c.owner.readingPosition("inventory", "feedback"), 420);
});
test("refresh updates retained history summaries beyond the newest page", async (t) => {
  const c = await controller(t);
  const first = await c.f.send(c.ref, [], [], { overallNote: { body: "First queued note", intent: "discuss" } });
  await c.owner.refresh();
  assert.equal(c.owner.getSnapshot().history[0].state, "queued");
  await c.f.ok(responseFor((await c.f.read(c.ref, "poll")).submission, { resultNote: "Older late result" }));
  await completeNotes(c, 51);
  await c.owner.refresh();
  const oldest = c.owner.getSnapshot().history.find((item) => item.submissionId === first.value.submissionId);
  assert.equal(oldest.state, "handled");
  assert.equal(oldest.result.body, "Older late result");
  assert.equal(c.owner.getSnapshot().history.length, 52);
});

test("accepted save with failed verification never publishes a stale hash or retries the write; explicit recovery works", async (t) => {
  const c = await controller(t);
  const originalHash = c.owner.pages[0].page.sourceHash;
  await c.owner.recordEdit(c.ref.entryKey, editContent("Original", "Saved once"));
  let accepted = false;
  c.intercept(async (body, response) => {
    if (body.operation === "save-edit") accepted = true;
    else if (accepted) { await response.text(); throw new TypeError("Follow-up reads disconnected"); }
    return response;
  });
  const hashes = [], failures = [];
  const save = createSaveController({
    sessionId: "test", current: () => ({ key: c.ref.entryKey, renderId: "test-render", generation: 1, loading: false }),
    policy: () => "writable", request: async () => { throw new Error("Legacy path must not run"); },
    flush: async () => {}, send() {}, sourceHash: (hash) => hashes.push(hash), pageChanged() {}, conflict() {},
    failed: (message) => failures.push(message), diagnostic() {}, sending: () => false,
    conversation: { record: c.owner.recordEdit, save: c.owner.saveHtml },
  });
  t.after(() => save.dispose());
  save.baseline(originalHash);
  assert.equal(await save.save("<p>Saved once</p>"), false);
  assert.equal(save.getSnapshot().status, "failed");
  assert.deepEqual(hashes, []);
  assert.equal(c.owner.getSnapshot().uncertain, null);
  assert.match(c.owner.getSnapshot().notice, /Refresh failed; do not repeat accepted work/);
  assert.match(failures[0], /Source save accepted .*verification failed/);
  assert.equal(fs.readFileSync(c.target, "utf8"), "<p>Saved once</p>");
  c.intercept(null);
  await assert.rejects(save.barrier(), /not finished saving/);
  assert.equal(c.calls.filter((body) => body.operation === "save-edit").length, 1);
  await c.owner.refresh();
  const recoveredHash = c.owner.pages[0].page.sourceHash;
  assert.notEqual(recoveredHash, originalHash);
  await save.discardLocal(c.ref.entryKey); save.reset(); save.baseline(recoveredHash);
  await c.owner.recordEdit(c.ref.entryKey, editContent("Saved once", "Deliberate next edit"));
  assert.equal(await save.save("<p>Deliberate next edit</p>"), true);
  assert.deepEqual(hashes, [c.owner.pages[0].page.sourceHash]);
  assert.notEqual(hashes[0], recoveredHash);
  assert.equal(c.calls.filter((body) => body.operation === "save-edit").length, 2);
});

test("Resolve pending guards and stale mutations retain the thread and local draft", async (t) => {
  const c = await controller(t);
  const id = await draft(c, "Pending message");
  c.owner.commands.reply(id); c.owner.commands.update(id, { text: "Local only" });
  assert.throws(() => c.owner.commands.confirm("resolve", id), /Save or cancel/);
  c.owner.commands.cancelDraft(id);
  c.owner.commands.discardDraft();
  c.owner.commands.confirm("resolve", id);
  await assert.rejects(c.owner.commands.confirmAction(), /Pending or outstanding/);
  assert.equal(c.owner.getSnapshot().threads[0].thread.status, "open");
  assert.equal(c.owner.getSnapshot().uncertain, null);
  assert.equal(c.owner.getSnapshot().confirmation.action, "resolve");
  c.owner.commands.cancelConfirmation();
  c.owner.commands.reply(id); c.owner.commands.update(id, { text: "Keep me" });
  await c.f.mutate(c.ref, "end", { confirmUnsentReadOnly: true });
  await assert.rejects(c.owner.commands.saveDraft(id), /read-only/);
  assert.equal(c.owner.getSnapshot().threads[0].draft.text, "Keep me");
});

test("earlier context keeps actual associations and all unsent followups are selected", async (t) => {
  const c = await controller(t);
  const id = await draft(c, "First question");
  await c.owner.commands.send();
  const first = (await c.f.read(c.ref, "poll")).submission;
  await c.f.ok(responseFor(first, { responses: first.messages.map(({ message }) => ({
    threadId: message.threadId, messageId: message.messageId, messageVersion: message.version, outcome: "answered", body: "First exact answer",
  })) }));
  for (let index = 0; index < 55; index++) await c.f.mutate(c.ref, "reply", { threadId: id, body: `Follow-up ${index}`, intent: "discuss" });
  await c.owner.refresh();
  assert.equal(c.owner.getSnapshot().threads[0].pendingMessageCount, 55);
  await c.owner.commands.earlier(id);
  const messages = c.owner.getSnapshot().threads[0].exchanges;
  assert.equal(messages.length, 56);
  assert.equal(messages[0].response.body, "First exact answer");
  assert.equal(messages.at(-1).response, null);
  await c.owner.commands.send();
  assert.equal((await c.f.read(c.ref, "poll")).submission.messages.length, 55);
});

test("ended review observes late completion and supports separate confirmed abandonment", async (t) => {
  const c = await controller(t);
  await draft(c, "Question");
  await c.owner.commands.send();
  c.owner.commands.confirm("end"); await c.owner.commands.confirmAction();
  const work = (await c.f.read(c.ref, "poll")).submission;
  await c.f.ok(responseFor(work, { resultNote: "Late result" }));
  await c.owner.refresh();
  assert.equal(c.owner.getSnapshot().review.state, "ended");
  assert.equal(c.owner.getSnapshot().history[0].result.body, "Late result");
  assert.equal(fs.readFileSync(c.target, "utf8"), "<p>Original</p>");
});

test("navigation resolution is read-only and does not join a page", async (t) => {
  const c = await controller(t);
  c.f.file("linked.html", "<p>Linked</p>");
  const session = await c.f.ok({ operation: "read-review", ...c.ref }, "/api/conversation/session");
  const version = (await c.f.read(c.ref)).version;
  const response = await fetch(`http://127.0.0.1:${c.f.server.port}/api/session/${session.sessionId}/resolve-target`, {
    method: "POST", headers: { "content-type": "application/json", "x-doc-review-token": c.f.server.token },
    body: JSON.stringify({ href: "linked.html" }),
  });
  assert.equal(response.status, 200);
  assert.match((await response.json()).target, /linked\.html$/);
  assert.equal((await c.f.read(c.ref)).version, version);
  await c.owner.refresh(); assert.equal(c.owner.getSnapshot().pages.length, 1);
});
