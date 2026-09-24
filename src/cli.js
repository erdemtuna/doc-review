#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  canonicalTarget,
  ensureStateDir,
  SERVER_PROTOCOL,
  serverPath,
  serverProtocolMatches,
  statePath,
} from "./paths.js";
import { readServerLock } from "./server-lock.js";
import { installSkills } from "./setup.js";
import { createDeadline, DEFAULT_POLL_SECONDS, isRecoverableTransportError, mutationUntilDeadline, parseServerResponse, pollUntilDeadline, readUntilDeadline, requestRaw } from "./poll-transport.js";
import { agentHandoff } from "./agent-handoff.js";
import { Conversations, validateConversations } from "./conversation-store.js";
import {
  acceptedMutationSchema, agentOpenSchema, agentPollSchema, agentReferenceSchema, agentStatusSchema,
  completeResponseSchema, contextPageSchema, conversationListRequestSchema, contractFailure, ContractError,
  CONTRACT_LIMITS, exchangeSchema, id, object, openReviewRequestSchema, receiptLookupSchema,
  reviewPageSchema, reviewReadRequestSchema, reviewSchema, text, transportOutcomeSchema, validatePageOutput,
} from "./contracts/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));

const HELP = `doc-review ${pkg.version}

  doc-review <file-or-localhost-url> [--request-id <id>] [--no-browser]
                                    Create/join a durable review; print JSON identity and commands
  doc-review poll --review <id> --entry <key> [--timeout <secs>]
                                    Wait for accepted work; default 12 hours (43200 seconds)
  doc-review context --review <id> --entry <key> --thread <id> [--limit <1-100>] [--cursor <token>]
                                    Read bounded thread exchanges (default 50, newest first)
  doc-review respond --review <id> --entry <key> --response-file <file> [--timeout <secs>]
                                    Submit complete JSON, including stable requestId and expectedVersion
  doc-review receipt --review <id> --entry <key> --request-id <id>
                                    Read receipt evidence; not-found is not proof of rejection
  doc-review status --review <id> --entry <key>
                                    Read status/evidence without starting a server (disk if offline)
      --timeout <secs>               One discovery/retry deadline; other commands default to 60 seconds
  doc-review setup                  Teach Claude Code / Codex how to use doc-review
  doc-review setup --global         ...for every project, not just this one

Everything runs locally. No account, no cloud, no database.
Use Review / Changes in the browser for retained content history.
Plain HTML edits autosave. Self-contained file scripts run automatically with feedback-only edits.
Use More for optional script-disabled recovery. Comparison capture does not block sending feedback.
Only complete responses handle work. Target-only polling and acknowledgement-only completion are retired.
Discuss does not authorize editing; each request-change has its own scope.
End freezes reviewer content, not accepted work. Delivery does not imply a live handler.
JSON errors exit 1; unknown mutation acceptance exits 2. Retry the same response file, not source edits.
`;

// --------------------------------------------------------------- server glue

