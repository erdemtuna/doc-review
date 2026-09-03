#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canonicalTarget,
  ensureStateDir,
  SERVER_PROTOCOL,
  serverPath,
  serverProtocolMatches,
  statePath,
  targetKey,
} from "./paths.js";
import { readServerLock } from "./server-lock.js";
import { installSkills, shellQuote } from "./setup.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));

const HELP = `doc-review ${pkg.version}

  doc-review <file-or-localhost-url> Open a file or localhost page for review
  doc-review poll <target>          Wait for feedback, print it as JSON (for agents)
      --ack <batch_id>             Acknowledge that exact delivered batch, then keep waiting
      --timeout <secs>             Exit with {"status":"timeout"} if nothing arrives
  doc-review status <target>        Report whether feedback is waiting, without blocking
  doc-review setup                  Teach Claude Code / Codex how to use doc-review
  doc-review setup --global         ...for every project, not just this one

Everything runs locally. No account, no cloud, no database.
`;

// --------------------------------------------------------------- server glue

function readServerRecord() {
  try {
    return JSON.parse(fs.readFileSync(serverPath(), "utf8"));
  } catch {
    return null;
  }
}

function request(server, options, body) {
  const port = typeof server === "number" ? server : server.port;
  const token = typeof server === "number" ? "" : server.token || "";
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        ...options,
        headers: { ...(token ? { "x-doc-review-token": token } : {}), ...(options.headers || {}) },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on("error", reject);
    if (options.timeout) req.setTimeout(options.timeout, () => req.destroy(new Error("timeout")));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function alive(server) {
  try {
    const lock = readServerLock();
    if (lock?.pid !== server.pid || lock?.instance_id !== server.instance_id) return false;
    const res = await request(server, { method: "GET", path: "/health", timeout: 1200 });
    if (res.status !== 200) return false;
    const health = JSON.parse(res.raw);
    return (
      serverProtocolMatches(health.protocol) &&
      health.pid === server.pid &&
      health.instance_id === server.instance_id
    );
  } catch {
    return false;
  }
}

async function ensureServer() {
  ensureStateDir();
  for (let launch = 0; launch < 3; launch += 1) {
    const saved = readServerRecord();
    if (serverProtocolMatches(saved?.protocol) && saved.port && saved.instance_id && (await alive(saved))) return saved;

    const child = spawn(process.execPath, [path.join(here, "server-entry.js")], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const record = readServerRecord();
      // Same protocol gate as above: a still-running server from an older
      // version answers /health too, and must not be adopted here.
      if (serverProtocolMatches(record?.protocol) && record.port && record.instance_id && (await alive(record))) return record;
      if (child.exitCode !== null && !readServerLock()) break;
    }
  }
  throw new Error("Could not start the local doc-review server.");
}

function openBrowser(url) {
  const command =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
  // A missing opener (headless Linux without xdg-open) surfaces as an async
  // 'error' event, not a throw. Printing the URL below is the fallback.
  child.on("error", () => {});
  child.unref();
}

// ------------------------------------------------------------------ commands

async function openCommand(input) {
  const target = canonicalTarget(input);
  if (target.kind === "file" && !fs.existsSync(target.value)) {
    console.error(`File not found: ${target.value}`);
    process.exit(1);
  }
  const server = await ensureServer();
  const res = await request(server, { method: "POST", path: "/api/session", headers: { "content-type": "application/json" } }, { target: target.value });
  const body = JSON.parse(res.raw);
  if (res.status !== 200) {
    console.error(body.error || "Could not open that file.");
    process.exit(1);
  }
  const url = `http://127.0.0.1:${server.port}${body.path}`;
  openBrowser(url);
  console.log(`Reviewing ${target.kind === "url" ? target.value : path.basename(target.value)}`);
  console.log(url);
  console.log(`\nWaiting for feedback? Run:\n  doc-review poll ${shellQuote(target.value)}`);
}

/**
 * One long-poll attempt. Resolves { kind: "data", raw } when the server
 * answers, or { kind: "timeout" } when the caller's deadline passes first.
 */
function pollOnce(server, target, ackId, timeoutMs) {
  const query = `target=${encodeURIComponent(target)}${ackId ? `&ack=${encodeURIComponent(ackId)}` : ""}`;
  return new Promise((resolve, reject) => {
    let done = false;
    const settle = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        method: "GET",
        path: `/api/poll?${query}`,
        headers: { "x-doc-review-token": server.token || "" },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => settle(resolve, { kind: "data", raw: raw.trim() }));
      }
    );
    const timer = timeoutMs
      ? setTimeout(() => {
          settle(resolve, { kind: "timeout" });
          req.destroy();
        }, timeoutMs)
      : null;
    req.on("error", (err) => settle(reject, err));
    req.end();
  });
}

/**
 * The consumer is an agent reading a pipe. process.exit() does not wait for
 * pending stdout writes, so a large payload could arrive truncated — always
 * wait for the write to hand off before returning.
 */
function writeStdout(text) {
  return new Promise((resolve) => process.stdout.write(text, resolve));
}

function printTimeout(waitedSecs) {
  const payload = {
    status: "timeout",
    waited_seconds: waitedSecs,
    next_step:
      "No feedback yet. Run the same poll command again to keep waiting, or `doc-review status <target>` to check without blocking.",
  };
  return writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
}

