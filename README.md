# Doc Review

Review HTML, Markdown, and localhost pages, edit when you choose, leave contextual comments, and send all feedback to your AI agent at once.

[Read the original Human Review launch post](https://creatoreconomy.so/p/use-my-human-review-skill-to-edit-html-markdown-visually)

https://github.com/user-attachments/assets/7cab09c9-eaa0-4e8b-984d-2925e810b5c2

## Problem

Giving AI feedback on files in chat is painful.

Sometimes you want to change one sentence yourself. Instead, you end up typing:

> In the third paragraph, change X to Y. Cut the third card because it repeats the first one. Also rewrite the CTA.

Then the agent changes the file and you have to check whether it understood every instruction. This gets even harder when you’re reviewing a long plan, Markdown document, landing page, or multi-page website.

## How to install /doc-review

The easiest way to install the skill is to paste this into ChatGPT, Claude Code, Codex, or your favorite coding agent:

```text
Install the /doc-review skill globally from https://github.com/erdemtuna/doc-review
```

You can also install it with `npx`:

```sh
npx -y @erdemtuna/doc-review setup --global
```

This fork uses the `doc-review` command, `/doc-review` skill, and
`~/.doc-review` state directory. It does not install a `human-review` alias or
migrate upstream state and skill files; remove those old files manually if you
no longer need them.

## How to use /doc-review

Review is opt-in: explicitly invoke `/doc-review` or ask to open an interactive
browser review. Writing, updating, or asking for a general review of content does
not automatically open the browser or start polling. An explicitly started review
continues until you end it or switch tasks.

After updating installed skill instructions, start a fresh agent session or reload
skills (in Copilot CLI, `/skills reload`). Setup copies the executing package's
skill template; rerunning setup from an older package can restore older behavior.
Setup updates its own `AGENTS.md` guidance inside `<!-- BEGIN doc-review -->` and
`<!-- END doc-review -->` markers. Exact, known older generated blocks are migrated.
Custom guidance is preserved with a migration message rather than overwritten;
update it yourself if it requests automatic review. Invalid or duplicate markers
must be corrected before setup can proceed.

![Doc Review visual editor](assets/doc-review.png)

Open an HTML or Markdown file:

```text
/doc-review (your file)
```

Review a page running on localhost:

```text
/doc-review (localhost URL)
```

Doc Review opens in **View** (`Editing off, comments enabled`) so links, buttons, summaries, tabs, and application controls work normally. The centered mode selector switches to **Edit** (`Direct editing on`) when you want to change content directly. Commenting stays available in both modes.

Select text, or hover or focus an element, then use the nearby comment icon. `Ctrl+Alt+M` (`Cmd+Option+M` on macOS) opens a comment for the current selection. Press Enter to submit or Shift+Enter for a new line. On desktop the composer stays beside its target, or pins to the effective top or bottom scrolling edge when that target leaves view. **Back to selection** reveals the target without changing the draft. The full-width sheet is used only at the narrow responsive breakpoint.

**Comments** is the single toolbar entry point for the closed-by-default review drawer. Its feedback inventory scrolls independently while the overall note and **Send to agent** controls remain fixed. Submitting a comment creates its normal highlight and increments the count, but keeps the card closed until you activate its mark or choose **Jump to**. Focus returns to the exact element or selection you reviewed.

Aligned cards show **Edit**, **Close**, and **More**; drawer cards show **Jump to**, **Edit**, and **More**. Delete lives only in **More** and requires an inline confirmation. Quote hints preserve both the beginning and ending of long selections. Editing has explicit **Save** and **Cancel** controls: Enter saves, Shift+Enter adds a line, Escape cancels, and moving focus never autosaves. A draft follows its comment between aligned and drawer cards and keeps its caret through target movement.

For writable HTML files, Edit saves direct changes automatically. Markdown and localhost remain editable feedback-only surfaces: their rendered HTML is never written over the source, so click Send and let the agent apply those edits.

File and rendered Markdown reviews run with authored scripts and inline handlers
blocked by default, an opaque iframe origin, and no popup or download permission. Their
per-render message capability is rotated for every load and navigation. It is
kept out of document URLs, HTML attributes, authored DOM, and global JavaScript
state; the single-use artifact URL loads a same-origin bootstrap module under a
nonce-based CSP. Relative assets, including a same-artifact `<base>`, resolve
beside the reviewed file, while review navigation always stays relative to the
source file. External bases are ignored.

Localhost reviews keep `allow-same-origin`, popup, and download compatibility so
application behavior still works. Because localhost application scripts are
trusted in that mode, the render capability provides correlation and stale
message rejection rather than an authorization boundary. The authenticated
parent still validates links and never exposes the raw-file save route to a
localhost review.

For self-contained HTML documents with scripted tabs or other controls, an
**Enable page scripts** switch beside View/Edit enables interaction for the
**exact saved version**, without an approval popup. The switch's tooltip and
**Script details (?)** explain execution and feedback-only editing.
View/Edit stays centered independently of the switch. There is no explanatory
second row: details and status messages stay in the inline info control, which
shows **!** when attention is needed. Errors also produce a notification.
Nothing is inserted into the HTML being reviewed.
Applying a setting still reloads the document to enforce its script policy,
but the prior page remains visible and non-interactive until the replacement
confirms its review settings. A loading failure provides an explicit reload action.
Trust is remembered locally for that file and its original byte hash. Changing
the file requires approval again; it does not inherit trust from its path.
Turn the switch off to revoke trust and return to script-blocked review.
Changed versions show **File changed - enable again** in Script details. If an open draft holds
the reload, the switch shows the saved permission while those details explain
that the displayed page has not changed yet. In particular, revocation does not
stop scripts already running in the old frame until it reloads. The existing
reload action keeps comment drafts. Markdown remains script-blocked.
Trusted HTML keeps an opaque frame origin, but its own scripts run: only trust
documents you are willing to execute. Their frame messages are correlation
signals, not a security boundary against the trusted document.

Trusted interactive HTML edits are **feedback-only**, like Markdown and localhost:
the review does not save script-generated DOM over your source. Apply those
edits to the original file through the agent. Ordinary safe HTML retains
autosave. External script dependencies, dynamic imports, and workers are not
authorized by trusting a self-contained file; use the localhost review path for
applications requiring those capabilities.

Agent polling returns an immutable `batch_id`. After applying the batch, the
agent acknowledges that exact receipt and keeps waiting:

```sh
npx -y @erdemtuna/doc-review poll path/to/file.html --ack b_0123456789abcdef --timeout 600
```

A stale or repeated batch ID is harmless: it never clears newer feedback. The
complete acknowledgement command is included in each response's `next_step`.

### Latest version and See changes

**Latest version** keeps the document interactive. **See changes** is a separate,
read-only presentation of a selected review round; it does not replace View/Edit.
The default comparison is the content captured when feedback was sent against
the result captured after the agent acknowledged that exact batch. Previous
rounds retain their own fixed endpoints rather than changing on every reload.

Content comparisons use a continuous aligned before/after reading surface with
expandable unchanged context. Source comparisons use line-numbered source hunks.
At narrow widths, a unified view retains each change's before/after attribution.
Content comparisons cover text, structure, formatting, links, and image
references. File-backed reviews also retain source for a source comparison.
Deleted passages remain readable even when there is no current element to jump
to, and uncertain matches do not pretend to identify an exact current target.
These are changes observed during a round, not proof of agent authorship or that
every comment was resolved.

History works in the normal browser for HTML, Markdown, and localhost pages.
It does not use screenshots, a browser extension, or automatic Git commits.
Live history captures the reviewed page's available content, not every possible
application state. Changes to image bytes at an unchanged URL, canvas pixels,
external stylesheet appearance, and inaccessible embedded content are outside
the comparison guarantee.

Send waits for edit persistence and writable HTML saves before capturing its
baseline. If a target cannot be captured, open and recapture it or explicitly
send its feedback without a comparison. A last-visited live page is never
silently described as a fresh Send-time snapshot.

When an active tab has reliable authored tab/panel identifiers, Content capture
records that visible view. A result on a different tab remains pending and asks
you to return to the original tab. Returning retries capture without clicking
through other tabs automatically. Unknown views and older snapshots are labelled
as visible-content comparisons whose matching view is unverified. This does not
capture all hidden panels or every application state. File Source comparison
still covers the whole file independently.

After acknowledgement, file-source results are captured independently of the
browser. Content results are captured when the appropriate reviewed page is
ready. These observations can have different timestamps; neither timestamp
claims that the document was captured at the instant of acknowledgement.
**Capture result** is the fallback for unavailable, closed, or continuously
changing pages. **Finish with available snapshots** explicitly ends a pending
content capture without inventing missing content or removing an available source
comparison. Failed captures are not reported as zero changes, and handled
feedback remains archived even when its comparison is unavailable.

Snapshots stay in the local Doc Review state directory. The latest five
completed rounds are retained automatically, while active rounds, pending
captures, and unsent feedback protect their referenced revisions. History starts
with this capability; earlier documents cannot be reconstructed from old
feedback receipts. Review snapshots can contain document content, so treat the
state directory as private.
Unreferenced snapshot files are collected at startup and during periodic
maintenance, with a one-hour grace period protecting interrupted publications.
Capture and comparison limits fail explicitly rather than publishing truncated
content as a complete comparison.

Default capture limits are 8 MiB of file source and 4 MiB of normalized content,
with at most 2,000 semantic blocks and 1,000,000 text characters. A single block
is limited to 100,000 characters. Comparisons have independent size, token, and
edit-work limits, including a 1,000,000-character budget and a 250 ms processing
budget. A stored snapshot can therefore exceed comparison limits; the UI reports
that limitation rather than claiming there were no changes.

### Feedback reliability and limits

`poll` without `--timeout` waits for at most 12 hours. Explicit timeouts include
server discovery, reconnection, and retry backoff, not just time spent connected.
Recoverable connection drops are retried; invalid responses, authorization errors,
and incompatible servers fail visibly. A timeout does not discard feedback: use
`status` to check it, then start another poll if the review is still wanted.

Each edit text or HTML field is limited to 200,000 Unicode code points. Oversized
edits carry `truncated: true` and `truncated_fields` naming incomplete fields.
The agent must not use partial text or HTML as a complete replacement or invent
the rest. It must obtain the full edit from an authoritative source or ask you
for it before acknowledging the batch.

External writes to an HTML or Markdown source refresh its rendered baseline without
clearing unsent feedback. That preserves your edits; it does not automatically
resolve conflicts with the changed source. HTML autosaves keep their existing
behavior.

### Upgrading from servers using protocol 14 or earlier

The updated CLI requires server protocol 15. An older server that is still
running is not silently reused or forcibly replaced. End active reviews and
shut down that specific old server (or let it exit when idle) before restarting
Doc Review. Keep the `.doc-review` state directory: pending batches and their
exact receipt IDs survive a controlled restart.

After installing the updated package, rerun `doc-review setup --global` for
personal skills and `doc-review setup` in projects with generated guidance.
Reload skills or start a fresh agent session afterward. A newer CLI paired with
older instructions is not a complete upgrade.

## What this skill lets you do

- **Edit text directly and tweak basic formatting** (e.g., bold, italic).
- **Make bulleted and numbered lists** — type `- ` or `1. ` at the start of a line, or press ⌘⇧8 / ⌘⇧7. Tab and Shift+Tab indent and outdent.
- **Add links** — select text and press ⌘K. ⌘K inside an existing link edits or removes it.
- **Resize images** by dragging their corner, and **move images** by dragging them to a new spot.
- **Rearrange the page** — hover any block and drag the handle on its left edge to move the whole block somewhere else.
- **Paste images** from your clipboard — file reviews save them beside the document; localhost reviews stage them for the agent to place in the app source.
- **Select a phrase and leave a comment** from the contextual icon, or press Ctrl+Alt+M / Cmd+Option+M.
- **Comment on an image, chart, control, or section** from its hover or keyboard-focus affordance without taking over its normal click.
- **Remove elements** without explaining the deletion in chat.
- **Command-click links** to review multiple pages without losing your feedback.
- **Send every edit and comment at once** instead of writing a long chat message.

Doc Review works well for editing AI-generated plans, updating landing pages, reviewing localhost apps, and removing extra copy from a UX.

## What’s inside

- [`cli.js`](src/cli.js) contains the `doc-review`, `poll`, `status`, and `setup` commands.
- [`server.js`](src/server.js) runs the local review session.
- [`sdk.js`](src/sdk.js) handles editing, comments, highlights, and feedback.
- [`chrome-client.js`](src/chrome-client.js) contains the visual review interface.
- [`markdown.js`](src/markdown.js) renders Markdown files for review.
- [`SKILL.md`](src/SKILL.md) teaches Claude Code, Codex, and other agents how to use Doc Review.

Everything runs on your computer. Doc Review doesn’t require an account, cloud service, database, or API key.
Comment geometry remains local, transient presentation data and is never written to review state or sent to the agent. After the agent acknowledges the exact delivered `batch_id`, the comments carried by that batch leave the active feedback inventory; their round archive remains, and newer comments and corrections stay active.

## Upstream project

Doc Review is an independent fork of [Human Review](https://github.com/petergyang/human-review), originally created by Peter Yang. The fork preserves the upstream MIT license and continues from the upstream `v0.6.1` release.

## License

MIT
