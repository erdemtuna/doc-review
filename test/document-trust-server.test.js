import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "doc-review-trust-api-"));
process.env.DOC_REVIEW_STATE_DIR = path.join(root, "state");
const { start } = await import("../src/server.js");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

async function api(review, route, body, token = review.token) {
  const response = await fetch(`http://127.0.0.1:${review.port}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-doc-review-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
async function open(review, file) {
  const response = await api(review, "/api/session", { file });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

test("trust requires exact original bytes, explicit approval and authenticated requests", async (t) => {
  const file = path.join(root, "exact.html");
  const original = "\ufeff<!doctype html><p>Before</p><script>document.body.dataset.ran='yes';</script>";
  fs.writeFileSync(file, original);
  const review = await start();
  t.after(() => review.dispose());
  const session = await open(review, file);
  const route = `/api/session/${session.sessionId}/trust`;
  assert.equal((await api(review, route, undefined, "")).status, 401);
  const initial = await api(review, route);
  assert.equal(initial.body.trust.approved, false);
  assert.equal(initial.body.trust.sourceHash, crypto.createHash("sha256").update(Buffer.from(original)).digest("hex"));
  assert.equal((await api(review, route, { action: "grant", sourceHash: "0".repeat(64) })).status, 409);
  const granted = await api(review, route, { action: "grant", sourceHash: initial.body.trust.sourceHash });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.equal(granted.body.trust.approved, true);
  assert.equal(granted.body.page.feedbackOnly, true);
  assert.equal(granted.body.page.trustedInteractive, true);
  const forgedSave = await api(review, `/api/page/${session.key}/save`, {
    html: "<p>Runtime DOM must not overwrite source</p>",
    sessionId: session.sessionId, trustedInteractive: false,
  });
  assert.equal(forgedSave.status, 409, JSON.stringify(forgedSave.body));
  assert.equal((await api(review, `/api/page/${session.key}/revert`, {})).status, 409);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  const changed = original.replace("Before", "Changed source");
  fs.writeFileSync(file, changed);
  assert.equal((await api(review, route)).body.trust.approved, false);
  assert.equal((await api(review, route, { action: "grant", sourceHash: initial.body.trust.sourceHash })).status, 409);
  const fresh = (await api(review, route)).body.trust;
  assert.equal((await api(review, route, { action: "grant", sourceHash: fresh.sourceHash })).status, 200);
  assert.equal((await api(review, route, { action: "revoke", sourceHash: fresh.sourceHash })).body.trust.approved, false);
});

test("remembered approval survives restart only for its own file and version", async (t) => {
  const file = path.join(root, "remembered.html");
  const other = path.join(root, "different-path.html");
  fs.writeFileSync(file, "<p>Same bytes</p>");
  fs.copyFileSync(file, other);
  const first = await start();
  t.after(() => first.dispose());
  const session = await open(first, file);
  const route = `/api/session/${session.sessionId}/trust`;
  const sourceHash = (await api(first, route)).body.trust.sourceHash;
  assert.equal((await api(first, route, { action: "grant", sourceHash })).status, 200);
  await first.dispose();
  const second = await start();
  t.after(() => second.dispose());
  const reopened = await open(second, file);
  assert.equal((await api(second, `/api/session/${reopened.sessionId}/trust`)).body.trust.approved, true);
  const unrelated = await open(second, other);
  assert.equal((await api(second, `/api/session/${unrelated.sessionId}/trust`)).body.trust.approved, false);
});
