import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

export async function toolingPhase(directory, phase, action, { summaryFile } = {}) {
  if (!/^[a-z][a-z0-9-]+$/.test(phase)) throw new Error("Invalid tooling phase");
  fs.mkdirSync(directory, { recursive: true });
  const startedAt = new Date().toISOString(), start = performance.now();
  console.log(`[${phase}] started`);
  let status = "failed";
  try { const result = await action(); status = "passed"; return result; }
  finally {
    const record = { phase, startedAt, completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - start), status };
    fs.appendFileSync(path.join(directory, "phases.jsonl"), `${JSON.stringify(record)}\n`);
    if (summaryFile) fs.appendFileSync(summaryFile, `\n**${phase}:** ${status}, ${record.durationMs}ms.\n`);
    console.log(`[${phase}] ${status} (${record.durationMs}ms)`);
  }
}

export async function ciToolingPhase(phase, action, env = process.env) {
  if (!env.RUNNER_TEMP) return action();
  return toolingPhase(path.join(env.RUNNER_TEMP, "doc-review-phases"), phase, action,
    { summaryFile: env.GITHUB_STEP_SUMMARY });
}
