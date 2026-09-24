---
name: doc-review
description: Open an HTML file, Markdown file, or localhost page for View-first interactive browser feedback. Use only when the user explicitly invokes /doc-review or requests an interactive browser review. Do not invoke merely because you write, update, discuss, or review a document or web page.
---

# doc-review

## Activation

Start only when the user explicitly invokes /doc-review or requests an
interactive browser review. Writing, updating, discussing, or generically reviewing
content does not authorize opening a review or polling. Another skill's automatic
review step is not user permission. Otherwise respond normally without opening a review or polling.

After the explicit review request, open the requested HTML, Markdown, or real
localhost route, not a recreation of the app:

```sh
npx -y @erdemtuna/doc-review path/to/file.html
```

Open prints JSON: `review`, `receipt`, `url`, and `handoff`. Save both `reviewId`
and canonical `entryKey`. One open review per entry is joined; opening after End
creates a new review. Never switch an existing handler to that new identity.
For a repeatable open, supply `--request-id <stable-id>`. `--no-browser` returns
the same durable link without launching a browser.

## The review-scoped loop

Copy the actual `handoff.pollCommand`, not these placeholder IDs:

```sh
npx -y @erdemtuna/doc-review poll --review <reviewId> --entry <entryKey> --timeout 600
```

Without `--timeout`, the CLI defaults to a 12-hour cutoff (12 hours).
An explicit `--timeout` is one end-to-end deadline, including server discovery and reconnect
attempts. Use the bounded foreground `--timeout 600` loop. Do not end the turn
while it waits; if the shell returns a process/session handle, wait on that handle.

`state: "work"` contains the immutable delivered `submission`, exact review,
canonical `pages` (actual file paths or localhost URLs), and identity-bound handoff
commands. Delivery is receipt evidence, not proof of a live agent. Handle only
that submission. `state: "timeout"` means the deadline expired, not that no work
exists: repeat the same poll if the review is still wanted. `state: "ended"`
means that exact ended review has no outstanding accepted work: stop polling.

End freezes reviewer content across tabs, but accepted non-abandoned work still
arrives and can be completed after End/restart. Saved-unsent content stays in the
ended review; it does not transfer to a fresh review. Abandonment stops delivery
and releases exclusion, but does not cancel external work or undo file writes.
On `SUBMISSION_ABANDONED`, stop handling; never retry as a new completion.

Read prior exchanges using the actual `handoff.contextCommands`:

```sh
npx -y @erdemtuna/doc-review context --review <reviewId> --entry <entryKey> --thread <threadId> --limit 50
```

Context returns `{items, nextCursor, totalCount, highWater}`. Each item has
`reviewer` and nullable `response`. The latest window reads chronologically.
Pass the opaque `nextCursor` with `--cursor` to load earlier exchanges under the
same review/thread/filter scope. Default 50, maximum 100; do not assume one
window contains all history. Earlier unresolved context is not new permission.

## Permission and exact human edits

Every reviewer message has independent intent. **Discuss** (`discuss`) means
answer without editing source for that message. **Request change**
(`request-change`) permits, but does not require, that specific change.
Clarify or defer when unsafe, ambiguous, unnecessary, or incomplete. An overall
note stays submission-level and has its own intent: it never grants blanket
permission for inline messages or every page. Respond inline to every message.

Human direct edits are exact requested content, separate from message intent.
For non-truncated edits, `after` is their exact wording. Preserve text, HTML
formatting translated to the source's syntax, move boundaries, deletions, and
staged assets. Use `pages` and authoritative project source to identify the
target. Missing or ambiguous anchors require safe source identification or a
clarifying/deferred response, never a guessed replacement.

An edit's `source.state: "saved"` is server-owned evidence for that exact edit
version: do not apply it again. Report `already-saved` only with that evidence.
Source-pending Markdown, scripted HTML, and localhost edits must go into actual
Markdown/MDX/TSX/template/component source, never rendered HTTP or script-generated
markup. Copy authoritative staged assets to the correct source asset location
and replace temporary preview references without losing their insertion point.
Plain HTML alone permits direct save; disabling scripts is not write permission.

Edit fields are limited to 200,000 Unicode code points each.
`truncated: true` identifies clipped fields in the `truncated_fields` array.
Never apply incomplete text or HTML as a complete replacement or invent missing
text. Recover it only from an authoritative source; otherwise ask the
user for the complete edit through an inline clarification or deferred outcome.

## Complete response, then wait

Write a JSON response file using the delivered IDs/versions and a new stable
caller `requestId`. Reuse the identical file and request ID on transport retries.
Example with one Discuss message (replace all example identities):

```json
{
  "operation": "respond",
  "reviewId": "review-id",
  "entryKey": "canonical-entry-key",
  "submissionId": "submission-id",
  "requestId": "stable-response-request-id",
  "expectedVersion": 2,
  "responses": [{
    "threadId": "thread-id",
    "messageId": "message-id",
    "messageVersion": 1,
    "body": "The wording preserves the original meaning.",
    "outcome": "answered"
  }],
  "editOutcomes": [],
  "resultNote": "Answered the question without changing source."
}
```

`responses` must cover every submitted message exactly once, with its exact
version. Outcomes: `answered`, `applied` (only request-change), `clarification-needed`,
or `deferred`. `editOutcomes` covers every direct edit exactly once with
`{editId, editVersion, outcome, reason}`; outcomes are `already-saved`, `applied`,
or `deferred`. Include `overallOutcome` only when an overall note was submitted,
respecting its intent. Never invent success to satisfy coverage.

One independent `resultNote` explains what happened, including remaining questions
or deferred work. Its acceptance does not wait for comparison capture. A
reply-only response does not fabricate a new version or reload. A saved human
edit may appear under "What changed" even without new agent edits/capture.

```sh
npx -y @erdemtuna/doc-review respond --review <reviewId> --entry <entryKey> --response-file response.json --timeout 600
```

Success is `{ok:true, receipt}` after the entire response is persisted atomically.
Then run the original review's poll command. No acknowledgement-only command
can clear conversation work; old target-only polling/completion is rejected.

Errors are JSON and nonzero. Exit 1 includes `{ok:false,error:{code,message,status,retryable}}`.
Exit 2 includes `{state:"unknown",requestId,reason}`: the response may already be
durable. The CLI retries transport using the same logical body within its
deadline. After uncertainty, repeat that same response file, **never repeat
source edits because a connection was lost**. A receipt lookup can provide
evidence, but `not-found` is not rejection and cannot justify repeating edits:

```sh
npx -y @erdemtuna/doc-review receipt --review <reviewId> --entry <entryKey> --request-id <requestId>
npx -y @erdemtuna/doc-review status --review <reviewId> --entry <entryKey>
```

Status reports `source: "server"|"disk"`, validated review status, pending counts,
queued/delivered work, overlapping/predecessor blockers, and the latest submission
including handled/abandoned evidence. Disk status does not start a server or
mutate the store; unreadable/corrupt/unsupported state is an explicit error.
It is persisted evidence, not live agent availability.

Use one cooperating agent handler. Receipt replay prevents conflicting durable
responses, not duplicate external source writes; there are no worker leases or
filesystem exactly-once guarantees. Stop if the user cancels or changes tasks.
Keep source and response recovery separate: inspect current bytes and durable
evidence before deciding any source operation needs to be repeated.
