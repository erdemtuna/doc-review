# Complete responses

Generate a new response file using the actual submission handoff:

```sh
npx -y @erdemtuna/doc-review response-template --review <reviewId> --entry <entryKey> --submission <submissionId> --output-file response.json
```

This reads the authoritative immutable submission, not just the first inventory
page. It includes every message/edit and exact version, delivered expectedVersion,
and a stable requestId. The file is exclusive: an existing response is never
overwritten. Inspect/reuse it for recovery; do not generate a new ID for a retry.
All blank prose/outcomes deliberately fail validation until filled. The command
does not edit source or assert that anything was applied.

The JSON contract is strict (unknown fields are rejected):

```json
{
  "operation": "respond",
  "reviewId": "review-id",
  "entryKey": "entry-key",
  "submissionId": "submission-id",
  "expectedVersion": 2,
  "requestId": "stable-request-id",
  "responses": [{
    "threadId": "thread-id",
    "messageId": "message-id",
    "messageVersion": 1,
    "body": "The explanation preserves the original meaning.",
    "outcome": "answered"
  }],
  "editOutcomes": [{
    "editId": "edit-id",
    "editVersion": 1,
    "outcome": "deferred",
    "reason": "The source target is ambiguous; please identify the component."
  }],
  "overallOutcome": "answered",
  "resultNote": "Answered the discussion and overall note; deferred the ambiguous edit."
}
```

Keep the generated IDs, versions and requestId. `responses` must cover every
submitted message exactly once, not just visible inventory items. Each response
has a nonempty body and scalar outcome: `answered`, `applied`,
`clarification-needed`, or `deferred`. Only that message's request-change permits
`applied`; another message or overall note cannot grant it permission.

`editOutcomes` covers each exact edit version once. Outcome is `applied`,
`already-saved`, or `deferred`, with nonempty `reason`. `already-saved` requires
server save evidence. Saved or capture-truncated edits cannot be newly `applied`.
Use truthful deferrals instead of fabricated success to satisfy coverage.

`overallOutcome` is a **scalar string**, not an object. Include it if and only if
the submission has an overall note. Its enum is `applied`, `answered`,
`clarification-needed`, `deferred`; `applied` requires that note's request-change.
The overall answer's prose belongs in `resultNote`. That independent, nonempty
result note is always required, even without an overall note.

A note-only response has empty `responses` and `editOutcomes` arrays, for example:

```json
{
  "operation": "respond",
  "reviewId": "review-id",
  "entryKey": "entry-key",
  "submissionId": "submission-id",
  "expectedVersion": 2,
  "requestId": "stable-request-id",
  "responses": [],
  "editOutcomes": [],
  "overallOutcome": "answered",
  "resultNote": "The earlier result explained the tradeoff; no new source change was requested."
}
```

Submit the filled file:

```sh
npx -y @erdemtuna/doc-review respond --review <reviewId> --entry <entryKey> --response-file response.json --timeout 600
```

`{ok:true,receipt}` means the complete response persisted atomically. Comparison
capture does not gate acceptance. Reply-only work does not fabricate a version or
reload; saved human changes can display "What changed" without new agent edits.
Then poll the original review again.

Exit 1 is a semantic/explicit failure. Correct a rejected response deliberately;
do not turn a rejection into success. Exit 2 (`state:"unknown"`) means acceptance
is uncertain. The CLI already retries the same logical body within its deadline.
Retry the identical response file, not source work or a newly minted requestId.
See [context-and-recovery](context-and-recovery.md) before recovering uncertainty.
