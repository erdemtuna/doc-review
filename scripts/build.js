import { chmod, copyFile, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "lib");
const source = path.join(root, "src");
const assets = ["chrome.html", "chrome.css", "SKILL.md"];

if (output === source || path.dirname(output) !== path.resolve(root) || path.basename(output) !== "lib") {
  throw new Error("Refusing to clean an unexpected build output path");
}
const stat = await lstat(output).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
if (stat?.isSymbolicLink()) throw new Error("Refusing to clean a linked build output");
await rm(output, { recursive: true, force: true });

const checks = ["tsconfig.shared.json", "tsconfig.browser.json", "tsconfig.node.json", "tsconfig.build.json"];
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
await chmod(path.join(output, "cli.js"), 0o755);
