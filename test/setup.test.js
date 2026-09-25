import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { GUIDANCE_BEGIN, GUIDANCE_END, LEGACY_GUIDANCE } from "../lib/setup-guidance.js";

import {
  COMMAND_NAME,
  NPX_COMMAND,
  PACKAGE_NAME,
  installSkills,
  invocation,
  isNpxCachePath,
  skillFor,
} from "../lib/setup.js";

test("skill activation requires an explicit interactive review request", () => {
  const contents = skillFor(COMMAND_NAME);
  const description = contents.match(/^description: (.+)$/m)?.[1];

  assert.match(contents, /^name: doc-review$/m);
  assert.match(description, /Use only when the user explicitly invokes \/doc-review/);
  assert.match(description, /Do not invoke merely because you write, update, discuss, or review/);
  assert.match(contents, /Another skill's\s+automatic\s+review step is not user permission/);
  assert.match(contents, /without opening a review or polling/);
  assert.match(contents, /After the explicit review request/);
  assert.doesNotMatch(contents, /Use after writing or updating something the user will read/);
});

test("global setup installs the skill for Claude Code, Codex, and shared agents", () => {
  const home = fs.mkdtempSync(path.join(process.cwd(), ".setup-test-"));

  try {
    const result = installSkills(home, { global: true, home, command: NPX_COMMAND });
    for (const root of [".claude", ".codex", ".agents"]) {
      const skill = path.join(home, root, "skills", "doc-review", "SKILL.md");
      assert.equal(fs.existsSync(skill), true);
      const contents = fs.readFileSync(skill, "utf8");
      assert.match(contents, /npx -y @erdemtuna\/doc-review poll/);
      assert.match(contents, /respond --review <reviewId> --entry <entryKey> --response-file response.json/);
      assert.doesNotMatch(contents, /--ack|There is no reply channel/);
      assert.match(contents, /Use only when the user explicitly invokes \/doc-review/);
    }
    assert.match(result.join("\n"), /Claude Code skill/);
    assert.match(result.join("\n"), /Codex skill/);
    assert.match(result.join("\n"), /Shared agents skill/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("project setup gates both skill and AGENTS instructions on explicit review", () => {
  const cwd = fs.mkdtempSync(path.join(process.cwd(), ".setup-test-"));

  try {
    const existing = "# Project instructions\n\nPreserve this guidance.\n";
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), existing);
    installSkills(cwd, { command: COMMAND_NAME });

    const skill = fs.readFileSync(path.join(cwd, ".claude", "skills", "doc-review", "SKILL.md"), "utf8");
    const agents = fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
    assert.match(skill, /Use only when the user explicitly invokes \/doc-review/);
    assert.ok(agents.startsWith(existing));
    assert.match(agents, /Start only when the user explicitly invokes \/doc-review/);
    assert.match(agents, /Another skill's automatic\s+review step is not user permission/);
    assert.doesNotMatch(agents, /After writing an HTML or Markdown file the user will read/);
    assert.match(agents, /--response-file response.json/);
    assert.doesNotMatch(agents, /--ack|There is no reply channel/);

    installSkills(cwd, { command: COMMAND_NAME });
    assert.equal(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8"), agents);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("global setup writes a bare command when doc-review is installed on PATH", () => {
  const home = fs.mkdtempSync(path.join(process.cwd(), ".setup-test-"));

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
  const root = fs.mkdtempSync(path.join(process.cwd(), ".setup-test-"));

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

test("invocation keeps the existing PATH and npx-cache distinction", () => {
  for (const [resolved, expected] of [
    ["C:\\tools\\doc-review.cmd", COMMAND_NAME],
    ["C:\\project\\node_modules\\.bin\\doc-review.cmd", COMMAND_NAME],
    ["C:\\npm-cache\\_npx\\123\\doc-review.cmd", NPX_COMMAND],
  ]) {
    assert.equal(invocation(() => ({ status: 0, stdout: `${resolved}\r\n` })), expected);
  }
  assert.equal(invocation(() => ({ status: 1, stdout: "" })), NPX_COMMAND);
});

function project(t, existing) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".setup-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agents = path.join(root, "AGENTS.md");
  if (existing !== undefined) fs.writeFileSync(agents, existing);
  return { root, agents, read: () => fs.readFileSync(agents, "utf8") };
}

function assertManaged(contents, command) {
  assert.equal(contents.split(GUIDANCE_BEGIN).length, 2);
  assert.equal(contents.split(GUIDANCE_END).length, 2);
  assert.match(contents, /Start only when the user explicitly invokes \/doc-review/);
  assert.match(contents, /Another skill's automatic\s+review step is not user permission/);
  assert.ok(contents.includes(`${command} poll --review <reviewId> --entry <entryKey> --timeout 600`));
  assert.match(contents, /Without `--timeout`, the CLI defaults to a 12-hour cutoff/);
  assert.match(contents, /`--timeout` is one end-to-end deadline, including server discovery and reconnect/);
  assert.match(contents, /bounded foreground `--timeout 600` loop/);
  assert.match(contents, /Reuse the identical file and request ID on transport retries/);
  assert.match(contents, /never repeat\s+source edits because a connection was lost/);
  assert.match(contents, /For non-truncated edits,\s+`after` is their exact wording/);
  assert.match(contents, /200,000 Unicode code points each/);
  assert.match(contents, /`truncated: true` identifies clipped fields in the `truncated_fields` array/);
  assert.match(contents, /Never apply incomplete text or HTML as a complete replacement or invent missing\s+text/);
  assert.match(contents, /only from an authoritative source; otherwise ask the\s+user for the complete edit/);
  assert.match(contents, /responses` must cover every submitted message exactly once/);
  assert.match(contents, /not live agent availability/);
  assert.doesNotMatch(contents, /--ack|There is no reply channel|fix every page/);
  assert.doesNotMatch(contents, /After writing an HTML or Markdown file the user will read/);
  assert.doesNotMatch(contents, /disable-model-invocation/);
}

test("legacy fingerprints remain frozen when current guidance changes", () => {
  assert.deepEqual(LEGACY_GUIDANCE.map((body) => createHash("sha256").update(body).digest("hex")), [
    "acc70f9b56b2563d900d01487d76b63b9a27098c09c78e595967dad1441a1046",
    "7801886d6dacc219a1bc095caf731903c30d653d2be9b2be37f042c2b8448a9a",
  ]);
});

for (const command of [COMMAND_NAME, NPX_COMMAND]) {
  test(`new project guidance is owned and idempotent (${command})`, (t) => {
    const fixture = project(t);
    installSkills(fixture.root, { command });
    const contents = fixture.read();
    assertManaged(contents, command);
    const modified = fs.statSync(fixture.agents).mtimeMs;
    installSkills(fixture.root, { command });
    assert.equal(fixture.read(), contents);
    assert.equal(fs.statSync(fixture.agents).mtimeMs, modified);
    assert.equal(fs.existsSync(path.join(fixture.root, ".codex")), false);
    assert.equal(fs.existsSync(path.join(fixture.root, ".agents")), false);
  });

  for (const newline of ["\n", "\r\n"]) {
    test(`append preserves all existing bytes (${command}, ${JSON.stringify(newline)})`, (t) => {
      const original = `\uFEFF# User instructions${newline}Keep café and 😀.\t ${newline}${newline}  `;
      const fixture = project(t, original);
      installSkills(fixture.root, { command });
      const contents = fixture.read();
      assert.ok(contents.startsWith(original));
      assertManaged(contents, command);
      if (newline === "\r\n") assert.doesNotMatch(contents, /(?<!\r)\n/);
      installSkills(fixture.root, { command });
      assert.equal(fixture.read(), contents);
    });

    test(`owned replacement preserves surroundings (${command}, ${JSON.stringify(newline)})`, (t) => {
      const before = "\uFEFF# User rules\r\nKeep trailing spaces.  \n\n";
      const after = "\r\n\r\n## My doc-review notes\nKeep this exact café text.\t ";
      const original = before + [GUIDANCE_BEGIN, "stale body", GUIDANCE_END].join(newline) + after;
      const fixture = project(t, original);
      installSkills(fixture.root, { command });
      const contents = fixture.read();
      assert.ok(contents.startsWith(before));
      assert.ok(contents.endsWith(after));
      assertManaged(contents, command);
      const owned = contents.slice(before.length, -after.length);
      assert.doesNotMatch(owned, /stale body/);
      if (newline === "\r\n") assert.doesNotMatch(owned, /(?<!\r)\n/);
      installSkills(fixture.root, { command });
      assert.equal(fixture.read(), contents);
    });

    for (const [version, legacy] of LEGACY_GUIDANCE.entries()) {
      test(`migrate exact legacy ${version} (${command}, ${JSON.stringify(newline)})`, (t) => {
        const before = `\uFEFF# User rules${newline}Keep these.  ${newline}${newline}`;
        const after = `${newline}${newline}## Other rules${newline}Keep these too.\t `;
        const old = legacy.replaceAll(NPX_COMMAND, command).replaceAll("\n", newline);
        const fixture = project(t, before + old + after);
        const result = installSkills(fixture.root, { command });
        const contents = fixture.read();
        assert.match(result.join("\n"), /Migrated legacy/);
        assert.ok(contents.startsWith(before));
        assert.ok(contents.endsWith(after));
        assertManaged(contents, command);
        if (newline === "\r\n") assert.doesNotMatch(contents, /(?<!\r)\n/);
        installSkills(fixture.root, { command });
        assert.equal(fixture.read(), contents);
      });
    }
  }
}

for (const original of [
  "## Reviewing files and localhost pages with doc-review\n\nCustom workflow.\n",
  "# Rules\nNever use doc-review automatically.\n",
  LEGACY_GUIDANCE[0].replace("After writing", "Sometimes after writing"),
  `${LEGACY_GUIDANCE[0]}\n\nOnly do this after my approval.\n`,
  `${LEGACY_GUIDANCE[1]}\n### Custom details\nRetain these.\n`,
  `# doc-review preferences\n\n${LEGACY_GUIDANCE[0]}\n`,
  LEGACY_GUIDANCE[1].replace(`${NPX_COMMAND} poll`, `${COMMAND_NAME} poll`),
]) {
  test(`custom guidance remains untouched: ${original.slice(0, 55)}`, (t) => {
    const fixture = project(t, original);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = installSkills(fixture.root, { command: NPX_COMMAND });
      assert.equal(fixture.read(), original);
      assert.match(result.join("\n"), /custom or unrecognized.*left it unchanged/);
      assert.match(result.join("\n"), /Manually reconcile/);
      assert.equal(fixture.read().includes(GUIDANCE_BEGIN), false);
    }
  });
}

for (const original of [
  GUIDANCE_BEGIN,
  GUIDANCE_END,
  `${GUIDANCE_END}\n${GUIDANCE_BEGIN}`,
  `${GUIDANCE_BEGIN}\n${GUIDANCE_BEGIN}\n${GUIDANCE_END}`,
  `${GUIDANCE_BEGIN}\n${GUIDANCE_END}\n${GUIDANCE_BEGIN}\n${GUIDANCE_END}`,
  ` ${GUIDANCE_BEGIN}\n${GUIDANCE_END}`,
  "<!-- BEGIN doc-review\nstale\n<!-- END doc-review -->",
  "<!-- begin doc-review -->\nstale\n<!-- end doc-review -->",
  `${GUIDANCE_BEGIN} ${GUIDANCE_END}`,
  `${LEGACY_GUIDANCE[0]}\n\n${LEGACY_GUIDANCE[1]}\n`,
]) {
  test(`ambiguous ownership fails before any writes: ${original.slice(0, 70)}`, (t) => {
    const fixture = project(t, original);
    const skill = path.join(fixture.root, ".claude", "skills", "doc-review", "SKILL.md");
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, "Existing customized skill.\r\n");
    assert.throws(
      () => installSkills(fixture.root, { command: COMMAND_NAME }),
      /AGENTS\.md.*(?:markers|ambiguous).*No setup files were changed/,
    );
    assert.equal(fixture.read(), original);
    assert.equal(fs.readFileSync(skill, "utf8"), "Existing customized skill.\r\n");
  });
}

test("invalid UTF-8 fails before modifying setup destinations", (t) => {
  const original = Buffer.from([0xff, 0xfe, 0x41]);
  const fixture = project(t, original);
  assert.throws(() => installSkills(fixture.root, { command: COMMAND_NAME }), /not valid UTF-8/);
  assert.deepEqual(fs.readFileSync(fixture.agents), original);
  assert.equal(fs.existsSync(path.join(fixture.root, ".claude")), false);
});

test("global setup does not inspect or modify project AGENTS", (t) => {
  const fixture = project(t, GUIDANCE_BEGIN);
  installSkills(fixture.root, { global: true, home: fixture.root, command: NPX_COMMAND });
  assert.equal(fixture.read(), GUIDANCE_BEGIN);
  for (const root of [".claude", ".codex", ".agents"]) {
    assert.equal(fs.existsSync(path.join(fixture.root, root, "skills", "doc-review", "SKILL.md")), true);
  }
});

test("an entire legacy file migrates and an owned block can change commands", (t) => {
  const fixture = project(t, LEGACY_GUIDANCE[0]);
  installSkills(fixture.root, { command: COMMAND_NAME });
  assertManaged(fixture.read(), COMMAND_NAME);
  assert.doesNotMatch(fixture.read(), /\bnpx\b/);
  installSkills(fixture.root, { command: NPX_COMMAND });
  const contents = fixture.read();
  assertManaged(contents, NPX_COMMAND);
  installSkills(fixture.root, { command: NPX_COMMAND });
  assert.equal(fixture.read(), contents);
});

test("invalid ownership does not create a new skill directory", (t) => {
  const fixture = project(t, GUIDANCE_BEGIN);
  assert.throws(() => installSkills(fixture.root, { command: COMMAND_NAME }), /ownership markers/);
  assert.equal(fs.existsSync(path.join(fixture.root, ".claude")), false);
  assert.equal(fixture.read(), GUIDANCE_BEGIN);
});
