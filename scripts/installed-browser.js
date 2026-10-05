import assert from "node:assert/strict";
import path from "node:path";
import { homedir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { CANDIDATE_POLICY } from "./release-evidence.js";
import { toolingPhase } from "./tooling-phase.js";

const run = promisify(execFile);
export async function installedBrowserSuite({ root, installed, work, evidenceDir, env, options, tarBytes }) {
  const browserEnv = { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache") };
  const probe = await run(process.execPath, ["--input-type=module", "-e",
    "import {chromium} from '@playwright/test';process.stdout.write(chromium.executablePath())"],
  { cwd: root, env: { ...env, ...browserEnv }, timeout: 10_000 });
  assert.equal(probe.stdout, chromium.executablePath(), "Private HOME must retain the installed browser cache");
  const browserEnvironment = { ...env, ...browserEnv, DOC_REVIEW_TEST_RUNTIME: path.join(installed, "lib"),
    DOC_REVIEW_TEST_ROOT: path.join(work, "parity-fixtures"), DOC_REVIEW_TEST_KEEP: env.DOC_REVIEW_SMOKE_KEEP === "1" ? "1" : "0" };
  const cli = path.join(root, "node_modules", "@playwright", "test", "cli.js");
  let planned;
  if (options.suite === "full") {
    const result = await run(process.execPath, [cli, "test", "--list", "--reporter=json"],
      { cwd: root, env: browserEnvironment, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    planned = JSON.parse(result.stdout);
  }
  const parity = "approved-parity.spec.js|responsive-conversation.spec.js|new-comment.spec.js|toolbar.spec.js|anchor-ordering.spec.js|result-discovery.spec.js|conversation-cards.spec.js|feedback-overlay.spec.js|local-placement.spec.js|conversation-adjacent.spec.js|thread-anchors.spec.js|source-save-compat.spec.js|frontend-refinement.spec.js|feedback-readability.spec.js|changes-controls.spec.js";
  const selection = options.suite === "parity" ? [parity] : options.suite === "preflight"
    ? ["waiting-ux.spec.js", "fixture-isolation.spec.js"] : [];
  const report = path.join(evidenceDir, "browser-report.json");
  const startedAt = new Date().toISOString();
  console.log(`[installed-browser] ${options.suite}, shard ${options.shard ?? "1/1"}, workers ${options.workers}`);
  await toolingPhase(evidenceDir, "installed-browser", async () => {
    const log = createWriteStream(path.join(evidenceDir, "installed-parity.log"));
    const child = spawn(process.execPath, [cli, "test", ...selection, `--workers=${options.workers}`,
      ...(options.shard ? [`--shard=${options.shard}`] : []), "--fail-on-flaky-tests", "--max-failures=1",
      "--reporter=line,json", `--output=${path.join(evidenceDir, "installed-parity")}`],
    { cwd: root, env: { ...browserEnvironment, PLAYWRIGHT_JSON_OUTPUT_NAME: report }, stdio: ["ignore", "pipe", "pipe"],
      signal: AbortSignal.timeout(options.suite === "full" && !options.shard && options.workers === 1 ? 2_700_000 : 1_800_000) });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { log.write(bytes); process.stdout.write(bytes); });
    let processError;
    child.once("error", error => { processError = error; });
    try {
      const code = await new Promise(resolve => child.once("close", resolve));
      if (processError) throw processError;
      assert.equal(code, 0, "Installed browser suite failed");
    }
    finally { await new Promise(resolve => log.end(resolve)); }
  });
  if (planned) {
    const [index, total] = (options.shard ?? "1/1").split("/").map(Number);
    await writeFile(path.join(evidenceDir, "browser-evidence.json"), JSON.stringify({
      policy: CANDIDATE_POLICY, archiveSha256: createHash("sha256").update(tarBytes).digest("hex"), index, total, planned,
      report: JSON.parse(await readFile(report, "utf8")), startedAt, completedAt: new Date().toISOString(),
      sourceOnly: ["ui-foundations.spec.js"],
    }, null, 2));
  }
}
