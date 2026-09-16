import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { requestRaw } from "../src/poll-transport.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(project, ".doc-review-poll-"));
process.env.DOC_REVIEW_STATE_DIR = path.join(tmp, "state");

async function request(server, method, route, body) {
  const response = await requestRaw(server, {
    method, path: route, timeout: 2000,
    headers: body ? { "content-type": "application/json" } : {},
  }, body);
  return { status: response.status, body: JSON.parse(response.raw) };
}

function collect(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForServer() {
  const record = path.join(process.env.DOC_REVIEW_STATE_DIR, "server.json");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const saved = JSON.parse(fs.readFileSync(record, "utf8"));
      const health = await request(saved.port, "GET", "/health");
      if (health.status === 200) return saved;
    } catch {
      // The child has not announced its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("review server did not start");
}

test("poll exits with the feedback batch when the user sends", { timeout: 15000 }, async (t) => {
  const file = path.join(tmp, "review.html");
  fs.writeFileSync(file, "<p>Original</p>");

  const reviewServer = spawn(process.execPath, ["src/server-entry.js"], {
    cwd: project,
    env: { ...process.env, DOC_REVIEW_STATE_DIR: process.env.DOC_REVIEW_STATE_DIR },
    stdio: "ignore",
  });

  let child;
  t.after(async () => {
    for (const process of [child, reviewServer]) {
      if (process && process.exitCode === null && process.signalCode === null) {
        const closed = once(process, "close");
        process.kill();
        await closed;
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const server = await waitForServer();
  const opened = await request(server, "POST", "/api/session", { file });
  assert.equal(opened.status, 200);

  const commented = await request(server, "POST", `/api/page/${opened.body.key}/comment`, {
    kind: "selection",
    quote: "Original",
    feedback: "Make this clearer.",
  });
  assert.equal(commented.status, 200);

  child = spawn(process.execPath, ["src/cli.js", "poll", file], {
    cwd: project,
    env: { ...process.env, DOC_REVIEW_STATE_DIR: process.env.DOC_REVIEW_STATE_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const resultPromise = collect(child);

  const sent = await request(server, "POST", `/api/page/${opened.body.key}/send`, {
    sessionId: opened.body.sessionId,
    note: "",
  });
  assert.equal(sent.status, 200);

  const result = await resultPromise;
  assert.equal(result.code, 0, result.stderr);
  const batch = JSON.parse(result.stdout);
  assert.equal(batch.status, "feedback");
  assert.equal(batch.pages[0].comments[0].feedback, "Make this clearer.");
});
