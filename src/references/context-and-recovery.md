# Bounded reads and recovery

One agent interface limits final JSON stdout to 16 KiB UTF-8 including escaping
and newline. No compact/full or raw fallback exists. Durable evidence is not
truncated for delivery. Large values carry exact scoped references with
version/field identity, encoding, byte length and SHA-256. Previews are explicitly
incomplete. Original edit capture truncation is a separate fact.

Inventory/history/context/status blocker pages report `totalCount`,
`returnedCount`, `complete` and `nextCursor`. Continue the same command with
`--cursor <opaque-token>` until complete where full coverage is necessary.
Never assume the first page is the complete response obligation. The generated
template covers all items even when the inventory is paged.

## Deliberate historical context

For a follow-up, start with the closest relevant earlier exchange using the
message item's `contextCommand` (default generated `--limit 1`):

```sh
npx -y @erdemtuna/doc-review context --review <reviewId> --entry <entryKey> --submission <currentSubmissionId> --thread <threadId> --limit 1
```

The producer reads immutable submissions, excludes current and later work and
saved-unsent replies before pagination, and provides historical lifecycle
evidence. Browser context intentionally still shows pending replies.
Do not load all threads' history speculatively.

For earlier overall notes, results, edits or lost chat context, use the
submission's `handoff.historyCommand`:

```sh
npx -y @erdemtuna/doc-review history --review <reviewId> --entry <entryKey> --before <currentSubmissionId> --limit 1
npx -y @erdemtuna/doc-review submission --review <reviewId> --entry <entryKey> --submission <priorSubmissionId>
```

History retains note intent, result notes and handled/abandoned evidence.
Submission reads include exact paged messages/edits, inline responses, edit
outcomes and receipt. Ended reviews and terminal submissions remain readable.
Earlier request-change intent is historical evidence, never new permission.

## Exact content

Copy the reference's generated command. `field` is a scoped artifact path, not
a filesystem path. Never transplant a cursor into another scope/field/version.

```sh
npx -y @erdemtuna/doc-review content --review <reviewId> --entry <entryKey> --submission <submissionId> --field submission/edits/0/content/after_html
```

A content read gives exact `text`, encoding (`utf8` or serialized `json`),
UTF-8 byte `offset`, `returnedBytes`, complete-field byte length/hash,
`complete`, and `nextCursor`. Concatenate chunks in order until complete;
Unicode characters and line endings are preserved. Parse JSON only after
reconstruction. A continuation identity/content change is an error, not a splice.

For a complete field, append `--output-file <new-path>`. Omit `--field` to export
the whole submitted artifact (submission, result, receipt and canonical pages).
The receipt gives path/identity/encoding/bytes/hash. Writing is atomic/exclusive;
existing files and reviewed source are never overwritten. Read exported content
before using it. A file receipt alone does not prove inspection.

## Identity, retries and End

Keep reviewId, entryKey, submissionId, delivered version, response file and stable
requestId across compaction. `status` reads lifecycle evidence without starting a
server or mutating offline state. It deliberately provides only result previews/
references; explicit content/history reads return requested prose when it fits.

```sh
npx -y @erdemtuna/doc-review status --review <reviewId> --entry <entryKey>
npx -y @erdemtuna/doc-review receipt --review <reviewId> --entry <entryKey> --request-id <requestId>
```

Status reports queued/delivered work, pending counts and predecessor/overlapping
blockers; `source:"disk"` means validated offline evidence, not agent liveness.
Corrupt/unsupported state fails explicitly, without legacy fallback.

Semantic rejection (exit 1), uncertain acceptance (exit 2), and accepted receipt
are different. `not-found` from receipt is not proof of rejection. Retry an
uncertain response with exactly the same file/requestId; do not regenerate the
template or repeat source edits. Inspect source and receipts before considering
any further filesystem work. One cooperating handler is assumed; no worker
leases or filesystem exactly-once guarantees exist.

End freezes reviewer content, not accepted work. Complete non-abandoned work
after End/restart; keep polling that review until `ended`. Saved-unsent content
does not transfer to a new review. Abandonment releases work exclusion but does
not cancel the external handler or undo source writes. `SUBMISSION_ABANDONED`
means stop handling, never retry as a new completion.

## Reviewer interaction

The page starts in View. Feedback is nonmodal: it docks on roomy desktops and
floats on narrow PC windows, without dimming or disabling the document. Show in document
reveals the exact passage, hiding a floating panel only when it would obscure the
target. Focus and secondary thread actions are in the conversation menu.
Resolve/Reopen sits opposite Reply below an expanded conversation and remains in
Conversation actions when collapsed or a local draft is open. Resolve refuses unfinished drafts,
unsent messages and outstanding agent work. Resolve/Reopen do not show notifications.
Review-state transitions, especially receipt of an agent response, appear for five
seconds at the top left below the toolbar. Hover, notification focus or a hidden
tab pauses expiry; reading the document iframe does not. Focus includes a visible
Back to Feedback action; Open/Resolved are separate independent filters.
Sidebar headers end with Locate, More and Collapse; adjacent headers use Open in
Feedback (a right-pointing arrow), More and Close. Edit belongs beside each eligible
message's timestamp. The far-right delivery icon changes from Not sent to Sent,
then Received when the agent picks up the message or replies.
Resolved conversations automatically collapse and show a subdued check-circle
**Resolved** informational icon with a keyboard-visible explanation; they remain expandable
for reading. Reopen expands them again. Resolution from another tab never
hides a local draft.

Add comment / Add reply / Update comment queue a message;
**Send to agent (N)** dispatches a deliberate batch.
Send includes all saved pending messages and edits. **Your edits** contains exact
human edit evidence. **Note to agent** opens separately with its own unchecked
change permission. Unsaved comment drafts are not sent.
Send freezes the selected versions and note at activation; feedback arriving
during preparation stays pending. A changed selected version requires reviewing
the selection again.

Expanded conversations retain two recent sent exchanges and all unsent replies.
The preceding answer remains visible while composing a follow-up; **Show earlier
replies** loads older context. Closing Feedback or changing hosts preserves the
mounted editor and its local draft, but reloading a tab loses unsaved drafts.
Long result summaries expand with **Read more / Show less**. **Replies (N)**
lists source labels and comment excerpts. The reply reader retains the
Feedback/History tabs, **Previous/Next** and **Back to replies**, restoring the
originating list, scroll and keyboard focus without discarding drafts.