async function pollCommand(input, { ackId = "", timeoutSecs = 0 } = {}) {
  const target = canonicalTarget(input).value;
  let server = await ensureServer();

  const label = /^https?:\/\//i.test(target) ? target : path.basename(target);
  process.stderr.write(`Waiting for feedback on ${label} — comment in the browser, then hit Send.\n`);

  const deadline = timeoutSecs ? Date.now() + timeoutSecs * 1000 : null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const remaining = deadline ? deadline - Date.now() : 0;
    if (deadline && remaining <= 0) return printTimeout(timeoutSecs);
    let result;
    try {
      result = await pollOnce(server, target, ackId && attempt === 0 ? ackId : "", remaining);
    } catch (err) {
      process.stderr.write(`Lost the connection (${err.message}); retrying.\n`);
      server = await ensureServer();
      continue;
    }
    if (result.kind === "timeout") return printTimeout(timeoutSecs);
    if (!result.raw) {
      server = await ensureServer();
      continue;
    }
    try {
      const batch = JSON.parse(result.raw);
      await writeStdout(`${JSON.stringify(batch, null, 2)}\n`);
      return;
    } catch {
      process.stderr.write("Unexpected response from the doc-review server; retrying.\n");
    }
  }
  process.stderr.write("Gave up waiting for feedback.\n");
  process.exit(1);
}

/**
 * Instant answer, no blocking. Asks the running server when there is one;
 * otherwise reads the persisted state directly, so a dead server still
 * reports feedback that is waiting for a fresh poll.
 */
async function statusCommand(input) {
  const target = canonicalTarget(input).value;
  const saved = readServerRecord();
  if (serverProtocolMatches(saved?.protocol) && saved.port && saved.instance_id && (await alive(saved))) {
    const res = await request(saved, { method: "GET", path: `/api/status?target=${encodeURIComponent(target)}` });
    if (res.status === 200) {
      process.stdout.write(`${JSON.stringify(JSON.parse(res.raw), null, 2)}\n`);
      return;
    }
  }

  let data = { pages: {}, batches: {} };
  try {
    data = JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    // No state yet: everything below reads as empty.
  }
  const key = targetKey(target);
  const pending = (data.batches || {})[key];
  const page = (data.pages || {})[key];
  const payload = {
    status: pending ? "feedback-waiting" : "idle",
    feedback_waiting: !!pending,
    agent_listening: false,
    server_running: false,
    unsent: {
      comments: page ? page.comments.length : 0,
      edits: page ? page.edits.length : 0,
    },
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

// ---------------------------------------------------------------------- main

const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
  console.log(HELP);
  process.exit(0);
}

if (argv[0] === "--version" || argv[0] === "-v") {
  console.log(pkg.version);
  process.exit(0);
}

process.on("SIGINT", () => {
  process.stderr.write("\nStopped waiting. Your feedback is safe — run the same command again to pick it up.\n");
  process.exit(130);
});

function parsePollArgs(rest) {
  const parsed = { file: "", ackId: "", timeoutSecs: 0 };
  let sawTimeout = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--ack") {
      const value = rest[(i += 1)];
      if (!value || value.startsWith("-")) {
        throw new Error("--ack requires the batch_id from the feedback response, e.g. --ack b_123");
      }
      parsed.ackId = value;
    }
    else if (arg.startsWith("--ack=")) {
      throw new Error("Use --ack <batch_id> with the batch ID as a separate argument.");
    }
    else if (arg === "--timeout") {
      sawTimeout = true;
      parsed.timeoutSecs = Number(rest[(i += 1)]);
    } else if (arg.startsWith("--timeout=")) {
      sawTimeout = true;
      parsed.timeoutSecs = Number(arg.slice("--timeout=".length));
    } else if (!arg.startsWith("-") && !parsed.file) parsed.file = arg;
    else throw new Error(`Unknown poll argument: ${arg}`);
  }
  // A malformed value must fail loudly — NaN or 0 silently waiting forever is
  // the exact hang the flag exists to prevent.
  if (sawTimeout && (!Number.isFinite(parsed.timeoutSecs) || parsed.timeoutSecs <= 0)) {
    throw new Error("--timeout wants a number of seconds, e.g. --timeout 300");
  }
  return parsed;
}

try {
  if (argv[0] === "poll") {
    const { file, ackId, timeoutSecs } = parsePollArgs(argv.slice(1));
    if (!file) throw new Error("Usage: doc-review poll <file-or-localhost-url> [--ack <batch_id>] [--timeout <secs>]");
    await pollCommand(file, { ackId, timeoutSecs });
  } else if (argv[0] === "status") {
    const file = argv.find((a, i) => i > 0 && !a.startsWith("-"));
    if (!file) throw new Error("Usage: doc-review status <file-or-localhost-url>");
    await statusCommand(file);
  } else if (argv[0] === "setup") {
    const isGlobal = argv.includes("--global") || argv.includes("-g");
    installSkills(process.cwd(), { global: isGlobal }).forEach((line) => console.log(line));
  } else {
    await openCommand(argv[0]);
  }
} catch (err) {
  console.error(err.message || String(err));
  process.exit(1);
}
