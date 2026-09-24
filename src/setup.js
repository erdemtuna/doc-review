import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { updateGuidance } from "./setup-guidance.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_NAME = "@erdemtuna/doc-review";
export const COMMAND_NAME = "doc-review";
export const NPX_COMMAND = `npx -y ${PACKAGE_NAME}`;

/**
 * Teach agents the command that will actually work here. A global install or
 * `npm link` puts `doc-review` on PATH; otherwise fall back to npx, which only
 * resolves once the package is published.
 *
 * The probe has to discount its own npx run. `${NPX_COMMAND} setup --global`
 * puts this package on PATH for the duration of that one command, out of npm's
 * `_npx` cache, so a naive `which` succeeds and setup writes a bare
 * `doc-review` into SKILL.md. That binary is gone the moment npx exits, and
 * every later agent invocation dies with "command not found".
 */
export function invocation(run = spawnSync) {
  const probe = process.platform === "win32" ? "where" : "which";
  const found = run(probe, [COMMAND_NAME], { encoding: "utf8", windowsHide: true });
  const resolved = found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0].trim() : "";
  return resolved && !isNpxCachePath(resolved) ? COMMAND_NAME : NPX_COMMAND;
}

/** True for a binary npm placed in its transient `_npx` cache for one command. */
export function isNpxCachePath(binPath) {
  return binPath.split(/[\\/]/).includes("_npx");
}

/**
 * Quote a path for copy-paste into any shell. JSON.stringify would double
 * Windows backslashes; plain double quotes work in bash, zsh, cmd and
 * PowerShell alike, and paths cannot legally contain a double quote on Windows.
 */
export function shellQuote(arg) {
  const text = String(arg);
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `"${text.replaceAll('"', '\\"')}"`;
}

/** The skill lives in its own markdown file so nothing needs escaping. */
export const readSkill = () => fs.readFileSync(path.join(here, "SKILL.md"), "utf8");

export const skillFor = (cmd) => readSkill().replaceAll(NPX_COMMAND, cmd);

const codexBlock = () => readSkill().replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\s*/, "")
  .replace(/^# doc-review/, "## Reviewing files and localhost pages with doc-review");

export function installSkills(cwd, { global: isGlobal = false, home = os.homedir(), command } = {}) {
  const done = [];
  const cmd = command || invocation();
  const agents = path.join(cwd, "AGENTS.md");
  let guidance;
  let existing;
  if (!isGlobal) {
    const bytes = fs.existsSync(agents) ? fs.readFileSync(agents) : Buffer.alloc(0);
    existing = bytes.toString("utf8");
    if (!Buffer.from(existing, "utf8").equals(bytes)) {
      throw new Error("AGENTS.md is not valid UTF-8; convert it before re-running setup. No setup files were changed.");
    }
    guidance = updateGuidance(existing, codexBlock().replaceAll(NPX_COMMAND, cmd));
  }

  const skillRoots = isGlobal
    ? [
        ["Claude Code", path.join(home, ".claude")],
        ["Codex", path.join(home, ".codex")],
        ["Shared agents", path.join(home, ".agents")],
      ]
    : [["Claude Code", path.join(cwd, ".claude")]];

  for (const [agent, base] of skillRoots) {
    const skillFile = path.join(base, "skills", "doc-review", "SKILL.md");
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, skillFor(cmd));
    done.push(`${agent} skill  ${skillFile}${isGlobal ? "   (all projects)" : ""}`);
  }

  if (!isGlobal) {
    if (guidance.contents !== existing) fs.writeFileSync(agents, guidance.contents);
    done.push(guidance.message);
  }

  done.push("", `Agents will be told to run: ${cmd}`);
  if (cmd.startsWith("npx")) {
    done.push(`Heads up: npx only works once ${PACKAGE_NAME} is published. Run \`npm link\` in the`);
    done.push("doc-review folder first if you want to use it locally, then re-run setup.");
  }
  done.push("Any other agent works too — see the JSON contract in the README.");
  return done;
}
