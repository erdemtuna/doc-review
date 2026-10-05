import assert from "node:assert/strict";
import { parseArgs } from "node:util";

export function packageOptions(args) {
  const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: true, options: {
    browser: { type: "boolean", default: false }, suite: { type: "string", default: "parity" },
    shard: { type: "string" }, workers: { type: "string", default: "2" },
  } });
  assert(positionals.length <= 1, "Provide at most one candidate archive");
  assert(["smoke", "preflight", "full", "parity"].includes(values.suite), "Unknown browser suite");
  assert(/^[1-4]$/.test(values.workers), "Workers must be between one and four");
  assert(values.browser || !tokens.some(token => token.kind === "option" && ["suite", "shard", "workers"].includes(token.name)),
    "Browser suite options require --browser");
  if (values.shard) {
    assert(values.suite === "full", "Only the full suite can be sharded");
    const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(values.shard);
    assert(match && Number(match[1]) <= Number(match[2]) && Number(match[2]) <= 8, "Invalid shard");
  }
  return { browser: values.browser, suite: values.suite, workers: Number(values.workers),
    shard: values.shard, archive: positionals[0] };
}
