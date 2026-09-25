# Doc Review

**Review your coding agent's work in the browser, not in a wall of chat.**

Open an HTML file, a Markdown document, or a localhost page. Point to what needs
changing, edit the small things yourself, and send your feedback to the agent
in a durable review conversation.

![The Field Notes landing page in Review, with highlighted copy and an anchored comment asking for a concrete benefit](https://raw.githubusercontent.com/erdemtuna/doc-review/main/assets/doc-review.png)

*Feedback stays beside the work. Your agent gets the comments, edits, and overall note together.*

## Get started

Requires **Node.js 24.21.0 or newer** and a coding agent that can run shell commands.
Install the skill once:

```sh
npx -y @erdemtuna/doc-review setup --global
```

Start a fresh agent session, then ask it to open a review:

```text
/doc-review path/to/landing-page.html
```

The same command works with Markdown or a running local app:

```text
/doc-review path/to/plan.md
/doc-review http://localhost:3000
```

Reviews start only when you request them. Your agent uses the installed skill
to open the page, wait for feedback, and respond in the review conversation.
Discussion does not authorize source edits. Each checked change request gives
permission for that request only; the agent can answer, clarify, apply, or defer.

## From feedback to the next version

1. **Open and explore.** Reviews start in **View**, so you can read and use page
   controls without accidentally editing.
2. **Point out what matters.** Select text or choose an element to leave a
   comment. Switch to **Edit** for direct changes to wording, formatting, images,
   or layout. Commenting works in either mode. New comments open beside the target
   when space permits, with a safe Feedback fallback. **Save** retains the
   comment in the review without sending it. Enter saves; Shift+Enter adds a line.
   The editor's X or Escape closes an empty/unchanged draft immediately and asks
   **Keep editing / Discard** for unsaved changes. Feedback's outer X only hides
   the panel and preserves your drafts.
3. **Send feedback.** Open **Feedback**, select saved pending messages and edits,
   expand **Overall note (optional)** if needed, and choose **Send**. Each new message defaults
   to Discussion; check **Request a change** only for that message's permission.
4. **Check the response and result.** Each submitted message gets an inline reply,
   each direct edit gets an exact outcome, and the submission gets one result note.
   Find the latest result above the conversations and choose **View result**. Use
   **History** in the Feedback header for earlier submissions and the agent command. Choose
   **Content** or **Source** to compare the submission's captured
   before and after content, then continue reviewing. Comparisons show observed
   changes, not a guarantee that every request was resolved.

You can review a plan, refine a landing page, or walk through a local app without
moving your feedback into a separate document.

![The Feedback overlay with expanded conversations, saved pending edits, an independent overall note, and End review beside Send](https://raw.githubusercontent.com/erdemtuna/doc-review/main/assets/doc-review-feedback.png)

*Feedback uses per-message intent,
saved pending replies, and complete submission results.*

![The completed Field Notes submission in Changes, comparing the revised description and call to action with their originals](https://raw.githubusercontent.com/erdemtuna/doc-review/main/assets/doc-review-changes.png)

*The full result note stays above Content and Source comparison controls.
Detailed submission history remains available from Feedback.*

## What happens to your edits?

| What you open | Where edits go |
| --- | --- |
| Plain HTML | Saved directly to the file, with Revert available |
| Scripted HTML or Markdown | Sent to the agent to apply to the original source |
| Localhost page | Sent to the agent to update the app's source |

Self contained HTML can run inline scripts. For an app with separate script
dependencies, use its localhost URL instead.

Doc Review runs locally and needs no Doc Review account, hosted backend, or API
key. The page you review and the coding agent you use may still contact external
services.

## Agent CLI

Opening prints JSON containing the durable `reviewId`, canonical `entryKey`,
browser link, and identity-bound `handoff` commands. Keep that identity through
End and restart; do not substitute a newer review of the same file.

```sh
doc-review poll --review <reviewId> --entry <entryKey> --timeout 600
doc-review context --review <reviewId> --entry <entryKey> --thread <threadId>
doc-review respond --review <reviewId> --entry <entryKey> --response-file response.json
doc-review status --review <reviewId> --entry <entryKey>
```

The response file carries the exact submission/version, a stable caller request
ID, all inline replies and edit outcomes, and one result note. Success includes a
durable receipt. If the response connection is lost, retry the identical file,
not source edits. Target-only polling and acknowledgement-only completion are
retired. See the [response format and recovery rules](src/SKILL.md).

End freezes the shared review but lets accepted work finish. Unsent items stay
read-only in that ended review, never transfer to a new one. Referenced
conversations, results, receipts, revisions, and staged assets are retained.
Feedback, Focus and the highlight-adjacent host share one mounted editor,
in-memory drafts, caret, selection and loaded history. Explicit highlight
activation opens one conversation; ambiguous/unavailable targets and constrained
viewports fall back safely to Feedback without changing the original anchor.
Each sidebar discussion has its own bordered card and a visible **Jump to**
action. A successful jump hides Feedback to reveal the passage; reopening it
retains drafts and reading position. Comments and Your edits collapse independently.
Collapse or Close never resolves a thread. Resolve/Reopen is explicit; Resolve
requires no pending or outstanding messages. Drafts are not stored or synced to
other tabs. An ended review remains a read-only observer of late results.

## Learn more

[Usage guide](https://github.com/erdemtuna/doc-review/blob/main/docs/usage.md):
setup options, comments, comparisons, limitations, and upgrades.

[Development](https://github.com/erdemtuna/doc-review/blob/main/docs/development.md):
build, test, architecture, and package checks.

[Prepared review example](docs/migration-review.md):
an isolated durable shell preview and a reproducible installed-package lifecycle.

[Releasing](https://github.com/erdemtuna/doc-review/blob/main/RELEASING.md):
the maintainers' release process.

## Credits and license

Doc Review is an independent fork of Peter Yang's
[Human Review](https://github.com/petergyang/human-review), continuing from
upstream v0.6.1. Licensed under
[MIT](https://github.com/erdemtuna/doc-review/blob/main/LICENSE).
