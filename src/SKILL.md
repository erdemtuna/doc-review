---
name: doc-review
description: Open an HTML file, Markdown file, or localhost page for View-first interactive browser feedback. Use only when the user explicitly invokes /doc-review or requests an interactive browser review. Do not invoke merely because you write, update, discuss, or review a document or web page.
---

# doc-review

Start only when the user explicitly invokes /doc-review or requests an interactive
browser review. Another skill's automatic review step is not user permission.
Otherwise respond normally without opening a review or polling.

After the explicit review request, open the requested file or real localhost route:

```sh
npx -y @erdemtuna/doc-review path/to/file.html
```

Retain `review.reviewId`, `review.entryKey`, receipt and URL. Copy the actual
generated commands, not placeholder IDs. Opening after End creates a different
review; never switch an existing handler to it.

## Read, handle, respond, wait

```sh
npx -y @erdemtuna/doc-review poll --review <reviewId> --entry <entryKey> --timeout 600
```

Keep this foreground wait active. If the shell returns a handle, wait on that
handle. The default timeout is 12 hours; explicit timeout includes discovery and
reconnect. On `timeout`, repeat the same poll. On `ended`, stop. On `work`, retain
the submission identity/version and handle only that work.

`submission.inventory` contains pages, messages, edits and any result outcomes.
Follow `nextCursor` with the submission command until `complete`; counts cover
the full obligation, not just this window. `inline` is complete; `reference`
means retrieve exact content when needed. Read complete necessary evidence and
authoritative source before editing. Exporting a file alone is not reading it.
Delivery references/previews are NOT original capture truncation.

Load only the relevant reference:

- Before responding, read [response-contract](references/response-contract.md).
  Use `handoff.templateCommand` to create the complete inventory in a new file.
  Its blank outcomes/prose intentionally fail validation. Fill them truthfully.
- Before any source work, read [source-edits](references/source-edits.md).
- For follow-ups, large content, paging, compaction, uncertainty or restart, read
  [context-and-recovery](references/context-and-recovery.md). Start with the
  closest relevant previous exchange or `handoff.historyCommand` (`--limit 1`).
  Do not eagerly load every thread or all history. Agent context excludes current,
  later and saved-unsent messages; browser drafts are not agent instructions.

## Non-negotiable boundaries

Discuss means answer without source edits. Each request-change permits only that
specific change, not blanket editing. The overall note has independent intent;
historical intent never renews permission. Clarify or defer unsafe/ambiguous work.

Preserve exact human text, formatting, moves, deletions and assets in true source.
Never reapply an edit with saved evidence. Never apply capture-truncated content
as complete or invent missing text. Missing targets require identification or
clarification, not guessed replacements.

Respond exactly once per submitted message and exact edit version, plus one
independent `resultNote`. A note requires scalar `overallOutcome`; its prose goes
in `resultNote`. Do not invent success.

```sh
npx -y @erdemtuna/doc-review respond --review <reviewId> --entry <entryKey> --response-file response.json --timeout 600
```

After acceptance, poll the same review. Retry an uncertain response using the
identical file/requestId; never repeat source edits because transport failed.
End freezes reviewer content but does not cancel accepted work. Abandoned work
cannot complete and does not imply the external handler stopped. Delivery is not
agent liveness. One cooperating handler is assumed; receipts do not give worker
leases or filesystem exactly-once guarantees. Stop if the user cancels.
