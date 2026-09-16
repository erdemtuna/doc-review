#!/usr/bin/env node
import fs from "node:fs";
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
import { createDeadline, DEFAULT_POLL_SECONDS, isRecoverableTransportError, parseServerResponse, pollUntilDeadline, requestRaw } from "./poll-transport.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));

const HELP = `doc-review ${pkg.version}

  doc-review <file-or-localhost-url> Open a file or localhost page for review
  doc-review poll <target>          Wait for feedback, print it as JSON (for agents)
      --ack <batch_id>             Acknowledge that exact delivered batch, then keep waiting
      --timeout <secs>             End-to-end cutoff; default 12 hours (43200 seconds)
  doc-review status <target>        Report whether feedback is waiting, without blocking
  doc-review setup                  Teach Claude Code / Codex how to use doc-review
  doc-review setup --global         ...for every project, not just this one

Everything runs locally. No account, no cloud, no database.
Use Review / Changes in the browser for retained content history.
Plain HTML edits autosave. Self-contained file scripts run automatically with feedback-only edits.
Use More for optional script-disabled recovery. Comparison capture does not block sending feedback.
Acknowledgement handles feedback; browser result capture may complete later.
`;

// --------------------------------------------------------------- server glue

function readServerRecord() {
  try {
    return JSON.parse(fs.readFileSync(serverPath(), "utf8"));
  } catch {
    return null;
  }
}

const request = requestRaw;

async function alive(server, deadline) {
  if (!server?.port || !server.instance_id) return false;
  const lock = readServerLock();
  if (lock?.pid !== server.pid || lock?.instance_id !== server.instance_id) return false;
  try {
    deadline?.check();
    const res = await request(server, {
      method: "GET", path: "/health", timeout: Math.min(1200, deadline?.remaining() ?? 1200),
    }, undefined, { time: deadline?.time });
    deadline?.check();
    const health = parseServerResponse(res);
    if (health.pid !== server.pid || health.instance_id !== server.instance_id) {
      throw new Error("The doc-review server identity does not match its writer lock. End the review and restart the server.");
    }
    if (!serverProtocolMatches(health.protocol) || !serverProtocolMatches(server.protocol)) {
      throw new Error(
        `Incompatible live doc-review server (protocol ${health.protocol}; this CLI requires ${SERVER_PROTOCOL}). ` +
        "End active reviews and stop/restart the old doc-review server before retrying. " +
        "Its live writer lock and queued feedback have not been changed.",
      );
    }
    return true;
  } catch (err) {
    if (isRecoverableTransportError(err)) return false;
    throw err;
  }
}

async function ensureServer(deadline = createDeadline(20)) {
  deadline.check();
  ensureStateDir();
  for (let launch = 0; launch < 3; launch += 1) {
    const saved = readServerRecord();
    if (await alive(saved, deadline)) return saved;
    deadline.check();

    const child = spawn(process.execPath, [path.join(here, "server-entry.js")], {
      detached: true,
      stdio: "ignore",
    });
    let launchError;
    child.on("error", (err) => { launchError = err; });
    child.unref();

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await deadline.sleep(100);
      if (launchError) throw launchError;
      const record = readServerRecord();
      if (await alive(record, deadline)) return record;
      if (child.exitCode !== null && child.exitCode !== 0) {
        throw new Error("The local doc-review server failed to start. Check the state directory permissions and server startup diagnostics before retrying.");
      }
      if (child.exitCode !== null && !readServerLock()) break;
    }
  }
  throw Object.assign(new Error("Could not start the local doc-review server yet."), { code: "SERVER_START_PENDING" });
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
 * The consumer is an agent reading a pipe. process.exit() does not wait for
 * pending stdout writes, so a large payload could arrive truncated — always
 * wait for the write to hand off before returning.
 */
function writeStdout(text) {
  return new Promise((resolve) => process.stdout.write(text, resolve));
}

async function pollCommand(input, { ackId = "", timeoutSecs = DEFAULT_POLL_SECONDS } = {}) {
  const deadline = createDeadline(timeoutSecs);
  const target = canonicalTarget(input).value;

  const label = /^https?:\/\//i.test(target) ? target : path.basename(target);
  process.stderr.write(`Waiting for feedback on ${label} — comment in the browser, then hit Send.\n`);

  const batch = await pollUntilDeadline({
    target, ackId, deadline, discover: ensureServer,
    diagnostic: (text) => process.stderr.write(text),
  });
  await writeStdout(`${JSON.stringify(batch, null, 2)}\n`);
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
  const parsed = { file: "", ackId: "", timeoutSecs: DEFAULT_POLL_SECONDS };
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
