import { openResponse, mutate, read, list, content, send, request as conversationRequest } from "./fixtures/review.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";

const root = path.resolve(`.execution-api-tests-${process.pid}`);
fs.mkdirSync(root, { recursive: true });
process.env.DOC_REVIEW_STATE_DIR = path.join(root, "state");
const { start } = await import("../lib/server.js");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const hash = (source) => crypto.createHash("sha1").update(source).digest("hex");

async function api(review, route, body, options = {}) {
  const response = await fetch(`http://127.0.0.1:${review.port}${route}`, {
    method: options.method || (body === undefined ? "GET" : "POST"),
    headers: { "x-doc-review-token": review.token, "content-type": "application/json", ...options.headers },
    ...(body === undefined ? {} : { body: options.raw ? body : JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function fixture(t, name, source = "<p>Original</p>") {
  const file = path.join(root, name);
  fs.writeFileSync(file, source);
  const review = await start();
  t.after(() => review.dispose());
  return { review, file, session: await open(review, file) };
}

async function open(review, file) {
  const result = await openResponse(review, file);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function saveAttempt(review, session, before, after, expectedSourceHash, extra = {}) {
  const recorded = await mutate(review, session, "record-edit", {
    pageKey: session.key, content: content(before, after, extra.content),
  });
  return conversationRequest(review, {
    operation: "save-edit", reviewId: session.reviewId, entryKey: session.entryKey,
    requestId: crypto.randomUUID(), expectedVersion: (await read(review, session)).version,
    pageKey: session.key, editId: recorded.value.editId, editVersion: 1,
    expectedSourceHash, html: extra.html ?? `<p>${after}</p>`,
  });
}

function controlSourceWatcher(t, file) {
  const watchFile = fs.watchFile;
  let notify;
  t.mock.method(fs, "watchFile", function (target, options, listener) {
    if (path.resolve(target) !== path.resolve(file)) return watchFile.call(this, target, options, listener);
    notify = listener;
  });
  return () => {
    assert.equal(typeof notify, "function", "the server registered its source watcher");
    notify();
  };
}

async function frame(review, session, generation = 1, beforeReady) {
  const registration = await api(review, `/api/session/${session.sessionId}/render`, { key: session.key, generation });
  assert.equal(registration.status, 200, JSON.stringify(registration.body));
  const render = registration.body;
  const response = await fetch(`http://127.0.0.1:${review.port}${render.path}`);
  const html = await response.text();
  assert.equal(response.status, 200, html);
  await beforeReady?.();
  const ready = await api(review, `/api/session/${session.sessionId}/render/${render.renderId}/ready`, {
    pageKey: session.key, generation, capability: render.capability,
  });
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  return {
    ...render, html, csp: response.headers.get("content-security-policy"), ready: ready.body,
    identity: { sessionId: session.sessionId, renderId: render.renderId, generation, baseHash: ready.body.sourceHash },
  };
}

test("automatic inline execution, application bounds, Markdown, and served-byte metadata", async (t) => {
  const source = "<p>Original</p><button onclick='run()'>Run</button><script>function run(){}</script>";
  const notifySourceChange = controlSourceWatcher(t, path.join(root, "automatic.html"));
  const { review, file, session } = await fixture(t, "automatic.html", source);
  const page = (await api(review, `/api/session/${session.sessionId}/page`)).body.page;
  assert.equal(page.executionMode, "interactive");
  assert.equal(page.executionPreference, "auto");
  assert.equal(page.savePolicy, "feedback-only");
  assert.equal(page.feedbackOnly, true);
  assert.equal(page.canRevert, false);
  assert.equal("trust" in page, false);
  const served = await frame(review, session, 1, () => fs.writeFileSync(file, "<p>Now static</p>"));
  assert.equal(fs.readFileSync(file, "utf8"), "<p>Now static</p>");
  assert.equal((await api(review, `/api/session/${session.sessionId}/page`)).body.page.executionMode, "static");
  assert.equal(served.ready.executionMode, "interactive", "ready reports the served source, not a later read");
  assert.equal(served.ready.savePolicy, "feedback-only");
  assert.equal(served.ready.sourceHash, hash(source));
  assert.match(served.ready.executionNotice, /feedback-only/);
  assert.match(served.csp, /script-src 'unsafe-inline'/);
  assert.match(served.csp, /connect-src 'none'/);
  const forbidden = await saveAttempt(review, session, "Original", "Runtime", served.identity.baseHash);
  assert.equal(forbidden.status, 409);
  assert.equal(forbidden.body.error.code, "SAVE_EVIDENCE_CONFLICT");
  notifySourceChange();
  assert.equal(review.store.page(session.key).pristine, "<p>Now static</p>");
  assert.equal((await fetch(`http://127.0.0.1:${review.port}/artifact/${served.renderId}/asset.css`)).status, 410);
  const fresh = await frame(review, session, 2);
  assert.equal(fresh.ready.savePolicy, "writable");
  assert.equal(fresh.ready.executionMode, "static");
  assert.equal(fresh.ready.executionNotice, null);

  const appFile = path.join(root, "application.html");
  fs.writeFileSync(appFile, '<script src="app.js"></script><script>window.inline=true</script>');
  const app = await frame(review, await open(review, appFile));
  assert.equal(app.ready.executionMode, "application");
  assert.doesNotMatch(app.html, /src="app.js"/);
  assert.match(app.html, /window.inline=true/);
  assert.match(app.ready.executionNotice, /Unsupported dependency elements were removed/);

  const mdFile = path.join(root, "feedback.md");
  fs.writeFileSync(mdFile, "# Markdown");
  const markdown = await open(review, mdFile);
  const mdPage = (await api(review, `/api/session/${markdown.sessionId}/page`)).body.page;
  assert.equal(mdPage.feedbackOnly, true);
  assert.equal(mdPage.savePolicy, "feedback-only");
  assert.equal("executionPreference" in mdPage, false);
  assert.equal((await frame(review, markdown)).ready.savePolicy, "feedback-only");
});

test("execution endpoint validates input, retires approval, and isolates recovery per session and page", async (t) => {
  const { review, file, session } = await fixture(t, "recovery.html", "<script>run()</script>");
  const route = `/api/session/${session.sessionId}/execution`;
  const trustRoute = `/api/session/${session.sessionId}/trust`;
  const decisions = path.join(process.env.DOC_REVIEW_STATE_DIR, "document-trust");
  fs.mkdirSync(decisions, { recursive: true });
  const legacy = path.join(decisions, "old.json");
  fs.writeFileSync(legacy, '{"trusted":true}');
  for (const method of ["GET", "POST"]) {
    const retired = await api(review, trustRoute, method === "POST" ? {} : undefined);
    assert.equal(retired.status, 410);
    assert.deepEqual(retired.body, { error: "Version approvals are no longer used.", code: "trust_workflow_removed" });
  }
  assert.equal((await api(review, trustRoute, {}, { headers: { "x-doc-review-token": "" } })).status, 401);
  assert.equal(fs.readFileSync(legacy, "utf8"), '{"trusted":true}');
  assert.equal((await api(review, route, {}, { headers: { "x-doc-review-token": "" } })).status, 401);
  assert.equal((await api(review, route)).body.code, "method_not_allowed");
  assert.equal((await api(review, route, {}, { method: "PUT" })).status, 405);
  for (const body of [null, [], "auto", 1, {}, { key: session.key, preference: true }, { key: 1, preference: "auto" }]) {
    const invalid = await api(review, route, body);
    assert.equal(invalid.status, 400, JSON.stringify(body));
    assert.equal(invalid.body.code, "invalid_execution_request");
  }
  assert.equal((await api(review, route, "{broken", { raw: true })).body.code, "invalid_execution_request");
  const badHost = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1", port: review.port, path: route, method: "POST",
      headers: { host: `evil.example:${review.port}`, "x-doc-review-token": review.token },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end(JSON.stringify({ key: session.key, preference: "static" }));
  });
  assert.equal(badHost, 403);
  assert.equal((await api(review, route, { key: "missing", preference: "auto" })).body.code, "execution_target_missing");
  assert.equal((await api(review, "/api/session/missing/execution", { key: session.key, preference: "auto" })).status, 404);
  assert.equal((await api(review, "/api/session/not-a-session/execution", { key: session.key, preference: "auto" })).body.code, "execution_target_missing");
  const otherFile = path.join(root, "other.html");
  fs.writeFileSync(otherFile, "<p>Other</p>");
  const other = await open(review, otherFile);
  assert.equal((await api(review, route, { key: other.key, preference: "auto" })).body.code, "execution_target_changed");
  const mdFile = path.join(root, "recovery.md");
  fs.writeFileSync(mdFile, "# Markdown");
  const md = await open(review, mdFile);
  assert.equal((await api(review, `/api/session/${md.sessionId}/execution`, { key: md.key, preference: "auto" })).status, 400);

  const sibling = await open(review, file);
  const current = await frame(review, session);
  const siblingRender = await frame(review, sibling);
  assert.equal((await api(review, route, { key: session.key, preference: "auto", ignored: true })).body.reloadRequired, false);
  const events = await fetch(`http://127.0.0.1:${review.port}/events/${session.sessionId}`, { signal: AbortSignal.timeout(5000) });
  const reader = events.body.getReader();
  await reader.read();
  const changed = await api(review, route, { key: session.key, preference: "static" });
  let eventText = "";
  while (!eventText.includes("execution-preference-changed")) {
    const next = await reader.read();
    assert.equal(next.done, false);
    eventText += Buffer.from(next.value).toString("utf8");
  }
  await reader.cancel();
  assert.match(eventText, new RegExp(`event: reload\\ndata: {"key":"${session.key}","reason":"execution-preference-changed"}`));
  assert.equal(changed.status, 200);
  assert.equal(changed.body.reloadRequired, true);
  assert.equal(changed.body.page.executionMode, "static");
  assert.equal(changed.body.page.executionPreference, "static");
  assert.equal(changed.body.page.savePolicy, "feedback-only");
  assert.equal((await fetch(`http://127.0.0.1:${review.port}/artifact/${current.renderId}/asset.css`)).status, 410);
  assert.notEqual((await fetch(`http://127.0.0.1:${review.port}/artifact/${siblingRender.renderId}/asset.css`)).status, 410);
  assert.equal((await api(review, route, { key: session.key, preference: "static" })).body.reloadRequired, false);
  const recovery = await frame(review, session, 2);
  assert.match(recovery.csp, /script-src 'nonce-/);
  assert.equal(recovery.ready.executionMode, "static");
  assert.equal(recovery.ready.savePolicy, "feedback-only");
  assert.match(recovery.ready.executionNotice, /interactions are disabled/);
  assert.equal((await saveAttempt(review, session, "Original", "Unsafe", recovery.identity.baseHash)).body.error.code, "SAVE_EVIDENCE_CONFLICT");
  await mutate(review, session, "join-page", { target: otherFile });
  assert.equal((await api(review, `/api/session/${session.sessionId}/goto`, { key: other.key })).status, 200);
  await api(review, `/api/session/${session.sessionId}/goto`, { key: session.key });
  assert.equal((await api(review, `/api/session/${session.sessionId}/page`)).body.page.executionPreference, "static");
  const freshSession = await open(review, file);
  assert.equal((await api(review, `/api/session/${freshSession.sessionId}/page`)).body.page.executionPreference, "auto");
  assert.equal((await api(review, route, { key: session.key, preference: "auto" })).body.reloadRequired, true);
  assert.equal((await frame(review, session, 3)).ready.executionMode, "interactive");
});

test("static saves and revert require exact edit identity, review ownership and SHA1 source preconditions", async (t) => {
  const { review, file, session } = await fixture(t, "writes.html");
  const rendered = await frame(review, session);
  const recorded = await mutate(review, session, "record-edit", { pageKey: session.key, content: content("Original", "Edited") });
  const payload = {
    operation: "save-edit", reviewId: session.reviewId, entryKey: session.entryKey,
    requestId: "save-current", expectedVersion: (await read(review, session)).version,
    pageKey: session.key, editId: recorded.value.editId, editVersion: 1,
    expectedSourceHash: rendered.identity.baseHash, html: "<p>Edited</p>",
  };
  for (const field of ["expectedSourceHash", "reviewId", "entryKey", "editId", "editVersion"]) {
    const invalid = { ...payload }; delete invalid[field];
    assert.equal((await conversationRequest(review, invalid)).status, 400, field);
  }
  for (const expectedSourceHash of [null, true, ""]) {
    assert.equal((await conversationRequest(review, { ...payload, expectedSourceHash })).status, 400);
  }
  for (const [fields, code] of [[{ editId: "unknown" }, "NOT_FOUND"], [{ editVersion: 2 }, "VERSION_CONFLICT"],
    [{ expectedSourceHash: "0".repeat(40) }, "SAVE_EVIDENCE_CONFLICT"]]) {
    assert.equal((await conversationRequest(review, { ...payload, ...fields })).body.error.code, code);
    assert.equal(fs.readFileSync(file, "utf8"), "<p>Original</p>");
  }
  assert.equal((await conversationRequest(review, payload)).status, 200);
  const page = await read(review, session, "read-page", { pageKey: session.key });
  assert.equal(page.page.sourceHash, hash(payload.html));
  assert.equal(fs.readFileSync(file, "utf8"), payload.html);
  const revert = { operation: "revert", reviewId: session.reviewId, entryKey: session.entryKey,
    requestId: "revert-current", expectedVersion: (await read(review, session)).version,
    pageKey: session.key, baselineRevisionId: page.revert.baselineRevisionId, expectedSourceHash: rendered.identity.baseHash };
  assert.equal((await conversationRequest(review, revert)).body.error.code, "SAVE_EVIDENCE_CONFLICT");
  assert.equal((await conversationRequest(review, { ...revert, expectedSourceHash: page.page.sourceHash })).status, 200);
  assert.equal(fs.readFileSync(file, "utf8"), "<p>Original</p>");
  assert.equal((await read(review, session, "read-page", { pageKey: session.key })).canRevert, false);
  assert.equal((await list(review, session, "edits")).items[0].source.state, "pending");
});

test("executable additions stay source-pending; old scripted observations never overwrite reclassified source", async (t) => {
  const notifySourceChange = controlSourceWatcher(t, path.join(root, "transitions.html"));
  const { review, file, session } = await fixture(t, "transitions.html");
  const staticFrame = await frame(review, session);
  const scriptedSource = "<p>Edited</p><script>run()</script>";
  const saved = await saveAttempt(review, session, "Original", "Edited", staticFrame.identity.baseHash,
    { html: scriptedSource, content: { after_html: scriptedSource } });
  assert.equal(saved.status, 409, JSON.stringify(saved.body));
  assert.equal(saved.body.error.code, "SAVE_EVIDENCE_CONFLICT");
  assert.equal(fs.readFileSync(file, "utf8"), "<p>Original</p>");
  fs.writeFileSync(file, scriptedSource);
  assert.equal(fs.readFileSync(file, "utf8"), scriptedSource);
  const scriptedFrame = await frame(review, session, 2);
  assert.equal(scriptedFrame.ready.savePolicy, "feedback-only");
  assert.equal((await saveAttempt(review, session, "Edited", "Runtime", hash(scriptedSource))).body.error.code, "SAVE_EVIDENCE_CONFLICT");
  fs.writeFileSync(file, "<p>Static again</p>");
  const sibling = await open(review, file);
  notifySourceChange();
  const writable = await frame(review, sibling);
  const next = await saveAttempt(review, sibling, "Static again", "Writable despite old interactive render", writable.identity.baseHash);
  assert.equal(next.status, 200, JSON.stringify(next.body));
  const source = fs.readFileSync(file, "utf8");
  assert.equal((await saveAttempt(review, session, "Edited", "Runtime", scriptedFrame.identity.baseHash)).status, 409);
  assert.equal(fs.readFileSync(file, "utf8"), source);
  fs.writeFileSync(file, scriptedSource);
  assert.equal((await saveAttempt(review, sibling, "Writable despite old interactive render", "Stale", hash(source))).status, 409);
  assert.equal(fs.readFileSync(file, "utf8"), scriptedSource);
  notifySourceChange();
});

test("scripted image previews stay page-scoped and staged across source reclassification and submission", async (t) => {
  const { review, file, session } = await fixture(t, "paste.html", "<script>run()</script>");
  const rendered = await frame(review, session);
  const png = Buffer.from("image-bytes");
  const uploaded = await conversationRequest(review, {
    reviewId: session.reviewId, entryKey: session.entryKey, pageKey: session.key,
    type: "image/png", base64: png.toString("base64"),
  }, "/api/conversation/asset");
  assert.equal(uploaded.status, 200);
  const asset = uploaded.body;
  const preview = await fetch(`http://127.0.0.1:${review.port}/artifact/${rendered.renderId}/${asset.preview_src}`);
  assert.equal(preview.status, 200);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
  const edit = await mutate(review, session, "record-edit", { pageKey: session.key,
    content: content("", "", { label: "Image", before_html: "", after_html: `<img src="${asset.preview_src}">`, staged_assets: [asset] }) });
  fs.writeFileSync(file, "<p>Now static</p>");
  const deadline = Date.now() + 10000;
  while (review.store.page(session.key).pristine !== "<p>Now static</p>" && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(review.store.page(session.key).pristine, "<p>Now static</p>");
  const reclassified = await frame(review, session, 2);
  assert.equal((await fetch(`http://127.0.0.1:${review.port}/artifact/${reclassified.renderId}/${asset.preview_src}`)).status, 200);
  const records = (await list(review, session, "edits")).items;
  assert.equal(records[0].source.state, "pending", "reclassification never invents source-save evidence");
  const otherFile = path.join(root, "paste-other.html");
  fs.writeFileSync(otherFile, "<p>Other</p>");
  const other = await frame(review, await open(review, otherFile));
  assert.equal((await fetch(`http://127.0.0.1:${review.port}/artifact/${other.renderId}/${asset.preview_src}`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${review.port}/artifact/${reclassified.renderId}/__doc_review_paste__/bad%5Cname.png`)).status, 403);
  await send(review, session, [], [{ pageKey: session.key, editId: edit.value.editId, version: 1 }]);
  const work = (await read(review, session, "poll")).submission;
  assert.equal(work.edits[0].source.state, "pending");
  assert.equal(work.edits[0].assets[0].path, path.join(process.env.DOC_REVIEW_STATE_DIR, "conversation-pasted", session.key, asset.id));
  assert.equal(work.edits[0].assets[0].preview_src, asset.preview_src);
});

test("unreadable source is an explicit error, never a writable fallback", async (t) => {
  const { review, file, session } = await fixture(t, "missing.html");
  fs.unlinkSync(file);
  const page = await api(review, `/api/session/${session.sessionId}/page`);
  assert.equal(page.status, 500);
  assert.match(page.body.error, /ENOENT/);
});

test("localhost retains application execution and nullable source identity without recovery preferences", async (t) => {
  const app = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<p>Application</p><script>window.application=true</script>");
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const review = await start();
  t.after(() => review.dispose());
  const session = await open(review, `http://localhost:${app.address().port}/`);
  const page = (await api(review, `/api/session/${session.sessionId}/page`)).body.page;
  assert.equal(page.executionMode, "application");
  assert.equal(page.savePolicy, "feedback-only");
  assert.equal(page.feedbackOnly, true);
  assert.equal("executionPreference" in page, false);
  const rendered = await frame(review, session);
  assert.equal(rendered.ready.executionMode, "application");
  assert.equal(rendered.ready.sourceHash, null);
  assert.equal(rendered.ready.sourceCapturedAt, null);
  assert.equal(rendered.ready.executionNotice, null);
  const preference = await api(review, `/api/session/${session.sessionId}/execution`, { key: session.key, preference: "static" });
  assert.equal(preference.status, 400);
  assert.equal(preference.body.code, "invalid_execution_request");
});
