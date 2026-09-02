import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

const CODEX_BLOCK = `
## Reviewing files and localhost pages with doc-review

After writing an HTML or Markdown file the user will read, open it for them with
\`${NPX_COMMAND} <file.html>\`. For a locally running web page, open the real
route with \`${NPX_COMMAND} http://localhost:3000/path\` instead of recreating
it as a static file. Then block on
\`${NPX_COMMAND} poll <target> --timeout 600\` until they send feedback.
If it prints \`{"status":"timeout"}\`, no feedback arrived yet — run the same
poll command again to keep waiting. When a \`{"status":"feedback"}\` batch
arrives, apply it, then run the exact acknowledgement command in its
\`next_step\`, which uses \`--ack <batch_id>\`.

Keep the poll command in the foreground and do not end the turn while it waits.
If the shell returns a process or session handle, keep waiting on that handle until
the command exits. \`${NPX_COMMAND} status <target>\` reports instantly
whether feedback is already waiting, without blocking.

The batch groups feedback by page under \`pages\`, so fix every page listed. Items
under \`edits\` are changes the user already made: \`after\` is their exact wording,
so carry it across verbatim and never revert it — and if the HTML was generated
from MDX or Markdown, apply it to the source too. Markdown files open rendered
and are never written by doc-review: apply their comments and edits to the
Markdown source, keeping its syntax. There is no reply channel; the user sees
your work when the page reloads. For a localhost page, direct edits and deletions
arrive with \`kind: "url"\`; find and update the matching MDX, TSX, template, or
component source. Never write the rendered HTTP response over project source.
`;

export function installSkills(cwd, { global: isGlobal = false, home = os.homedir(), command } = {}) {
  const done = [];
  const cmd = command || invocation();

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
    const agents = path.join(cwd, "AGENTS.md");
    const existing = fs.existsSync(agents) ? fs.readFileSync(agents, "utf8") : "";
    if (existing.includes("doc-review")) {
      done.push("AGENTS.md already mentions doc-review — left it alone");
    } else {
      const block = CODEX_BLOCK.replaceAll(NPX_COMMAND, cmd);
      fs.writeFileSync(agents, existing ? `${existing.trimEnd()}\n${block}` : block.trimStart());
      done.push(`${existing ? "Updated" : "Created"} AGENTS.md   (Codex)`);
    }
  }

  done.push("", `Agents will be told to run: ${cmd}`);
  if (cmd.startsWith("npx")) {
    done.push(`Heads up: npx only works once ${PACKAGE_NAME} is published. Run \`npm link\` in the`);
    done.push("doc-review folder first if you want to use it locally, then re-run setup.");
  }
  done.push("Any other agent works too — see the JSON contract in the README.");
  return done;
}
