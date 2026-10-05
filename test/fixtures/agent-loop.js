import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { runtimeFile, runtimeImport } from "./runtime.js";
const { start } = await runtimeImport("server.js");
const c = await runtimeImport("contracts/index.js");

const cliPath = runtimeFile("cli.js");
export const scopeArgs = (ref) => ["--review", ref.reviewId, "--entry", ref.entryKey];
export const editContent = (before, after, extra = {}) => ({
  kind: "edited", label: "Paragraph", before, after, before_html: `<p>${before}</p>`, after_html: `<p>${after}</p>`,
  truncated: false, truncated_fields: [], staged_assets: [], ...extra,
});
export function responseFor(work, fields = {}) {
  const messages = work.inventory ? work.inventory.items.filter((item) => item.kind === "message") :
    work.messages.map(({ message }) => ({ ...message, messageVersion: message.version }));
  const edits = work.inventory ? work.inventory.items.filter((item) => item.kind === "edit") :
    work.edits.map((item) => ({ ...item, editVersion: item.version, source: { value: item.source } }));
  if (work.inventory) assert.equal(work.inventory.complete, true, "Use a full generated template for paged work.");
  return c.completeResponseSchema.parse({
    operation: "respond", reviewId: work.reviewId, entryKey: work.entryKey,
    submissionId: work.submissionId, expectedVersion: work.version, requestId: randomUUID(),
    responses: messages.map((message) => ({
      threadId: message.threadId, messageId: message.messageId, messageVersion: message.messageVersion,
      outcome: "answered", body: "The explanation preserves the original meaning.",
    })),
    editOutcomes: edits.map((item) => ({
      editId: item.editId, editVersion: item.editVersion,
      outcome: item.source.value.state === "saved" ? "already-saved" : "deferred", reason: "Preserved the exact human record.",
    })),
    resultNote: "Answered without changing source.",
    ...(work.overallNote ? { overallOutcome: "answered" } : {}), ...fields,
  });
}

export async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-agent-"));
  const state = path.join(root, "state");
  const previousPath = process.env.PATH;
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "doc-review.cmd"), `@"${process.execPath}" "${cliPath}" %*\r\n`);
  fs.writeFileSync(path.join(bin, "doc-review"), `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  process.env.DOC_REVIEW_STATE_DIR = state;
  let server = await start(0);
  const children = [];
  const proxies = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill(); await closed;
    }
    for (const proxy of proxies) {
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
    }
    await server?.dispose();
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const call = async (body, route = "/api/conversation") => {
    const res = await fetch(`http://127.0.0.1:${server.port}${route}`, {
      method: "POST", headers: { "content-type": "application/json", "x-doc-review-token": server.token }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const ok = async (body, route) => {
    const result = await call(body, route);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const read = (ref, operation = "read-review", fields = {}) => ok({ operation, ...ref, ...fields });
  const mutate = async (ref, operation, fields = {}) => c.acceptedMutationSchema.parse(await ok({
    operation, ...ref, requestId: randomUUID(), expectedVersion: (await read(ref)).version, ...fields,
  })).receipt;
  const execute = (executable, args, shell = false) => {
    const child = spawn(executable, args, {
      cwd: root, env: { ...process.env, DOC_REVIEW_STATE_DIR: state }, stdio: ["ignore", "pipe", "pipe"], shell,
    });
    children.push(child);
    return new Promise((resolve, reject) => {
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr, body: stdout ? JSON.parse(stdout) : null }));
    });
  };
  const cli = (...args) => execute(process.execPath, [cliPath, ...args]);
  const poll = async (ref, seconds = "5") => {
    const result = await cli("poll", ...scopeArgs(ref), "--timeout", seconds);
    assert.equal(result.code, 0, result.stderr);
    return c.agentPollSchema.parse(result.body);
  };
  return {
    root, state, get server() { return server; }, call, ok, read, mutate, cli,
    run: (command) => execute(command, [], true),
    file(name = `${randomUUID()}.html`, content = "<p>Original</p>") {
      const file = path.join(root, name); fs.writeFileSync(file, content); return file;
    },
    async open(target) {
      const result = await cli(target, "--no-browser", "--timeout", "5");
      assert.equal(result.code, 0, result.stderr);
      return c.agentOpenSchema.parse(result.body);
    },
    thread: (ref, extra = {}) => mutate(ref, "create-thread", {
      pageKey: ref.entryKey, target: { kind: "selection", anchor: { quote: "Original", prefix: "", suffix: "" } },
      body: "Why this wording?", intent: "discuss", ...extra,
    }),
    send: (ref, messages = [], edits = [], extra = {}) => mutate(ref, "send", {
      pageKeys: [ref.entryKey],
      messages: messages.map(({ value }) => ({ threadId: value.threadId, messageId: value.messageId, version: 1 })),
      edits, ...extra,
    }),
    poll,
    async exportPoll(ref, seconds = "5") {
      const output = await poll(ref, seconds);
      if (output.state !== "work") return output;
      const destination = path.join(root, `submission-${randomUUID()}.json`);
      const exported = await cli("content", ...scopeArgs(ref), "--submission", output.submission.submissionId, "--output-file", destination);
      assert.equal(exported.code, 0, exported.stderr);
      const { submission, result, receipt } = JSON.parse(fs.readFileSync(destination, "utf8"));
      return { ...output, submission: c.submissionReadSchema.parse({ submission, result, receipt }).submission };
    },
    async respond(ref, body, filename = "response.json") {
      fs.writeFileSync(path.join(root, filename), JSON.stringify(body));
      return cli("respond", ...scopeArgs(ref), "--response-file", filename, "--timeout", "5");
    },
    async stop() { await server.dispose(); server = null; },
    async restart() { await server?.dispose(); server = await start(0); },
    async proxy(handler, { interceptHealth = false } = {}) {
      const upstream = `http://127.0.0.1:${server.port}`;
      const proxy = http.createServer(async (req, res) => {
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks).toString();
          const forward = async () => {
            const response = await fetch(`${upstream}${req.url}`, {
              method: req.method,
              headers: { "content-type": "application/json", "x-doc-review-token": server.token },
              ...(body ? { body } : {}),
            });
            return { status: response.status, text: await response.text() };
          };
          if (req.url === "/health" && !interceptHealth) {
            const response = await forward(); res.writeHead(response.status); res.end(response.text);
          } else await handler({ req, res, body, forward });
        } catch (error) { res.destroy(error); }
      });
      await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      proxies.push(proxy);
      const recordPath = path.join(state, "server.json");
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      fs.writeFileSync(recordPath, JSON.stringify({ ...record, port: proxy.address().port }));
      return proxy;
    },
  };
}

/** Storage/source regressions deliberately inspect all exact data through the public export. */
export async function exactFixture(t) {
  const f = await fixture(t);
  f.poll = f.exportPoll;
  return f;
}
