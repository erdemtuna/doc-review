import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-receipts-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");

const { start } = await import("../src/server.js");
const { atomicWrite } = await import("../src/state.js");
const { ensureStateDir, statePath, targetKey } = await import("../src/paths.js");

function request(review, { method = "GET", route = "/", body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: review.port,
        method,
        path: route,
        headers: {
          "x-human-review-token": review.token,
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, raw, body: JSON.parse(raw) }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function open(review, name) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, "<p>Original</p>");
  const opened = await request(review, { method: "POST", route: "/api/session", body: { file } });
  return { file, ...opened.body };
}

async function comment(review, key, feedback) {
  return (
    await request(review, {
      method: "POST",
      route: `/api/page/${key}/comment`,
      body: { kind: "selection", quote: "Original", feedback },
    })
  ).body.comment;
}

async function send(review, opened) {
  const response = await request(review, {
    method: "POST",
    route: `/api/page/${opened.key}/send`,
    body: { sessionId: opened.sessionId, note: "" },
  });
  assert.equal(response.status, 200);
}

async function poll(review, file, ackId = "") {
  const ack = ackId ? `&ack=${encodeURIComponent(ackId)}` : "";
  return (await request(review, { route: `/api/poll?target=${encodeURIComponent(file)}${ack}` })).body;
}

async function ackAndCancel(review, file, id) {
  const response = await fetch(
    `http://127.0.0.1:${review.port}/api/poll?target=${encodeURIComponent(file)}&ack=${encodeURIComponent(id)}`,
    { headers: { "x-human-review-token": review.token } }
  );
  await response.body.cancel();
}

test("stale and duplicate acknowledgements poll normally without clearing a newer batch", async (t) => {
  const review = await start();
  t.after(async () => review.dispose());
  const opened = await open(review, "stale-ack.html");

  await comment(review, opened.key, "first");
  await send(review, opened);
  const first = await poll(review, opened.file);

  await comment(review, opened.key, "second");
  await send(review, opened);
  const newer = await poll(review, opened.file, first.batch_id);
  assert.notEqual(newer.batch_id, first.batch_id);
  assert.match(newer.next_step, new RegExp(`--ack ${newer.batch_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --timeout 600`));
  assert.deepEqual(newer.pages[0].comments.map((item) => item.feedback), ["first", "second"]);

  await ackAndCancel(review, opened.file, newer.batch_id);
  await comment(review, opened.key, "third");
  await send(review, opened);
  const afterDuplicate = await poll(review, opened.file, newer.batch_id);
  assert.notEqual(afterDuplicate.batch_id, newer.batch_id);
  assert.deepEqual(afterDuplicate.pages[0].comments.map((item) => item.feedback), ["third"]);
});

test("concurrent pollers receive one immutable batch ID after delivery is durable", async (t) => {
  const review = await start();
  t.after(async () => review.dispose());
  const opened = await open(review, "concurrent-pollers.html");
  await comment(review, opened.key, "same receipt");
  await send(review, opened);

  const [left, right] = await Promise.all([poll(review, opened.file), poll(review, opened.file)]);
  assert.equal(left.batch_id, right.batch_id);
  const persisted = JSON.parse(fs.readFileSync(statePath(), "utf8")).batches[opened.key];
  assert.equal(persisted.batch_id, left.batch_id);
  assert.equal(persisted.delivery_state, "delivered");
});

test("queued batches survive restart and can still be revised in place", async (t) => {
  let review = await start();
  t.after(async () => review.dispose());
  const opened = await open(review, "restart-before-delivery.html");
  const added = await comment(review, opened.key, "old queued wording");
  await send(review, opened);
  const queuedId = JSON.parse(fs.readFileSync(statePath(), "utf8")).batches[opened.key].batch_id;

  await review.dispose();
  review = await start();
  const revised = await request(review, {
    method: "PATCH",
    route: `/api/page/${opened.key}/comment/${added.id}`,
    body: { feedback: "new queued wording" },
  });
  assert.equal(revised.body.delivery, "updated-pending");
  const delivered = await poll(review, opened.file);
  assert.equal(delivered.batch_id, queuedId);
  assert.equal(delivered.pages[0].comments[0].feedback, "new queued wording");
});

