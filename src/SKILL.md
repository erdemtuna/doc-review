---
name: doc-review
description: Open an HTML file, Markdown file, or localhost page for View-first interactive browser feedback. Use only when the user explicitly invokes /doc-review or requests an interactive browser review. Do not invoke merely because you write, update, discuss, or review a document or web page.
---

# doc-review

## Activation

Start only when the user explicitly invokes `/doc-review` or asks to open an
interactive browser review. A generic request to review, proofread, analyze, write,
or update content is not permission to open this workflow. Another skill's
automatic review step is not user permission.

Without that request, respond normally without opening a review or polling for
feedback. Once the user starts a review, continue its feedback loop until they
end it; stop if they cancel or switch to a different task.

## Review behavior

The user reviews your HTML, Markdown, or localhost page in a real browser. It starts in View.
Native page controls work; supported self-contained HTML scripts run automatically.
They can switch to Edit, comment explicitly in either mode,
and send the whole batch at once.

Plain HTML retains direct autosave. Scripted HTML edits are feedback-only:
apply them to the original source, never serialize the script-modified runtime
page over the file. Source changes do not require renewed approval.
Reload without scripts is a temporary recovery option, not permission to write
a scripted preview over its source. Reloads can wait for unresolved editing work.
Applications requiring external script dependencies should use localhost review;
automatic inline execution does not add support for application imports or workers.

Markdown files open rendered. Their quotes and edits reference the rendered text,
and the file itself is never touched — apply every change to the Markdown source,
keeping its formatting syntax.

Comments open from a contextual icon after a text selection or an element hover/focus.
The keyboard shortcut is Ctrl+Alt+M, or Cmd+Option+M on macOS. Enter submits the
comment and Shift+Enter adds a new line. On desktop the composer stays attached
to its target or pins to the effective top or bottom clipping edge; Back to
selection reveals an offscreen target without changing the draft.

Feedback is the single toolbar entry point for Comments, Edits, and the overall
note. Comments and Edits collapse independently; their choices last until the
tab reloads. An active comment edit keeps Comments expanded until Save or Cancel.
The inventory scrolls independently while the overall note and bottom actions
remain reachable. End review is on the left and Send to agent on the right.
Submitting creates the normal target mark and count but leaves the card closed
until the user explicitly activates the mark or chooses Jump to. Focus returns
to the reviewed element or selection. Aligned cards expose Edit, Close, and
More; drawer cards expose Jump to, Edit, and More. Delete is available only
through More and an inline confirmation. Long quote hints preserve both ends.

Existing-comment editing uses explicit Save and Cancel controls and never saves
on blur. Enter saves, Shift+Enter inserts a line, and Escape cancels. The draft,
focus, and caret follow the comment between aligned and drawer cards and survive
target movement. Closing an aligned card only hides its active presentation.
Acknowledging the exact delivered batch removes only the comments that batch
carried; newer comments and corrections survive.

## The loop

1. After the explicit review request, use the requested file or localhost route.
   Create or update content, or start a local page, only as needed for that request.
2. Open it for the user:

   ```sh
   npx -y @erdemtuna/doc-review path/to/file.html
   ```

   For a page served by a local development server, open the real route instead
   of recreating it as a separate HTML file:

   ```sh
   npx -y @erdemtuna/doc-review http://localhost:3000/wiki
   ```

3. Wait for feedback. This blocks until they hit Send, or the timeout passes:

   ```sh
   npx -y @erdemtuna/doc-review poll path/to/file.html --timeout 600
   ```

   Without `--timeout`, the CLI stops after 12 hours. An explicit timeout covers
   the entire operation, including server discovery, reconnects, and backoff.
   Recoverable connection drops retry within that deadline; terminal errors
   require action rather than another automatic poll. The 600-second command
   above deliberately uses a shorter deadline.

   Keep this command in the foreground. Do not end your turn while it is waiting.
   If your shell returns a process or session handle, keep waiting on that handle
   until the command exits. If it prints `{"status":"timeout"}`, no feedback has
   arrived yet — run the same poll command again to keep waiting. Feedback is
   saved even if a poll dies, so nothing is ever lost.

   If it prints `{"status":"closed"}`, the user ended the review from the
   browser — stop polling and do not run the poll command again. Unsent
   feedback is kept and ships the next time this target is reviewed.

