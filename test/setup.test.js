import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COMMAND_NAME,
  NPX_COMMAND,
  PACKAGE_NAME,
  installSkills,
  invocation,
  isNpxCachePath,
  skillFor,
} from "../src/setup.js";

test("global setup installs the skill for Claude Code, Codex, and shared agents", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doc-review-setup-"));

  try {
    const result = installSkills(home, { global: true, home, command: NPX_COMMAND });
    for (const root of [".claude", ".codex", ".agents"]) {
      const skill = path.join(home, root, "skills", "doc-review", "SKILL.md");
      assert.equal(fs.existsSync(skill), true);
      const contents = fs.readFileSync(skill, "utf8");
      assert.match(contents, /npx -y @erdemtuna\/doc-review poll/);
      assert.match(contents, /--ack b_0123456789abcdef/);
    }
    assert.match(result.join("\n"), /Claude Code skill/);
    assert.match(result.join("\n"), /Codex skill/);
    assert.match(result.join("\n"), /Shared agents skill/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("global setup writes a bare command when doc-review is installed on PATH", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doc-review-setup-command-"));

  try {
    installSkills(home, { global: true, home, command: COMMAND_NAME });
    const contents = fs.readFileSync(path.join(home, ".agents", "skills", "doc-review", "SKILL.md"), "utf8");
    assert.match(contents, /doc-review poll/);
    assert.doesNotMatch(contents, /\bnpx\b/);
    assert.doesNotMatch(contents, /@erdemtuna\/doc-review/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("local setup substitutes the bare command in generated AGENTS guidance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doc-review-agents-"));

  try {
    installSkills(root, { command: COMMAND_NAME });
    const contents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    assert.match(contents, /doc-review poll/);
    assert.doesNotMatch(contents, /\bnpx\b/);
    assert.doesNotMatch(contents, /@erdemtuna\/doc-review/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skill substitution uses the scoped package as its single npx token", () => {
  const contents = skillFor(COMMAND_NAME);
  assert.match(contents, /doc-review poll/);
  assert.doesNotMatch(contents, /\bnpx\b/);
  assert.doesNotMatch(contents, new RegExp(PACKAGE_NAME.replace("/", "\\/")));
});

test("a binary from npm's _npx cache does not count as installed on PATH", () => {
  // `npx -y @erdemtuna/doc-review setup --global` resolves `which doc-review` to the
  // transient cache copy, which disappears when npx exits. Writing a bare
  // `doc-review` into SKILL.md on the strength of that leaves every later
  // agent run failing with "command not found".
  assert.equal(
    isNpxCachePath("/Users/x/.npm/_npx/f043fcd613c7efad/node_modules/.bin/doc-review"),
    true,
  );
  assert.equal(
    isNpxCachePath("C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\a1b2\\doc-review.cmd"),
    true,
  );

  // A real global install or `npm link` must still win.
  assert.equal(isNpxCachePath("/opt/homebrew/bin/doc-review"), false);
  assert.equal(isNpxCachePath("/usr/local/bin/doc-review"), false);

  // `_npx` only counts as a path segment, never as a substring of one.
  assert.equal(isNpxCachePath("/Users/x/my_npx_tools/bin/doc-review"), false);
});

test("the CLI lookup hides its child process window", () => {
  let options;
  invocation((_probe, _args, receivedOptions) => {
    options = receivedOptions;
    return { status: 1, stdout: "" };
  });

  assert.equal(options?.windowsHide, true);
});