test("delivered batches survive restart and original ack cannot clear a correction", async (t) => {
  let review = await start();
  t.after(async () => review.dispose());
  const opened = await open(review, "restart-after-delivery.html");
  const added = await comment(review, opened.key, "old delivered wording");
  await send(review, opened);
  const delivered = await poll(review, opened.file);

  await review.dispose();
  review = await start();
  const revised = await request(review, {
    method: "PATCH",
    route: `/api/page/${opened.key}/comment/${added.id}`,
    body: { feedback: "replacement wording" },
  });
  assert.equal(revised.body.delivery, "correction");
  assert.notEqual(revised.body.page.comments[0].id, added.id);

  await ackAndCancel(review, opened.file, delivered.batch_id);
  const page = (await request(review, { route: `/api/page/${opened.key}` })).body;
  assert.equal(page.comments.length, 1);
  assert.equal(page.comments[0].feedback, "replacement wording");
  assert.equal(page.comments[0].correction, true);
});

test("legacy batches cannot be acknowledged before redelivery and edits remain corrections", async (t) => {
  ensureStateDir();
  const file = path.join(tmp, "legacy-receipt.html");
  fs.writeFileSync(file, "<p>Legacy</p>");
  const key = targetKey(file);
  const now = Date.now();
  let data = { pages: {}, batches: {}, receipts: {} };
  try {
    data = JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  data.pages[key] = {
    key,
    kind: "file",
    file,
    pristine: "<p>Legacy</p>",
    comments: [{ id: "legacy-id", kind: "selection", quote: "Legacy", feedback: "old" }],
    edits: [],
    updatedAt: now,
  };
  data.batches[key] = {
    batch: {
      status: "feedback",
      pages: [{ kind: "file", file, comments: [{ id: "legacy-id", feedback: "old" }], edits: [] }],
    },
    cleanup: [{ key, ids: ["legacy-id"], staged: [], sentAt: now }],
    updatedAt: now,
  };
  fs.writeFileSync(statePath(), JSON.stringify(data, null, 2));

  const review = await start();
  t.after(async () => review.dispose());
  const recovered = JSON.parse(fs.readFileSync(statePath(), "utf8")).batches[key];
  assert.equal(recovered.delivery_state, "possibly_delivered");

  const redelivered = await poll(review, file, recovered.batch_id);
  assert.equal(redelivered.batch_id, recovered.batch_id, "the premature ack is a no-op and the legacy batch is redelivered");

  const revised = await request(review, {
    method: "PATCH",
    route: `/api/page/${key}/comment/legacy-id`,
    body: { feedback: "legacy correction" },
  });
  assert.equal(revised.body.delivery, "correction");
  await ackAndCancel(review, file, redelivered.batch_id);
  const page = (await request(review, { route: `/api/page/${key}` })).body;
  assert.equal(page.comments[0].feedback, "legacy correction");
});

test("a failed durable acknowledgement never deletes staged assets", async (t) => {
  ensureStateDir();
  const target = "http://localhost:43210/staged";
  const key = targetKey(target);
  const staged = path.join(process.env.HUMAN_REVIEW_STATE_DIR, "pasted", key, "asset.png");
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, "asset");
  const now = Date.now();
  fs.writeFileSync(
    statePath(),
    JSON.stringify({
      pages: {
        [key]: {
          key,
          kind: "url",
          url: target,
          pristine: "",
          comments: [{ id: "staged-comment", feedback: "move image" }],
          edits: [],
          updatedAt: now,
        },
      },
      batches: {
        [key]: {
          batch_id: "b_staged_failure",
          batch: { batch_id: "b_staged_failure", status: "feedback", pages: [] },
          cleanup: [{ key, ids: ["staged-comment"], staged: [staged], sentAt: now }],
          delivery_state: "delivered",
          updatedAt: now,
        },
      },
      receipts: {},
    })
  );

  let failWrites = true;
  const review = await start(0, {
    storeOptions: {
      write(file, data) {
        if (failWrites) throw new Error("injected acknowledgement failure");
        atomicWrite(file, data);
      },
    },
  });
  t.after(async () => review.dispose());

  const failed = await request(review, {
    route: `/api/poll?target=${encodeURIComponent(target)}&ack=b_staged_failure`,
  });
  assert.equal(failed.status, 500);
  assert.equal(fs.existsSync(staged), true);
  assert.ok(JSON.parse(fs.readFileSync(statePath(), "utf8")).batches[key]);

  failWrites = false;
  await ackAndCancel(review, target, "b_staged_failure");
  assert.equal(fs.existsSync(staged), false);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