4. Apply what comes back, then wait again. Copy `batch_id` from the response;
   only that exact receipt can clear the batch you handled:

   ```sh
   npx -y @erdemtuna/doc-review poll path/to/file.html --ack b_0123456789abcdef --timeout 600
   ```

   The response's `next_step` contains the complete acknowledgement command.
   Never acknowledge a different or guessed ID.

   Acknowledgement means that you handled the feedback; it is separate from
   browser result-capture readiness. Do not wait for history capture before
   acknowledging completed work, and do not acknowledge merely because a page
   looks stable. The browser captures round results automatically when possible.
   Missing comparison data does not prevent the user from sending feedback.
   Captured differences are observations, not proof that you alone authored them.
   Content results may wait for the same identifiable tab as the baseline.
   The user sees a return-to-tab prompt; do not automate tab clicking to force
   capture. Source comparison remains independent. Unknown view identity is
   labelled unverified, not asserted as a whole-application comparison.

Repeat 3–4 until the user says they are done.

Not sure whether feedback is already waiting — say, at the start of a new turn?
This answers instantly without blocking:

```sh
npx -y @erdemtuna/doc-review status path/to/file.html
```

It prints `{"status": "feedback-waiting"}` when a batch is ready for a poll,
plus counts of unsent comments and edits still in the browser.

## What you get

One batch covers every page the user visited, grouped by file or localhost URL.

```json
{
  "batch_id": "b_0123456789abcdef",
  "status": "feedback",
  "pages": [
    {
      "file": "/abs/path/to/page.html",
      "comments": [
        { "id": "c_1", "kind": "selection", "quote": "the exact text they selected",
          "anchor": { "prefix": "...", "quote": "...", "suffix": "..." },
          "feedback": "what they want changed" }
      ],
      "edits": [
        { "label": "Problem body", "kind": "edited",
          "before": "the original wording",
          "after": "their exact new wording",
          "after_html": "their exact new wording with <strong>formatting</strong>" }
      ]
    }
  ],
  "overall_note": "feedback not tied to any one page",
  "next_step": "Apply this feedback, then run: npx -y @erdemtuna/doc-review poll ... --ack b_0123456789abcdef --timeout 600"
}
```

## Rules

- Edits marked **`truncated`** contain incomplete fields listed in
  `truncated_fields`. Each text/HTML field is limited to 200,000 Unicode code
  points. Never apply a truncated field as a complete replacement or guess the
  missing content. Obtain the complete edit from an authoritative source, or ask
  the user for it. Do not acknowledge the batch until all feedback is handled.
- **`edits` are changes the user already made.** `after` is their exact wording —
  unless marked truncated, carry it across verbatim and never revert it. If the HTML was generated from
  something else (MDX, Markdown, a template), apply `after` to the **source** too,
  or their fix disappears on the next build.
- When `before_html`/`after_html` are present, the user changed formatting, not
  just words — bold, italic, underline, links. Use the HTML version to carry the
  formatting into the source, translated to its syntax (e.g. `<strong>` → `**`
  in Markdown/MDX).
- A page with `kind: "url"` was edited directly in the review UI. Its `file`
  and `url` fields name the localhost route, not a writable file. Find the
  matching project source (such as MDX, TSX, or a template), apply every edit
  and deletion there, then acknowledge so the route reloads. Never write the
  rendered HTTP response back into the app.
- When an edit's `after_html` contains `<img src="assets/...">`, the user pasted
  an image: the file already exists in an `assets/` folder next to the reviewed
  file. Keep that relative path — in Markdown, reference it as
  `![](assets/...)`. Never regenerate or inline the image.
- On a localhost page, a pasted image arrives under `staged_assets`. Copy its
  local `path` into the app's appropriate asset folder, replace the temporary
  preview URL in `after_html`, and preserve the image at the user's insertion
  point. Never leave the temporary preview URL in source.
- An edit with `kind: "moved"` means the user relocated that whole block.
  Reposition it in the source without rewriting its content: it now sits right
  after the block whose text starts with `moved_after`, and right before the
  block whose text starts with `moved_before`. An empty `moved_after` means it
  is now the first block in its container.
- Find each comment by its `quote`; that exact string is in the file.
- `kind: "element"` points at a whole block, so `quote` is its label, not body text.
- Fix every page in `pages`, not just the first.
- **Do not write a reply.** There is no chat. The user sees the updated page and
  can choose Changes for a fixed Send-to-result comparison. Reload may wait
  for the user to handle unsaved review work. Live result capture may require
  a contextual retry; never describe unavailable history as no changes.
- Review history uses local content/source snapshots, not screenshots or Git
  commits. Do not create commits or alter repository state to populate history.

## Better edit labels (optional)

Name the sections you author and the user's edit list uses your names instead of
guessing from the DOM:

```html
<p data-block="Problem body">…</p>
<div data-container="Metrics callout">…</div>
```

`data-block` names a region for the edit list. `data-container` also gives the block a
stable label for its hover/focus comment affordance.
