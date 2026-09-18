import assert from "node:assert/strict";
import { appendFile, chmod, copyFile, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "lib");
const source = path.join(root, "src");
const assets = ["chrome.html", "SKILL.md"];

if (output === source || path.dirname(output) !== path.resolve(root) || path.basename(output) !== "lib") {
  throw new Error("Refusing to clean an unexpected build output path");
}
const stat = await lstat(output).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
if (stat?.isSymbolicLink()) throw new Error("Refusing to clean a linked build output");
await rm(output, { recursive: true, force: true });

const checks = [
  "tsconfig.shared.json", "tsconfig.browser.json", "tsconfig.node.json",
  "tsconfig.ui.json", "tsconfig.ui-test.json", "tsconfig.tooling.json", "tsconfig.build.json",
];
for (const config of checks) {
  const result = spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", config], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await mkdir(output, { recursive: true });
await Promise.all(assets.map((asset) => copyFile(path.join(source, asset), path.join(output, asset))));
const ui = spawnSync(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build"], {
  cwd: root,
  // Keep prepack stdout clean for consumers of npm pack --json.
  stdio: ["inherit", process.stderr, process.stderr],
});
if (ui.error) throw ui.error;
if (ui.status !== 0) process.exit(ui.status ?? 1);
assert.deepEqual((await readdir(path.join(output, "ui"))).sort(), [
  "THIRD_PARTY_NOTICES.md", "chrome.css", "chrome.js",
], "UI output must match the explicit server asset routes; unexpected chunks need deliberate mappings");
const iconLicense = await readFile(path.join(root, "node_modules", "lucide-static", "LICENSE"), "utf8");
const componentLicense = await readFile(path.join(source, "ui", "components", "ui", "LICENSE.md"), "utf8");
await appendFile(path.join(output, "ui", "THIRD_PARTY_NOTICES.md"),
  `\n\n## lucide-static (generated icons)\n\n${iconLicense}\n\n## shadcn/ui (adapted components)\n\n${componentLicense}\n`);
await chmod(path.join(output, "cli.js"), 0o755);
