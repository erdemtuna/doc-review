import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import ts from "typescript";
import { conversationSmoke } from "./package-conversation-smoke.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);
const args = process.argv.slice(2);
const browserRequested = args.includes("--browser");
const tarballs = args.filter((arg) => arg !== "--browser");
assert.ok(tarballs.length <= 1 && tarballs.every((arg) => !arg.startsWith("--")),
  "Usage: npm run test:package -- [candidate.tgz] [--browser]");
const npm = process.env.npm_execpath;
assert.ok(npm, "Run through npm run test:package so the selected npm CLI is reused");
const expected = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const work = await mkdtemp(path.join(root, ".package-smoke-"));
const prefix = path.join(work, "install");
const home = path.join(work, "home");
const project = path.join(work, "project");
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  DOC_REVIEW_STATE_DIR: path.join(work, "state"),
};
let server;
let browser;
let serverLog = "";
let succeeded = false;
let installedServer;
let info;
let base;
let installed;
const keep = process.env.DOC_REVIEW_SMOKE_KEEP === "1";
const evidenceDir = path.join(process.env.DOC_REVIEW_SMOKE_ARTIFACTS || root,
  `.package-smoke-evidence-${Date.now()}-${process.pid}`);

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const child = server, exited = once(child, "exit");
  if (child.connected) child.send("stop");
  const timer = setTimeout(() => child.kill(), 5_000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function startServer(port = 0) {
  server = fork(fileURLToPath(new URL("./package-smoke-server.js", import.meta.url)), [installedServer, String(port)], {
    cwd: project, env, execPath: process.execPath, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const child = server;
  child.stdout.on("data", (chunk) => { serverLog += chunk; });
  child.stderr.on("data", (chunk) => { serverLog += chunk; });
  [info] = await Promise.race([
    once(child, "message", { signal: AbortSignal.timeout(15_000) }),
    once(child, "exit").then(([code]) => { throw new Error(`Installed server exited ${code}: ${serverLog}`); }),
  ]);
  base = `http://127.0.0.1:${info.port}`;
}

async function npmRun(arguments_, cwd = root, extraEnv = {}) {
  return run(process.execPath, [npm, ...arguments_], { cwd, env: { ...env, ...extraEnv }, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
}
async function runtimeHashes(directory) {
  const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
  const hashes = {};
  for (const entry of files.sort((a, b) => path.join(a.parentPath, a.name).localeCompare(path.join(b.parentPath, b.name)))) {
    const file = path.join(entry.parentPath, entry.name);
    hashes[path.relative(directory, file)] = createHash("sha256").update(await readFile(file)).digest("hex");
  }
  return hashes;
}

try {
  await Promise.all([prefix, home, project, evidenceDir].map((directory) => mkdir(directory, { recursive: true })));
  let tarball = tarballs[0] && path.resolve(tarballs[0]);
  if (!tarball) {
    // prepack rebuilds; this local test archive is never a publishable candidate.
    const packed = await npmRun(["pack", "--json", "--pack-destination", work]);
    const entries = Object.values(JSON.parse(packed.stdout));
    assert.equal(entries.length, 1);
    tarball = path.join(work, entries[0].filename);
  }
  await copyFile(tarball, path.join(evidenceDir, path.basename(tarball)));
  await writeFile(path.join(prefix, "package.json"), JSON.stringify({
    name: "doc-review-installed-smoke",
    private: true,
    dependencies: { [expected.name]: `file:${tarball}` },
  }));
  await npmRun(["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], prefix);
  installed = path.join(prefix, "node_modules", ...expected.name.split("/"));
  const runtime = await runtimeHashes(path.join(installed, "lib"));
  const repositoryRuntime = await runtimeHashes(path.join(root, "lib"));
  assert.deepEqual(runtime, repositoryRuntime, "Installed tarball runtime must match the built repository runtime");
  const approved = process.env.DOC_REVIEW_APPROVED_RUNTIME;
  if (approved) assert.deepEqual(runtime, await runtimeHashes(approved), "Installed runtime must match the explicitly approved runtime");
  await writeFile(path.join(evidenceDir, "installed-runtime.json"), JSON.stringify({
    installed, prefix, project, state: env.DOC_REVIEW_STATE_DIR, work, kept: keep,
    tarball: path.join(evidenceDir, path.basename(tarball)),
    tarballSha256: createHash("sha256").update(await readFile(tarball)).digest("hex"),
    runtime, repositoryEqual: true, ...(approved ? { approvedRuntime: approved, approvedEqual: true } : {}),
  }, null, 2));
  const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(manifest.version, expected.version);
  assert.equal(manifest.name, expected.name);
  assert.deepEqual(manifest.bin, { "doc-review": "lib/cli.js" });
  assert.deepEqual(manifest.files, ["lib", "README.md", "LICENSE"]);
  assert.equal(manifest.engines.node, ">=24.21.0");
  for (const entry of await readdir(installed)) {
    assert.ok(["lib", "README.md", "LICENSE", "package.json", "node_modules"].includes(entry), `Unexpected package entry: ${entry}`);
  }
  for (const entry of await readdir(path.join(installed, "lib"), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) assert.ok(/\.(js|html|css|md)$/.test(entry.name), `Unexpected runtime file: ${entry.name}`);
  }
  for (const asset of [
    "cli.js", "server-entry.js", "server.js", "chrome.html", "sdk.js", "SKILL.md",
    "ui/chrome.js", "ui/chrome.css", "ui/THIRD_PARTY_NOTICES.md",
  ]) {
    await access(path.join(installed, "lib", asset));
  }
  assert.deepEqual((await readdir(path.join(installed, "lib", "ui"))).sort(),
    ["THIRD_PARTY_NOTICES.md", "chrome.css", "chrome.js"]);
  const notices = await readFile(path.join(installed, "lib", "ui", "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.match(notices, /lucide-static/);
  assert.match(notices, /Permission to use, copy, modify/);
  assert.match(notices, /Copyright \(c\) 2023 shadcn/);
  for (const dependency of ["typescript", "vite", "react", "react-dom", "radix-ui", "shadcn", "vitest"]) {
    await assert.rejects(access(path.join(prefix, "node_modules", dependency)));
  }
  const shim = path.join(prefix, "node_modules", ".bin", process.platform === "win32" ? "doc-review.cmd" : "doc-review");
  await access(shim);
  const cli = path.join(installed, manifest.bin["doc-review"]);
  const cliRun = (arguments_) => run(process.execPath, [cli, ...arguments_], { cwd: project, env, timeout: 30_000 });
  assert.equal((await cliRun(["--version"])).stdout.trim(), expected.version);
  if (process.platform !== "win32") {
    assert.equal((await run(shim, ["--version"], { cwd: project, env })).stdout.trim(), expected.version);
  } else {
    const shimText = await readFile(shim, "utf8");
    assert.match(shimText, /lib[\\/]cli\.js/);
  }
  const help = (await cliRun(["--help"])).stdout;
  assert.match(help, /doc-review/);
  assert.doesNotMatch(help, /human-review/i);
  await cliRun(["setup", "--global"]);
  for (const directory of [".claude", ".codex", ".agents"]) {
    const skill = await readFile(path.join(home, directory, "skills", "doc-review", "SKILL.md"), "utf8");
    assert.doesNotMatch(skill, /human-review/i);
    for (const text of ["Use only when the user explicitly invokes /doc-review", "truncated_fields", "12 hours", "--response-file response.json", "--review <reviewId> --entry <entryKey>"]) {
      assert.ok(skill.includes(text), `Installed skill missing ${text}`);
    }
    assert.doesNotMatch(skill, /--ack|There is no reply channel|fix every page/);
  }
  await cliRun(["setup"]);
  const guidance = await readFile(path.join(project, "AGENTS.md"), "utf8");
  for (const text of ["<!-- BEGIN doc-review -->", "Start only when the user explicitly invokes /doc-review", "truncated_fields"]) {
    assert.ok(guidance.includes(text), `Project guidance missing ${text}`);
  }
  await cliRun(["setup"]);
  assert.equal(await readFile(path.join(project, "AGENTS.md"), "utf8"), guidance);

  const obsolete = [
    [path.join(env.DOC_REVIEW_STATE_DIR, "state.json"), '{"pages":{},"batches":{"old":{"batch_id":"old"}}}'],
    [path.join(env.DOC_REVIEW_STATE_DIR, "history", "old.txt"), "Old history must remain untouched"],
    [path.join(env.DOC_REVIEW_STATE_DIR, "pasted", "old.png"), "Old staged bytes"],
  ];
  for (const [file, bytes] of obsolete) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  installedServer = path.join(installed, "lib", "server.js");
  await startServer();
  const contracts = await import(pathToFileURL(path.join(installed, "lib", "contracts", "index.js")).href);
  const agentTarget = path.join(project, "agent-review.html");
  await writeFile(agentTarget, "<p>Explain this without changing it.</p>");
  const agentOpen = contracts.agentOpenSchema.parse(JSON.parse((await cliRun([agentTarget, "--no-browser"])).stdout));
  const scope = { reviewId: agentOpen.review.reviewId, entryKey: agentOpen.review.entryKey };
  const scopeArgs = ["--review", scope.reviewId, "--entry", scope.entryKey];
  const post = async (body) => {
    const response = await fetch(`${base}/api/conversation`, {
      method: "POST", headers: { "content-type": "application/json", "x-doc-review-token": info.token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const thread = contracts.acceptedMutationSchema.parse(await post({
    operation: "create-thread", ...scope, requestId: "package-thread", expectedVersion: agentOpen.review.version,
    pageKey: scope.entryKey, target: { kind: "selection", anchor: { quote: "Explain this", prefix: "", suffix: "" } },
    body: "Why this wording?", intent: "discuss",
  })).receipt;
  await post({
    operation: "send", ...scope, requestId: "package-send", expectedVersion: thread.value.reviewVersion,
    pageKeys: [scope.entryKey], messages: [{ threadId: thread.value.threadId, messageId: thread.value.messageId, version: 1 }], edits: [],
  });
  const agentWork = contracts.agentPollSchema.parse(JSON.parse((await cliRun(["poll", ...scopeArgs, "--timeout", "5"])).stdout));
  const responseFile = path.join(project, "response.json");
  await writeFile(responseFile, JSON.stringify(contracts.completeResponseSchema.parse({
    operation: "respond", ...scope, requestId: "package-response", submissionId: agentWork.submission.submissionId,
    expectedVersion: agentWork.submission.version,
    responses: [{ threadId: thread.value.threadId, messageId: thread.value.messageId, messageVersion: 1,
      body: "It introduces the topic.", outcome: "answered" }], editOutcomes: [], resultNote: "Explained; no source changed.",
  })));
  const accepted = contracts.acceptedMutationSchema.parse(JSON.parse((await cliRun([
    "respond", ...scopeArgs, "--response-file", responseFile,
  ])).stdout));
  assert.equal(accepted.receipt.reviewId, scope.reviewId);
  assert.equal(await readFile(agentTarget, "utf8"), "<p>Explain this without changing it.</p>");
  const evidence = contracts.agentStatusSchema.parse(JSON.parse((await cliRun(["status", ...scopeArgs])).stdout));
  assert.equal(evidence.latestSubmission.state, "handled");

  const session = { path: `/r/${scope.reviewId}` };
  const shell = await fetch(new URL(session.path, base), { signal: AbortSignal.timeout(10_000) });
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /chrome\.js/);
  const css = await fetch(`${base}/chrome.css`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);
  assert.match(css.headers.get("cache-control"), /no-store/);
  assert.equal(css.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await css.text(), await readFile(path.join(installed, "lib", "ui", "chrome.css"), "utf8"));

  const seen = new Set();
  async function verifyModule(url, bundled = false) {
    if (seen.has(url)) return;
    seen.add(url);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, `Missing emitted browser module: ${url}`);
    assert.match(response.headers.get("content-type"), /javascript/);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const source = await response.text();
    const imports = [];
    const syntax = ts.createSourceFile(url, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        assert.ok(ts.isStringLiteralLike(node.moduleSpecifier), `Nonliteral module import: ${url}`);
        imports.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        assert.ok(node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]), `Nonliteral dynamic import: ${url}`);
        imports.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    }
    visit(syntax);
    if (bundled) {
      assert.deepEqual(imports, [], "The production shell must be a self-contained bundle");
      assert.equal(source, await readFile(path.join(installed, "lib", "ui", "chrome.js"), "utf8"));
      assert.doesNotMatch(source, /@vite\/client|react-refresh/);
    }
    for (const specifier of imports) {
      assert.match(specifier, /^\.\.?\/[^?#]+\.js$/, `Unsupported browser module import: ${specifier}`);
      const imported = new URL(specifier, url);
      assert.equal(imported.origin, base, "Browser modules must remain local");
      await verifyModule(imported.href);
    }
  }
  await verifyModule(`${base}/chrome.js`, true);
  await verifyModule(`${base}/sdk.js`);
  const opaqueSdk = await fetch(`${base}/sdk.js`, { headers: { origin: "null" }, signal: AbortSignal.timeout(10_000) });
  assert.equal(opaqueSdk.headers.get("access-control-allow-origin"), "null");
  if (browserRequested) {
    const { chromium, expect } = await import("@playwright/test");
    browser = await chromium.launch();
    await writeFile(path.join(evidenceDir, "browser-engine.json"), JSON.stringify({
      engine: "Chromium", version: browser.version(), executable: chromium.executablePath(),
      playwright: JSON.parse(await readFile(path.join(root, "node_modules", "@playwright", "test", "package.json"), "utf8")).version,
      platform: process.platform, node: process.version,
    }, null, 2));
    await conversationSmoke({
      browser, expect, project, state: env.DOC_REVIEW_STATE_DIR, evidenceDir, contracts, cliRun,
      connection: () => ({ base, token: info.token }),
      restart: async () => { const port = info.port; await stopServer(); await startServer(port); },
    });
    const selectors = "approved-parity.spec.js|responsive-conversation.spec.js|new-comment.spec.js|toolbar.spec.js|anchor-ordering.spec.js|result-discovery.spec.js|conversation-cards.spec.js|feedback-overlay.spec.js|local-placement.spec.js|conversation-adjacent.spec.js|thread-anchors.spec.js|source-save-compat.spec.js";
    try {
      const parity = await npmRun(["exec", "--", "playwright", "test", selectors, "--workers=4",
        `--output=${path.join(evidenceDir, "installed-parity")}`], root, {
        DOC_REVIEW_TEST_RUNTIME: path.join(installed, "lib"),
        DOC_REVIEW_TEST_ROOT: path.join(work, "parity-fixtures"),
        DOC_REVIEW_TEST_KEEP: keep ? "1" : "0",
      });
      await writeFile(path.join(evidenceDir, "installed-parity.log"), parity.stdout + parity.stderr);
      console.log(parity.stdout.trim().split("\n").at(-1));
    } catch (error) {
      await writeFile(path.join(evidenceDir, "installed-parity.log"), (error.stdout || "") + (error.stderr || ""));
      throw error;
    }
  }
  for (const [file, bytes] of obsolete) assert.equal(await readFile(file, "utf8"), bytes);
  await access(path.join(env.DOC_REVIEW_STATE_DIR, "conversation-state.json"));
  await assert.rejects(access(path.join(installed, "lib", "chrome-client.js")));
  const recordPath = path.join(env.DOC_REVIEW_STATE_DIR, "server.json");
  const lockPath = path.join(env.DOC_REVIEW_STATE_DIR, "server.lock");
  const record = await readFile(recordPath, "utf8"), lock = await readFile(lockPath, "utf8");
  const incompatible = JSON.stringify({ ...JSON.parse(record), protocol: 0 });
  try {
    await writeFile(recordPath, incompatible);
    await assert.rejects(cliRun([agentTarget, "--no-browser", "--timeout", "3"]), (error) => {
      const result = contracts.failureSchema.parse(JSON.parse(error.stdout));
      return error.code === 1 && /[Ii]ncompatible.*protocol/.test(result.error.message);
    });
    assert.equal(await readFile(recordPath, "utf8"), incompatible);
    assert.equal(await readFile(lockPath, "utf8"), lock);
    assert.equal(server.exitCode, null);
  } finally { await writeFile(recordPath, record); }
  const corruptDir = path.join(work, "corrupt-state");
  await mkdir(corruptDir);
  const corruptPath = path.join(corruptDir, "conversation-state.json");
  for (const bytes of ["{bad-json", '{"schemaVersion":999}']) {
    await writeFile(corruptPath, bytes);
    await assert.rejects(run(process.execPath, [cli, "status", ...scopeArgs], {
      cwd: project, env: { ...env, DOC_REVIEW_STATE_DIR: corruptDir }, timeout: 10_000,
    }), (error) => error.code === 1 && !!contracts.failureSchema.parse(JSON.parse(error.stdout)).error);
    assert.equal(await readFile(corruptPath, "utf8"), bytes);
    assert.deepEqual(await readdir(corruptDir), ["conversation-state.json"], "offline inspection must not start a server or acquire a lock");
  }
  await writeFile(path.join(evidenceDir, "adoption.json"), JSON.stringify({
    obsoletePreserved: obsolete.map(([file]) => path.relative(env.DOC_REVIEW_STATE_DIR, file)),
    distinctStore: "conversation-state.json", corruptAndUnsupportedRejected: true,
    incompatibleLiveServerPreserved: true, lockUnchanged: true,
  }, null, 2));
  succeeded = true;
  console.log(`Package evidence and archive: ${evidenceDir}`);
  console.log(`Installed package smoke passed: ${expected.name}@${expected.version}; ${seen.size} browser modules${browserRequested ? "; Chromium review ready" : ""}.`);
} catch (error) {
  console.error(`Failed installed-package fixture retained: ${work}`);
  await writeFile(path.join(evidenceDir, "failure.log"), error.stack || String(error));
  throw error;
} finally {
  await browser?.close();
  await stopServer();
  await writeFile(path.join(evidenceDir, "server.log"), serverLog);
  if (succeeded && !keep) await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  else if (succeeded) console.log(`Installed runtime and disposable fixtures retained: ${work}`);
}
