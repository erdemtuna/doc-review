import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "doc-review-history-server-"));
process.env.DOC_REVIEW_STATE_DIR = path.join(root, "state");
const { start } = await import("../lib/server.js");

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

async function request(review, route, { body, token = review.token } = {}) {
  const response = await fetch(`http://127.0.0.1:${review.port}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-doc-review-token": token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) };
}

function semantic(text) {
  return {
    version: 1,
    blocks: [{
      id: "block-1", tag: "p", selector: "#copy", text, attributes: {},
      runs: [{ text, marks: [] }], path: [],
    }],
    limitations: [],
  };
}

function write(file, text) {
  fs.writeFileSync(file, `<!doctype html><html><body><p id="copy">${text}</p></body></html>`);
}

async function open(review, name, text = "Before") {
  const file = path.join(root, name);
  write(file, text);
  const opened = await request(review, "/api/session", { body: { file } });
  assert.equal(opened.status, 200);
  return { file, ...opened.body };
}

async function render(review, session, generation) {
  const registered = await request(review, `/api/session/${session.sessionId}/render`, {
    body: { key: session.key, generation },
  });
  assert.equal(registered.status, 200);
  const record = registered.body;
  const document = await fetch(`http://127.0.0.1:${review.port}${record.path}`);
  assert.equal(document.status, 200);
  await document.text();
  const ready = await request(review, `/api/session/${session.sessionId}/render/${record.renderId}/ready`, {
    body: { capability: record.capability, generation, pageKey: session.key },
  });
  assert.equal(ready.status, 200);
  return { renderId: record.renderId, generation, expectedSourceHash: ready.body.sourceHash };
}

async function acknowledge(review, file, batchId) {
  const response = await fetch(
    `http://127.0.0.1:${review.port}/api/poll?target=${encodeURIComponent(file)}&ack=${batchId}`,
    { headers: { "x-doc-review-token": review.token }, signal: AbortSignal.timeout(10000) }
  );
  await response.body.cancel();
}

test("history freezes a note-only Send baseline and a separately captured result", async (t) => {
  const review = await start();
  t.after(() => review.dispose());
  const session = await open(review, "round.html");
  const first = await render(review, session, 1);
  const sent = await request(review, `/api/page/${session.key}/send`, {
    body: {
      sessionId: session.sessionId, note: "Refine this paragraph",
      history: { ...first, semantic: semantic("Before"), allowUnavailable: false },
    },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.ok(sent.body.roundId);
  const polled = await request(review, `/api/poll?target=${encodeURIComponent(session.file)}`);
  assert.equal(polled.body.overall_note, "Refine this paragraph");
  write(session.file, "After");
  await acknowledge(review, session.file, polled.body.batch_id);

  let history = await request(review, `/api/session/${session.sessionId}/history`);
  assert.equal(history.body.rounds.length, 1);
  assert.equal(history.body.rounds[0].feedbackStatus, "acknowledged");
  assert.notEqual(history.body.rounds[0].captureStatus, "ready");
  assert.ok(history.body.rounds[0].targets[0].sourceResultRevisionId);
  const sourceBeforeBrowserCapture = await request(review,
    `/api/session/${session.sessionId}/history/${sent.body.roundId}/compare?key=${session.key}&mode=source`);
  assert.equal(sourceBeforeBrowserCapture.body.available, true);
  assert.equal(sourceBeforeBrowserCapture.body.counts.modified, 1);

  const deadline = Date.now() + 5000;
  while (!review.store.page(session.key).pristine.includes("After") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const second = await render(review, session, 2);
  const captured = await request(
    review, `/api/session/${session.sessionId}/history/${sent.body.roundId}/capture`,
    { body: { key: session.key, ...second, semantic: semantic("After"), manual: false } }
  );
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  history = await request(review, `/api/session/${session.sessionId}/history`);
  assert.equal(history.body.rounds[0].captureStatus, "ready");

  const route = `/api/session/${session.sessionId}/history/${sent.body.roundId}/compare?key=${session.key}&mode=source`;
  const comparison = await request(review, route);
  assert.equal(comparison.status, 200);
  assert.ok(comparison.body.changes.length);
  write(session.file, "A still newer version");
  const historical = await request(review, route);
  assert.deepEqual(historical.body, comparison.body, "later disk writes never redefine completed endpoints");
  await review.dispose();
  const restored = await start();
  t.after(() => restored.dispose());
  const reopened = await request(restored, "/api/session", { body: { file: session.file } });
  const afterRestart = await request(restored,
    `/api/session/${reopened.body.sessionId}/history/${sent.body.roundId}/compare?key=${session.key}&mode=source`);
  assert.deepEqual(afterRestart.body, comparison.body, "restarting never recaptures a completed source endpoint");
});

test("Send rejects stale source and requires an explicit missing-baseline choice", async (t) => {
  const review = await start();
  t.after(() => review.dispose());
  const session = await open(review, "stale.html");
  const before = await render(review, session, 1);
  write(session.file, "Concurrent revision");
  const stale = await request(review, `/api/page/${session.key}/send`, {
    body: {
      sessionId: session.sessionId, note: "Still valuable feedback",
      history: { ...before, semantic: semantic("Before"), allowUnavailable: false },
    },
  });
  assert.equal(stale.status, 409);
  assert.equal((await request(review, `/api/session/${session.sessionId}/history`)).body.rounds.length, 0);

  const sent = await request(review, `/api/page/${session.key}/send`, {
    body: { sessionId: session.sessionId, note: "Still valuable feedback", history: { allowUnavailable: true } },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const batch = await request(review, `/api/poll?target=${encodeURIComponent(session.file)}`);
  assert.equal(batch.body.overall_note, "Still valuable feedback");
});

test("history endpoints require authentication and the owning entry history", async (t) => {
  const review = await start();
  t.after(() => review.dispose());
  const session = await open(review, "private.html");
  assert.equal((await request(review, `/api/session/${session.sessionId}/history`, { token: "" })).status, 401);
  const before = await render(review, session, 1);
  const sent = await request(review, `/api/page/${session.key}/send`, {
    body: { sessionId: session.sessionId, note: "Private round", history: { ...before, semantic: semantic("Before") } },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const other = await open(review, "unrelated.html");
  assert.equal(
    (await request(review, `/api/session/${other.sessionId}/history/${sent.body.roundId}`)).status,
    404
  );
});

test("external HTML writes preserve unsent edit records", async (t) => {
  const review = await start();
  t.after(() => review.dispose());
  const session = await open(review, "pending-edits.html");
  await request(review, `/api/page/${session.key}/edit`, {
    body: { label: "Copy", kind: "edited", before: "Before", after: "My pending wording" },
  });
  const edits = structuredClone(review.store.page(session.key).edits);
  write(session.file, "External source");
  const deadline = Date.now() + 5000;
  while (!review.store.page(session.key).pristine.includes("External source") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(review.store.page(session.key).pristine, /External source/);
  assert.deepEqual(review.store.page(session.key).edits, edits);
});

test("invalid semantic capture is rejected without publishing a feedback batch", async (t) => {
  const review = await start();
  t.after(() => review.dispose());
  const session = await open(review, "invalid-snapshot.html");
  const before = await render(review, session, 1);
  const invalid = semantic("Before");
  invalid.blocks[0].tag = "script";
  const sent = await request(review, `/api/page/${session.key}/send`, {
    body: { sessionId: session.sessionId, note: "Do not lose this", history: { ...before, semantic: invalid } },
  });

  assert.equal(sent.status, 400, JSON.stringify(sent.body));
  assert.equal(review.store.batch(session.key), null);
  assert.equal(review.store.listHistory(session.key).length, 0);
});

test("best-effort Send retains active Content alongside an inactive page's Source", async (t) => {
  const review = await start();
  t.after(() => review.dispose());
  const active = await open(review, "partial-active.html", "Active before");
  const other = await open(review, "partial-other.html", "Other before");
  const goto = async (key) => {
    const result = await request(review, `/api/session/${active.sessionId}/goto`, { body: { key } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  };
  await goto(other.key);
  const otherEdit = await request(review, `/api/page/${other.key}/edit`, {
    body: { label: "Other copy", before: "Other before", after: "Other feedback" },
  });
  assert.equal(otherEdit.status, 200);
  await goto(active.key);
  const activeEdit = await request(review, `/api/page/${active.key}/edit`, {
    body: { label: "Active copy", before: "Active before", after: "Active feedback" },
  });
  assert.equal(activeEdit.status, 200);
  const frame = await render(review, active, 20);
  const sent = await request(review, `/api/page/${active.key}/send`, {
    body: {
      sessionId: active.sessionId,
      note: "Apply both pages",
      history: { ...frame, semantic: semantic("Active before"), allowUnavailable: true },
    },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(sent.body.historyUnavailable.map((target) => target.key), [other.key]);
  const round = review.store.getRound(active.key, sent.body.roundId);
  assert.equal(round.targets.length, 2);
  const activeBaseline = round.targets.find((target) => target.key === active.key);
  const otherBaseline = round.targets.find((target) => target.key === other.key);
  assert.equal(review.store.revisions.readSemantic(activeBaseline.baselineRevisionId).blocks[0].text, "Active before");
  assert.match(review.store.revisions.readSource(otherBaseline.baselineRevisionId), /Other before/);
  const batch = await request(review, `/api/poll?target=${encodeURIComponent(active.file)}`);
  assert.equal(batch.body.pages.length, 2, "missing optional Content does not drop either page's feedback");
});

test("known tab mismatch stays retryable and cannot freeze a misleading result", async (t) => {
    const review = await start();
    t.after(() => review.dispose());
    const session = await open(review, "view-mismatch.html");
    const frame = await render(review, session, 1);
    const view = (tabId, label) => ({
      version: 1, status: "identified",
      tabs: [{ groupId: "id:sections", tabId, panelId: `${tabId}-panel`, label }],
    });
    const sent = await request(review, `/api/page/${session.key}/send`, {
      body: { sessionId: session.sessionId, note: "Review Product", history: {
        ...frame, semantic: semantic("Before"), view: view("product", "Product"),
      } },
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const delivered = await request(review, `/api/poll?target=${encodeURIComponent(session.file)}`);
    await acknowledge(review, session.file, delivered.body.batch_id);
    const route = `/api/session/${session.sessionId}/history/${sent.body.roundId}/capture`;
    const mismatched = await request(review, route, { body: {
      key: session.key, ...frame, semantic: semantic("Screens"), view: view("screens", "Screens"), manual: true,
    } });
    assert.equal(mismatched.status, 409, JSON.stringify(mismatched.body));
    assert.equal(mismatched.body.code, "history_view_mismatch");
    assert.match(mismatched.body.error, /Return to Product/);
    const pending = review.store.getRound(session.key, sent.body.roundId);
    assert.equal(pending.targets[0].resultRevisionId, null);
    assert.equal(pending.targets[0].capture.status, "failed");
    assert.ok(pending.targets[0].sourceResultRevisionId);
    const missingIdentity = await request(review, route, { body: {
      key: session.key, ...frame, semantic: semantic("Something else"), manual: true,
    } });
    assert.equal(missingIdentity.status, 409, "missing identity cannot bypass a known before view");
    const matched = await request(review, route, { body: {
      key: session.key, ...frame, semantic: semantic("After"), view: view("product", "Product"), manual: true,
    } });
    assert.equal(matched.status, 200, JSON.stringify(matched.body));
    const compared = await request(review,
      `/api/session/${session.sessionId}/history/${sent.body.roundId}/compare?key=${session.key}&mode=content`);
    assert.equal(compared.body.viewComparison.status, "matched");
});

test("a scripted baseline can capture an updated static source without renewed approval", async (t) => {
  const review = await start();
  t.after(() => review.dispose());
  const session = await open(review, "scripted-capture.html");
  fs.writeFileSync(session.file, '<!doctype html><p id="copy">Before</p><script>document.body.dataset.interactive = "yes";</script>');
  const before = await render(review, session, 1);
  const sent = await request(review, `/api/page/${session.key}/send`, {
    body: { sessionId: session.sessionId, note: "Simplify this document", history: { ...before, semantic: semantic("Before") } },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const baselineId = review.store.getRound(session.key, sent.body.roundId).targets[0].baselineRevisionId;
  assert.equal(review.store.revisions.get(baselineId).semantic.provenance.feedbackOnlyEdits, true,
    "the baseline must actually use the automatic scripted-file policy");
  const delivered = await request(review, `/api/poll?target=${encodeURIComponent(session.file)}`);
  write(session.file, "After");
  await acknowledge(review, session.file, delivered.body.batch_id);
  const deadline = Date.now() + 5000;
  while (!review.store.page(session.key).pristine.includes("After") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const staticResult = await render(review, session, 2);
  const captureRoute = `/api/session/${session.sessionId}/history/${sent.body.roundId}/capture`;
  const captured = await request(review, captureRoute, {
    body: { key: session.key, ...staticResult, semantic: semantic("After"), manual: true },
  });
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  assert.ok(captured.body.round.targets[0].resultRevisionId);
});

test("Markdown keeps rendered preview content separate from file source", async (t) => {
  const review = await start();
  t.after(() => review.dispose());
  const file = path.join(root, "preview.md");
  fs.writeFileSync(file, "# Original source\n\nOriginal body.\n");
  const opened = await request(review, "/api/session", { body: { file } });
  const session = { file, ...opened.body };
  const before = await render(review, session, 1);
  const sent = await request(review, `/api/page/${session.key}/send`, {
    body: {
      sessionId: session.sessionId, note: "Carry my preview edit into source",
      history: { ...before, semantic: semantic("Human preview edit") },
    },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const target = review.store.getRound(session.key, sent.body.roundId).targets[0];
  assert.match(review.store.revisions.readSource(target.baselineRevisionId), /Original body/);
  assert.equal(review.store.revisions.readSemantic(target.baselineRevisionId).blocks[0].text, "Human preview edit");
});

test("capture failure persists and explicit completion preserves an available source comparison", async (t) => {
  const review = await start();
  t.after(() => review.dispose());
  const session = await open(review, "failed-content.html");
  const before = await render(review, session, 1);
  const sent = await request(review, `/api/page/${session.key}/send`, {
    body: { sessionId: session.sessionId, note: "Review", history: { ...before, semantic: semantic("Before") } },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const delivered = await request(review, `/api/poll?target=${encodeURIComponent(session.file)}`);
  await acknowledge(review, session.file, delivered.body.batch_id);
  const route = `/api/session/${session.sessionId}/history/${sent.body.roundId}/capture`;
  const failed = await request(review, route, {
    body: { key: session.key, ...before, error: "The DOM did not stabilize.", manual: true },
  });
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.round.targets[0].capture.status, "failed");
  const completed = await request(review, route, {
    body: { key: session.key, manual: true, finalUnavailable: true },
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.ok(completed.body.round.completedAt);
  assert.equal(completed.body.round.captureStatus, "partial");
  const source = await request(review,
    `/api/session/${session.sessionId}/history/${sent.body.roundId}/compare?key=${session.key}&mode=source`);
  assert.equal(source.body.available, true);
  assert.equal(source.body.counts.total, 0);
  const content = await request(review,
    `/api/session/${session.sessionId}/history/${sent.body.roundId}/compare?key=${session.key}&mode=content`);
  assert.equal(content.body.available, false);
});

test("live capture uses the current reviewed frame and requires explicit ownership transfer", async (t) => {
  let pageText = "Live before";
  let fetches = 0;
  const upstream = http.createServer((_req, res) => {
    fetches++;
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><html><body><p id="copy">${pageText}</p></body></html>`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => upstream.close((err) => err ? reject(err) : resolve())));
  const target = `http://127.0.0.1:${upstream.address().port}/review`;
  const review = await start();
  t.after(() => review.dispose());
  const opened = await request(review, "/api/session", { body: { target } });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const firstSession = opened.body;
  const first = await render(review, firstSession, 1);
  const sent = await request(review, `/api/page/${firstSession.key}/send`, {
    body: {
      sessionId: firstSession.sessionId, note: "Improve live content",
      history: { ...first, semantic: semantic("Live before") },
    },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const delivered = await request(review, `/api/poll?target=${encodeURIComponent(target)}`);
  pageText = "Live result";
  await acknowledge(review, target, delivered.body.batch_id);
  const firstRoute = `/api/session/${firstSession.sessionId}/history/${sent.body.roundId}/capture`;
  const stale = await request(review, firstRoute, {
    body: { key: firstSession.key, ...first, semantic: semantic("Live before"), manual: false },
  });
  assert.equal(stale.status, 409, "acknowledgement invalidates the previous live render");

  const secondSession = (await request(review, "/api/session", { body: { target } })).body;
  const second = await render(review, secondSession, 1);
  const route = `/api/session/${secondSession.sessionId}/history/${sent.body.roundId}/capture`;
  const body = { key: secondSession.key, ...second, semantic: semantic("Live result in this tab") };
  const competing = await request(review, route, { body: { ...body, manual: false } });
  assert.equal(competing.status, 409);
  assert.equal(competing.body.code, "history_capture_owner");
  const fetchesBeforeCapture = fetches;
  const captured = await request(review, route, { body: { ...body, manual: true } });
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  assert.equal(fetches, fetchesBeforeCapture, "semantic capture must not substitute a server-side page fetch");
  const revisionId = captured.body.round.targets[0].resultRevisionId;
  assert.equal(review.store.revisions.readSource(revisionId), null);
  assert.equal(review.store.revisions.readSemantic(revisionId).blocks[0].text, "Live result in this tab");
  assert.equal(review.store.revisions.get(revisionId).semantic.provenance.sessionId, secondSession.sessionId);
  const duplicate = await request(review, firstRoute, {
    body: { key: firstSession.key, ...first, semantic: semantic("Stale overwrite"), manual: true },
  });
  assert.equal(duplicate.body.alreadyCaptured, true);
  assert.equal(duplicate.body.round.targets[0].resultRevisionId, revisionId);
});
