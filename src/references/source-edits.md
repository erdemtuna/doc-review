# Exact source edits

Before source work, inspect every necessary inventory/content page and the actual
authoritative source. A downloaded/exported file is not evidence you inspected it.
`inline.value` is the complete retained object; a `reference` is only a delivery
pointer. Follow its command or export and read the artifact. A preview is never an
`after` replacement. Fields remain exact, including line endings and Unicode.

Every submitted message carries independent `discuss` or `request-change` intent.
Discuss is answered without editing for that message. Request-change permits,
but does not require, only its specific change. An overall note is independent;
neither it nor a historical request grants blanket permission.

Human direct edits are exact requested content separate from message intent.
Preserve non-truncated `after` wording verbatim. Translate HTML formatting into
the true source syntax, retain insertion points/assets, honor moves'
`moved_after`/`moved_before` boundaries and explicit deletions. Read all
representations needed to understand the edit, not merely a convenient preview.

The edit's `source` data contains `state:"pending"` or `state:"saved"` plus
server-owned evidence: review, page, edit ID/version, source hash and saved time.
Never reapply a saved edit. Use `already-saved` only with that exact evidence.
Report inconsistent source/evidence instead of guessing that a write succeeded.

Inventory page entries identify real files/URLs. For source-pending Markdown,
scripted HTML and localhost pages, find actual Markdown/MDX/TSX/template/component
source; do not replace source with rendered Markdown, fetched HTTP, or
script-generated DOM. Plain HTML alone supports the reviewer's direct save.
Disabling scripts is not permission to write source.

Use exact target anchors and authoritative source to identify the intended
location. Missing/ambiguous targets require safe identification or a
clarification/deferred outcome; never guess a destructive replacement.
Copy authoritative staged assets from their retained paths into the correct
project asset location and replace temporary preview references without losing
the original insertion point.

`captureTruncated` and `truncatedFields` mirror original `content.truncated` and
`content.truncated_fields`. These mean evidence was clipped during capture
(currently 200,000 Unicode code points per text/HTML/move field), not during
delivery. Delivery references do NOT clear those flags. Never apply incomplete
text/HTML as a complete replacement or invent missing text. Recover only from an
authoritative source or defer and request the complete edit.

Inspect current source and durable evidence after a restart or uncertain
response. Receipt replay protects durable responses, not filesystem operations;
never repeat source writes simply because an HTTP connection failed.
