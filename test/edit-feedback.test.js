import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { MAX_EDIT_CHARACTERS } from "../src/edit-limits.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doc-review-edit-feedback-"));
process.env.DOC_REVIEW_STATE_DIR = path.join(tmp, "state");
const { start } = await import("../src/server.js");

function request(review, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: review.port, path: route, method: body ? "POST" : "GET",
      signal: AbortSignal.timeout(15000),
      headers: { "x-doc-review-token": review.token, "content-type": "application/json" },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("error", reject);
      res.on("end", () => {
        try {
          assert.equal(res.statusCode, 200, raw);
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function open(review, name) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, "# Original");
  return { file, ...await request(review, "/api/session", { file }) };
}

test("long feedback is bounded, explicitly flagged, and durable across delivery/restart", { timeout: 20000 }, async (t) => {
  let review = await start();
  t.after(() => review.dispose());
  const opened = await open(review, "long.md");
  for (const length of [6000, MAX_EDIT_CHARACTERS, MAX_EDIT_CHARACTERS + 1, 250000]) {
    const text = "x".repeat(length);
    const { page } = await request(review, `/api/page/${opened.key}/edit`, {
      label: `Length ${length}`, before: "Original", after: text, after_html: text,
    });
    const row = page.edits.at(-1);
    assert.equal(row.after, text.slice(0, MAX_EDIT_CHARACTERS));
    assert.equal(row.after_html, row.after);
    assert.equal(row.truncated, length > MAX_EDIT_CHARACTERS);
    assert.deepEqual(row.truncated_fields, length > MAX_EDIT_CHARACTERS ? ["after", "after_html"] : []);
  }
  await request(review, `/api/page/${opened.key}/send`, { sessionId: opened.sessionId, note: "" });
  const route = `/api/poll?target=${encodeURIComponent(opened.file)}`;
  const delivered = await request(review, route);
  assert.equal(delivered.pages[0].edits[0].after.length, 6000);
  assert.equal(delivered.pages[0].edits[1].truncated, undefined);
  assert.deepEqual(delivered.pages[0].edits[2].truncated_fields, ["after", "after_html"]);
  assert.match(delivered.next_step, /Never apply incomplete text or HTML/);
  assert.match(delivered.next_step, /Do not acknowledge this batch until all feedback is handled/);
  const output = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../src/cli.js", import.meta.url)), "poll", opened.file, "--timeout", "5",
  ], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  assert.deepEqual(JSON.parse(output.stdout), delivered, "large CLI stdout carries the complete immutable batch");

  await review.dispose();
  review = await start();
  assert.deepEqual(await request(review, route), delivered);
  const page = await request(review, `/api/page/${opened.key}`);
  assert.deepEqual(page.edits[3].truncated_fields, ["after", "after_html"]);
});

test("shortening replacement fields clears their flags without rewriting original before metadata", { timeout: 10000 }, async (t) => {
  const review = await start();
  t.after(() => review.dispose());
  const opened = await open(review, "shortening.md");
  const route = `/api/page/${opened.key}/edit`;
  const long = "x".repeat(MAX_EDIT_CHARACTERS + 1);
  await request(review, route, { label: "Replacement", before: "Original", after: long, after_html: long });
  const shortened = await request(review, route, {
    label: "Replacement", before: "Original", after: "Short", after_html: "<b>Short</b>",
  });
  assert.equal(shortened.page.edits[0].truncated, false);
  assert.deepEqual(shortened.page.edits[0].truncated_fields, []);

  await request(review, route, { label: "Original was long", before: long, after: long });
  const retained = await request(review, route, {
    label: "Original was long", before: "Changed baseline", after: "Short",
  });
  const row = retained.page.edits[1];
  assert.equal(row.before.length, MAX_EDIT_CHARACTERS);
  assert.equal(row.truncated, true);
  assert.deepEqual(row.truncated_fields, ["before"]);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
