import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";

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
    const page = await browser.newPage();
    const errors = [];
    const remoteRequests = [];
    // The authored iframe uses the same server on a separate loopback origin.
    const localOrigins = new Set([base, `http://localhost:${info.port}`]);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (["http:", "https:"].includes(url.protocol) && !localOrigins.has(url.origin)) remoteRequests.push(url.href);
    });
    await page.goto(new URL(session.path, base).href);
    await page.locator('#frame[data-sdk-ready="true"]').waitFor({ timeout: 15_000 });
    assert.equal(await page.frameLocator("#frame").locator("h1").textContent(), "Installed package review");
    const originalFrame = await page.locator("#frame").elementHandle();
    await page.locator("#seeChanges").click();
    assert.equal(await page.locator("#historyPanel").isVisible(), true);
    await page.locator("#theme").click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page.locator("#latestVersion").click();
    await page.locator("#modeButton").click();
    await page.getByRole("menuitemradio", { name: /^Edit/ }).waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#modeMenu").waitFor({ state: "hidden" });
    await page.locator("#commentsButton").click();
    await page.locator("#empty").waitFor();
    assert.equal(await page.locator("#cards article").count(), 0);
    await page.locator("#note").fill("Preserve installed-package feedback");
    await page.locator("#drawerClose").click();
    await page.locator("#drawer").waitFor({ state: "hidden" });
    await page.locator("#commentsButton").click();
    assert.equal(await page.locator("#note").inputValue(), "Preserve installed-package feedback");
    await page.locator("#drawerClose").click();
    const frame = page.frameLocator("#frame");
    await frame.locator("p").evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await frame.locator("#commentAction").click();
    await page.locator("#composeText").fill("Installed contextual feedback");
    await page.locator("#composeAdd").click();
    await page.locator("#compose").waitFor({ state: "hidden" });
    await frame.locator("mark[data-eh-mark]").click();
    await page.locator("#alignedCard").getByRole("button", { name: "Edit comment" }).click();
    assert.equal(await page.locator("#alignedCard textarea").inputValue(), "Installed contextual feedback");
    await page.locator("#alignedCard textarea").press("Escape");
    const deleteAction = page.locator("#alignedCard").getByRole("button", { name: "Delete comment" });
    await deleteAction.click();
    await page.locator("#alignedCard").getByRole("button", { name: "Delete", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await deleteAction.waitFor();
    assert.equal(await deleteAction.evaluate((element) => document.activeElement === element), true);
    assert.equal(await page.locator("#frame").evaluate((element, original) => element === original, originalFrame), true);
    await originalFrame.dispose();

    await page.locator("#commentsButton").click();
    const note = page.getByLabel("Overall note");
    await expect(note).toHaveValue("Preserve installed-package feedback");
    await page.locator("#endReview").click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await expect(confirmation).toContainText("only in this tab");
    await page.keyboard.press("Escape");
    await expect(confirmation).toBeHidden();
    await expect(page.locator("#endReview")).toBeFocused();
    await expect(note).toHaveValue("Preserve installed-package feedback");
    await expect(page.locator("#drawer")).toHaveClass(/open/);

    await page.locator("#drawerClose").click();
    await page.locator("#modeButton").click();
    await page.getByRole("menuitemradio", { name: /^Edit/ }).click();
    await page.locator("#modeMenu").waitFor({ state: "hidden" });
    await expect(frame.locator("body")).toHaveAttribute("contenteditable", "true");
    await frame.locator("h1").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Installed edit.");
    await expect.poll(() => readFile(target, "utf8")).toContain("Installed package review Installed edit.");
    await page.locator("#commentsButton").click();
    await expect(page.locator("#editCount")).toHaveText("1");
    await expect(page.locator("#saveText")).toContainText("Saved to");
    await page.locator("#revert").click();
    await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator("#revert")).toBeFocused();
    await expect(page.locator("#editCount")).toHaveText("1");
    await page.locator("#revert").click();
    await confirmation.getByRole("button", { name: "Revert all", exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(frame.locator("h1")).toHaveText("Installed package review");
    await page.locator('#frame[data-sdk-ready="true"]').waitFor({ timeout: 15_000 });
    await expect(note).toHaveValue("Preserve installed-package feedback");

    const sent = page.waitForResponse((response) =>
      response.request().method() === "POST" && /\/api\/page\/[^/]+\/send$/.test(new URL(response.url()).pathname));
    await page.locator("#send").click();
    const sentResponse = await sent;
    assert.equal(sentResponse.status(), 200);
    const sentBatch = await sentResponse.json();
    assert.ok(sentBatch.roundId);
    await expect(note).toHaveValue("");
    await expect(page.locator("#send")).toBeDisabled();
    await expect(page.locator("#send")).toHaveText(/Sent|Feedback delivered/);
    await page.locator("#drawerClose").click();
    const delivered = await fetch(`${base}/api/poll?target=${encodeURIComponent(target)}`, {
      headers: { "x-doc-review-token": info.token }, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(delivered.status, 200);
    const batch = await delivered.json();
    assert.ok(batch.batch_id);
    await writeFile(target, "<!doctype html><html><head><title>Package smoke</title></head><body><h1>Installed package review</h1><p>Updated installed runtime.</p></body></html>");
    const acknowledged = await fetch(`${base}/api/poll?target=${encodeURIComponent(target)}&ack=${batch.batch_id}`, {
      headers: { "x-doc-review-token": info.token }, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(acknowledged.status, 200);
    await acknowledged.body.cancel();
    await expect.poll(async () => {
      const response = await fetch(`${base}/api/session/${session.sessionId}/history/${sentBatch.roundId}`, {
        headers: { "x-doc-review-token": info.token }, signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      return result.round?.targets[0]?.captureStatus;
    }, { timeout: 30_000 }).toBe("ready");
    await page.locator("#seeChanges").click();
    await page.getByRole("button", { name: "Content", exact: true }).click();
    await expect(page.locator("#changeDetail")).toContainText("Updated installed runtime.");
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await expect(page.locator("#changeDetail")).toContainText("<p>");
    assert.equal(await page.locator("#changeDetail script, #changeDetail iframe, #changeDetail img").count(), 0);
    await page.locator("#latestVersion").click();
    await page.locator("#commentsButton").click();
    await page.locator("#endReview").click();
    await confirmation.getByRole("button", { name: "End review", exact: true }).click();
    await expect(page.locator(".ended")).toBeVisible();
    await expect(confirmation).toBeHidden();
    assert.deepEqual(errors, []);
    assert.deepEqual(remoteRequests, [], "Installed shell must not require a CDN or development server");
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
