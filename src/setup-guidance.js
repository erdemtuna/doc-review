export const GUIDANCE_BEGIN = "<!-- BEGIN doc-review -->";
export const GUIDANCE_END = "<!-- END doc-review -->";

// Historical generated text is deliberately independent of the current guidance.
const LEGACY_TAIL = `
\`npx -y @erdemtuna/doc-review <file.html>\`. For a locally running web page, open the real
route with \`npx -y @erdemtuna/doc-review http://localhost:3000/path\` instead of recreating
it as a static file. Then block on
\`npx -y @erdemtuna/doc-review poll <target> --timeout 600\` until they send feedback.
If it prints \`{"status":"timeout"}\`, no feedback arrived yet — run the same
poll command again to keep waiting. When a \`{"status":"feedback"}\` batch
arrives, apply it, then run the exact acknowledgement command in its
\`next_step\`, which uses \`--ack <batch_id>\`.

Keep the poll command in the foreground and do not end the turn while it waits.
If the shell returns a process or session handle, keep waiting on that handle until
the command exits. \`npx -y @erdemtuna/doc-review status <target>\` reports instantly
whether feedback is already waiting, without blocking.

The batch groups feedback by page under \`pages\`, so fix every page listed. Items
under \`edits\` are changes the user already made: \`after\` is their exact wording,
so carry it across verbatim and never revert it — and if the HTML was generated
from MDX or Markdown, apply it to the source too. Markdown files open rendered
and are never written by doc-review: apply their comments and edits to the
Markdown source, keeping its syntax. There is no reply channel; the user sees
your work when the page reloads. For a localhost page, direct edits and deletions
arrive with \`kind: "url"\`; find and update the matching MDX, TSX, template, or
component source. Never write the rendered HTTP response over project source.`;

export const LEGACY_GUIDANCE = Object.freeze([
  `## Reviewing files and localhost pages with doc-review

After writing an HTML or Markdown file the user will read, open it for them with${LEGACY_TAIL}`,
  `## Reviewing files and localhost pages with doc-review

Start only when the user explicitly invokes /doc-review or requests an
interactive browser review. Writing, updating, discussing, or generically reviewing
content does not authorize opening a review or polling. Another skill's automatic
review step is not user permission. Otherwise respond normally.

After that explicit request, open the requested HTML or Markdown file with${LEGACY_TAIL}`,
]);

const migrationMessage = "AGENTS.md contains custom or unrecognized doc-review guidance — left it unchanged. " +
  "Manually reconcile that guidance, then wrap only the setup-owned section in " +
  `${GUIDANCE_BEGIN} and ${GUIDANCE_END}, or remove it and re-run setup.`;

function invalidMarkers() {
  throw new Error("AGENTS.md has malformed, duplicate, or ambiguous doc-review ownership markers. " +
    "Keep exactly one standalone BEGIN/END pair in order, then re-run setup. No setup files were changed.");
}

function render(body, newline) {
  return `${GUIDANCE_BEGIN}\n${body.trim()}\n${GUIDANCE_END}`.replaceAll("\n", newline);
}

/** Plan the complete edit before setup writes any files. Never normalize user text. */
export function updateGuidance(existing, body) {
  const lines = [...existing.matchAll(/[^\n]*(?:\n|$)/g)]
    .filter((match) => match[0])
    .map((match) => ({
      text: match[0].replace(/\r?\n$/, ""),
      start: match.index,
      end: match.index + match[0].replace(/\r?\n$/, "").length,
    }));
  const markers = lines.filter(({ text }) => /doc-review/i.test(text) &&
    (/\b(?:BEGIN|END)\b/i.test(text) && /<!--|-->|^\s*(?:BEGIN|END)\b/i.test(text)));

  if (markers.length) {
    if (markers.length !== 2 || markers[0].text !== GUIDANCE_BEGIN || markers[1].text !== GUIDANCE_END) {
      invalidMarkers();
    }
    const [begin, end] = markers;
    const newline = existing.slice(begin.end).startsWith("\r\n") ? "\r\n" : "\n";
    return {
      contents: existing.slice(0, begin.start) + render(body, newline) + existing.slice(end.end),
      message: "Updated setup-owned AGENTS.md guidance   (Codex)",
    };
  }

  const candidates = [];
  for (const legacy of LEGACY_GUIDANCE) {
    for (const command of ["npx -y @erdemtuna/doc-review", "doc-review"]) {
      for (const newline of ["\n", "\r\n"]) {
        const text = legacy.replaceAll("npx -y @erdemtuna/doc-review", command).replaceAll("\n", newline);
        let start = existing.indexOf(text);
        while (start !== -1) {
          const end = start + text.length;
          const before = existing.slice(0, start);
          const after = existing.slice(end);
          // A complete generated section, not a substring of customized prose.
          if ((start === 0 || before.endsWith("\n") || before === "\uFEFF") &&
              /^(?:\r?\n|$)/.test(after) &&
              /^(?:\s*$|(?:\r?\n)+(?=#{1,2} ))/.test(after)) {
            candidates.push({ start, end, newline });
          }
          start = existing.indexOf(text, start + text.length);
        }
      }
    }
  }
  if (candidates.length > 1) {
    throw new Error("AGENTS.md contains multiple legacy doc-review sections; ownership is ambiguous. " +
      "Reconcile them before re-running setup. No setup files were changed.");
  }
  if (candidates.length === 1) {
    const { start, end, newline } = candidates[0];
    const surrounding = existing.slice(0, start) + existing.slice(end);
    if (!/doc-review/i.test(surrounding)) {
      return {
        contents: existing.slice(0, start) + render(body, newline) + existing.slice(end),
        message: "Migrated legacy AGENTS.md guidance to setup-owned markers   (Codex)",
      };
    }
  }
  if (/doc-review/i.test(existing)) {
    return { contents: existing, message: migrationMessage };
  }

  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const separator = !existing || existing.endsWith(newline + newline)
    ? ""
    : existing.endsWith("\n") ? newline : newline + newline;
  return {
    contents: existing + separator + render(body, newline) + newline,
    message: `${existing ? "Updated" : "Created"} AGENTS.md   (Codex)`,
  };
}
