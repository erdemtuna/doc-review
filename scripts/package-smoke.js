import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

async function npmRun(arguments_, cwd = root) {
  return run(process.execPath, [npm, ...arguments_], { cwd, env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
}

try {
  await Promise.all([prefix, home, project].map((directory) => mkdir(directory)));
  let tarball = tarballs[0] && path.resolve(tarballs[0]);
  if (!tarball) {
    // prepack rebuilds; this local test archive is never a publishable candidate.
    const packed = await npmRun(["pack", "--json", "--pack-destination", work]);
    const entries = Object.values(JSON.parse(packed.stdout));
    assert.equal(entries.length, 1);
    tarball = path.join(work, entries[0].filename);
  }
  await writeFile(path.join(prefix, "package.json"), JSON.stringify({
    name: "doc-review-installed-smoke",
    private: true,
    dependencies: { [expected.name]: `file:${tarball}` },
  }));
  await npmRun(["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], prefix);
  const installed = path.join(prefix, "node_modules", ...expected.name.split("/"));
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
  for (const asset of ["cli.js", "server-entry.js", "server.js", "chrome.html", "chrome.css", "SKILL.md"]) {
    await access(path.join(installed, "lib", asset));
  }
  await assert.rejects(access(path.join(prefix, "node_modules", "typescript")));
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
    for (const text of ["Use only when the user explicitly invokes /doc-review", "truncated_fields", "12 hours", "--ack b_0123456789abcdef"]) {
      assert.ok(skill.includes(text), `Installed skill missing ${text}`);
    }
  }
  await cliRun(["setup"]);
  const guidance = await readFile(path.join(project, "AGENTS.md"), "utf8");
  for (const text of ["<!-- BEGIN doc-review -->", "Start only when the user explicitly invokes /doc-review", "truncated_fields"]) {
    assert.ok(guidance.includes(text), `Project guidance missing ${text}`);
  }
  await cliRun(["setup"]);
  assert.equal(await readFile(path.join(project, "AGENTS.md"), "utf8"), guidance);

  server = fork(fileURLToPath(new URL("./package-smoke-server.js", import.meta.url)), [path.join(installed, "lib", "server.js")], {
    cwd: project,
    env,
    execPath: process.execPath,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  server.stdout.on("data", (chunk) => { serverLog += chunk; });
  server.stderr.on("data", (chunk) => { serverLog += chunk; });
  const [info] = await Promise.race([
    once(server, "message", { signal: AbortSignal.timeout(15_000) }),
    once(server, "exit").then(([code]) => { throw new Error(`Installed server exited ${code}: ${serverLog}`); }),
  ]);
  const base = `http://127.0.0.1:${info.port}`;
  const target = path.join(project, "review.html");
  await writeFile(target, "<!doctype html><html><head><title>Package smoke</title></head><body><h1>Installed package review</h1><p>Compiled runtime.</p></body></html>");
  const opened = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-doc-review-token": info.token },
    body: JSON.stringify({ target }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(opened.status, 200, await opened.clone().text());
  const session = await opened.json();
  const shell = await fetch(new URL(session.path, base), { signal: AbortSignal.timeout(10_000) });
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /chrome\.js/);
  const css = await fetch(`${base}/chrome.css`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);

  const seen = new Set();
  async function verifyModule(url) {
    if (seen.has(url)) return;
    seen.add(url);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, `Missing emitted browser module: ${url}`);
    assert.match(response.headers.get("content-type"), /javascript/);
    const source = await response.text();
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)["'](\.[^"']+\.js)["']/g)) {
      await verifyModule(new URL(match[1], url).href);
    }
  }
  await verifyModule(`${base}/chrome.js`);
  await verifyModule(`${base}/sdk.js`);
  if (browserRequested) {
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(new URL(session.path, base).href);
    await page.locator('#frame[data-sdk-ready="true"]').waitFor({ timeout: 15_000 });
    assert.equal(await page.frameLocator("#frame").locator("h1").textContent(), "Installed package review");
    assert.deepEqual(errors, []);
  }
  console.log(`Installed package smoke passed: ${expected.name}@${expected.version}; ${seen.size} browser modules${browserRequested ? "; Chromium review ready" : ""}.`);
} finally {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    if (server.connected) server.send("stop");
    const timer = setTimeout(() => server.kill(), 5_000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