function readServerRecord() {
  try {
    return JSON.parse(fs.readFileSync(serverPath(), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new ContractError("INTERNAL_ERROR", `Cannot read server discovery record: ${error.message}`);
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
        `Incompatible live doc-review server (health protocol ${health.protocol}, record ${server.protocol}; this CLI requires ${SERVER_PROTOCOL}). ` +
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

const diagnostic = (message) => process.stderr.write(message);
const sessionSchema = object({ sessionId: id, review: reviewSchema, path: text() });
const timeout = (options, fallback = 60) => createDeadline(options.timeout === undefined ? fallback : Number(options.timeout));
const reference = (options) => agentReferenceSchema.parse({ reviewId: options.review, entryKey: options.entry });
const read = (body, decoder, deadline) => readUntilDeadline({ body, decoder, deadline, discover: ensureServer, diagnostic });
const historyRequest = (scope) => conversationListRequestSchema.parse({
  operation: "list", scope: { ...scope, collection: "history", pageKey: null, threadId: null, submissionId: null, status: "all" },
  query: { limit: 1 },
});

async function openCommand(input, options) {
  const target = canonicalTarget(input);
  if (target.kind === "file" && !fs.existsSync(target.value)) {
    throw new ContractError("NOT_FOUND", `File not found: ${target.value}`);
  }
  const deadline = timeout(options);
  const body = openReviewRequestSchema.parse({ operation: "open", target: target.value, requestId: options["request-id"] ?? randomUUID() });
  const accepted = await mutationUntilDeadline({ body, deadline, discover: ensureServer, diagnostic });
  const scope = { reviewId: accepted.receipt.reviewId, entryKey: accepted.receipt.entryKey };
  // Opening a browser is not part of durable acceptance. Preserve the receipt if attachment fails.
  try {
    const server = await ensureServer(deadline);
    const raw = await request(server, {
      method: "POST", path: "/api/conversation/session", headers: { "content-type": "application/json" },
      timeout: deadline.remaining(),
    }, { operation: "read-review", ...scope });
    const session = sessionSchema.parse(parseServerResponse(raw));
    if (session.review.reviewId !== scope.reviewId || session.review.entryKey !== scope.entryKey ||
        session.path !== `/r/${scope.reviewId}`) throw new ContractError("SCOPE_MISMATCH", "Session belongs to another review.");
    const url = `http://127.0.0.1:${server.port}${session.path}`;
    const output = agentOpenSchema.parse({ ...accepted, review: session.review, url, handoff: agentHandoff(scope) });
    await print(output);
    if (!options["no-browser"]) openBrowser(url);
  } catch (error) {
    error.accepted = accepted;
    throw error;
  }
}

/**
 * The consumer is an agent reading a pipe. process.exit() does not wait for
 * pending stdout writes, so a large payload could arrive truncated — always
 * wait for the write to hand off before returning.
 */
function writeStdout(text) {
  return new Promise((resolve) => process.stdout.write(text, resolve));
}

const print = (value) => writeStdout(`${JSON.stringify(value, null, 2)}\n`);

async function pollCommand(options) {
  const scope = reference(options);
  const deadline = timeout(options, DEFAULT_POLL_SECONDS);
  const result = await pollUntilDeadline({ reference: scope, deadline, discover: ensureServer, diagnostic });
  let pages;
  try {
    pages = result.state === "work" ? await Promise.all(result.submission.pageKeys.map(async (pageKey) => {
      const page = await read({ operation: "read-page", ...scope, pageKey }, reviewPageSchema, deadline);
      if (page.reviewId !== scope.reviewId || page.page.pageKey !== pageKey) throw new ContractError("SCOPE_MISMATCH", "Wrong page in handoff.");
      return page.page;
    })) : undefined;
  } catch (error) {
    if (error.code !== "POLL_DEADLINE" && !(isRecoverableTransportError(error) && deadline.remaining() <= 0)) throw error;
    return print(agentPollSchema.parse({ state: "timeout", ...scope, handoff: agentHandoff(scope) }));
  }
  await print(agentPollSchema.parse({
    ...result, ...(pages ? { pages } : {}),
    handoff: agentHandoff(scope, result.state === "work" ? result.submission.messages.map((item) => item.message.threadId) : []),
  }));
}

/**
 * No work wait or server startup. Asks the running server when there is one;
 * otherwise reads the persisted state directly, so a dead server still
 * reports feedback that is waiting for a fresh poll.
 */
async function statusCommand(options) {
  const scope = reference(options);
  const deadline = timeout(options);
  const saved = readServerRecord();
  if (await alive(saved, deadline)) {
    const discover = async () => saved;
    const output = await readUntilDeadline({
      body: { operation: "status", ...scope }, decoder: agentStatusSchema, deadline, discover, diagnostic,
      route: "/api/conversation/status",
    });
    if (output.source !== "server" || output.status.review.reviewId !== scope.reviewId || output.status.review.entryKey !== scope.entryKey) {
      throw new ContractError("SCOPE_MISMATCH", "Wrong review status.");
    }
    return print(output);
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    validateConversations(data);
  } catch (error) {
    throw new ContractError(error.code === "ENOENT" ? "NOT_FOUND" : "INTERNAL_ERROR",
      `Cannot read validated conversation state (no legacy fallback): ${error.message}`);
  }
  const conversations = new Conversations({ data });
  const status = conversations.read({ operation: "status", ...scope });
  const history = conversations.list(historyRequest(scope));
  await print(agentStatusSchema.parse({ source: "disk", status, latestSubmission: history.items[0] ?? null }));
}

async function contextCommand(options) {
  const scope = reference(options);
  const body = conversationListRequestSchema.parse({
    operation: "list",
    scope: { ...scope, collection: "context", pageKey: null, threadId: options.thread, submissionId: null, status: "all" },
    query: { ...(options.limit === undefined ? {} : { limit: Number(options.limit) }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }) },
  });
  const output = await read(body, contextPageSchema, timeout(options));
  validatePageOutput(output, exchangeSchema, body.scope, body.query);
  for (const exchange of output.items) {
    if (exchange.reviewer.reviewId !== scope.reviewId || exchange.reviewer.threadId !== options.thread) {
      throw new ContractError("SCOPE_MISMATCH", "Thread context belongs to another review/thread.");
    }
  }
  await print(output);
}

async function respondCommand(options) {
  const scope = reference(options);
  if (!options["response-file"]) throw new ContractError("INVALID_INPUT", "respond requires --response-file.");
  const file = fs.readFileSync(path.resolve(options["response-file"]));
  if (file.byteLength > CONTRACT_LIMITS.requestBytes) throw new ContractError("INPUT_TOO_LARGE", "Response file exceeds 24 MiB.");
  let value;
  try { value = JSON.parse(file.toString("utf8")); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ContractError("MALFORMED_JSON", "Response file must contain complete JSON.");
  }
  const body = completeResponseSchema.parse(value);
  if (body.reviewId !== scope.reviewId || body.entryKey !== scope.entryKey) throw new ContractError("SCOPE_MISMATCH", "Response file and command identity disagree.");
  await print(await mutationUntilDeadline({ body, deadline: timeout(options), discover: ensureServer, diagnostic }));
}

async function receiptCommand(options) {
  const scope = reference(options);
  const body = reviewReadRequestSchema.parse({ operation: "receipt", ...scope, requestId: options["request-id"] });
  const result = await read(body, receiptLookupSchema, timeout(options));
  if ((result.state === "accepted" && (result.receipt.reviewId !== scope.reviewId || result.receipt.entryKey !== scope.entryKey ||
      result.receipt.requestId !== body.requestId)) || (result.state === "not-found" && result.requestId !== body.requestId)) {
    throw new ContractError("SCOPE_MISMATCH", "Wrong receipt lookup response.");
  }
  await print(result);
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

function parseOptions(rest, allowed) {
  const parsed = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--ack" || arg.startsWith("--ack=")) throw new ContractError("INVALID_INPUT", "--ack is retired. Submit a complete response file with stable review identity.");
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match || !allowed.includes(match[1]) || Object.hasOwn(parsed, match[1])) {
      throw new ContractError("INVALID_INPUT", `Unknown/duplicate argument: ${arg}. Target-only agent commands are retired; use --review and --entry from open.`);
    }
    const key = match[1];
    if (key === "no-browser") {
      if (match[2] !== undefined) throw new ContractError("INVALID_INPUT", "--no-browser takes no value.");
      parsed[key] = true;
    } else {
      const value = match[2] ?? rest[++i];
      if (!value || value.startsWith("--")) throw new ContractError("INVALID_INPUT", `--${key} requires a value.`);
      parsed[key] = value;
    }
  }
  if (parsed.timeout !== undefined && (!Number.isFinite(Number(parsed.timeout)) || Number(parsed.timeout) <= 0)) {
    throw new ContractError("INVALID_INPUT", "--timeout requires a positive finite number of seconds.");
  }
  return parsed;
}

try {
  const commands = { poll: pollCommand, status: statusCommand, context: contextCommand, respond: respondCommand, receipt: receiptCommand };
  if (Object.hasOwn(commands, argv[0])) {
    const extras = { poll: [], status: [], context: ["thread", "limit", "cursor"], respond: ["response-file"], receipt: ["request-id"] };
    await commands[argv[0]](parseOptions(argv.slice(1), ["review", "entry", "timeout", ...extras[argv[0]]]));
  } else if (argv[0] === "setup") {
    if (argv.slice(1).some((arg) => !["--global", "-g"].includes(arg))) throw new ContractError("INVALID_INPUT", "Unknown setup argument.");
    const isGlobal = argv.includes("--global") || argv.includes("-g");
    installSkills(process.cwd(), { global: isGlobal }).forEach((line) => console.log(line));
  } else {
    if (argv[0].startsWith("-")) throw new ContractError("INVALID_INPUT", `Unknown command: ${argv[0]}`);
    await openCommand(argv[0], parseOptions(argv.slice(1), ["request-id", "no-browser", "timeout"]));
  }
} catch (err) {
  diagnostic(`${err.message || String(err)}\n`);
  if (err.outcome) {
    await print(transportOutcomeSchema(acceptedMutationSchema).parse(err.outcome));
    process.exitCode = 2;
  } else {
    if (err.accepted) {
      diagnostic("Open was durably accepted, but browser attachment failed. Reuse its requestId to recover the link.\n");
      await print(transportOutcomeSchema(acceptedMutationSchema).parse({ state: "accepted", value: err.accepted }));
    } else await print(contractFailure(err instanceof ContractError ? err : new ContractError("INTERNAL_ERROR", err.message || String(err))));
    process.exitCode = 1;
  }
}
