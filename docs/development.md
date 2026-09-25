# Development

[Back to the README](../README.md) | [Usage guide](usage.md) | [Releasing](../RELEASING.md)

## Local setup

Use Node **24.21.0** or a newer Node 24 LTS patch, and npm **12.0.2**.
A project scoped runtime is sufficient; there is no need to replace a shared
machine's global installation. CI also checks Node 26 compatibility.

```sh
npm ci
npm run build
npm start -- path/to/file.html
```

`npm start` builds and runs the compiled CLI. Published packages already include
the runtime and do not require TypeScript or an installation build.

## Build and checks

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Strict shared, browser, Node, UI, UI-test, and tooling checks |
| `npm run build` | Generate palette/brand assets, check types, emit Node/SDK ESM, bundle UI, and copy runtime assets |
| `npm run test:unit` | Rebuild and run Node unit and UI component tests |
| `npm run test:ui` | Run focused Vitest/Testing Library component tests in jsdom |
| `npm run preview:ui` | Build and serve the isolated component gallery |
| `npm run preview:recovery` | Build and serve the isolated recovery-state gallery |
| `npm run preview:shell` | Build and serve a disposable shell review on an isolated runtime snapshot |
| `npm run preview:review` | Alias for the same durable shell preview |
| `npm run media:readme` | Build and capture the three README screenshots and social cover into `output/readme` |
| `npm run media:preview` | Preview the README, usage guide, and tracked social cover on loopback |
| `npm run browser:install` | Install the matching Chromium |
| `npm run test:browser` | Rebuild and run browser tests |
| `npm run test:package` | Pack and check an isolated production installation |
| `npm run test:package:browser` | Also open an installed package review in Chromium |
| `npm run test:all` | Build, run unit and browser suites, then check packaging |

Install Chromium before the browser commands. CI uses
`npm run browser:install:ci` to include its system dependencies.
`test:all` runs the browser suite but uses the nonbrowser package smoke; run
`test:package:browser` when validating the installed browser experience too.

The installed browser gate also runs the approved Field Notes geometry, responsive
draft/readability, toolbar, contextual, card, result and deterministic anchor-ordering
tests against the installed package's **own** `lib`, not the checkout runtime.
The configured engine is Playwright Chromium; this is not cross-browser certification.
There are no pixel-snapshot baselines. `test/fixtures/approved-ui-parity.js` records
the reviewed STEP6 geometry/build provenance; natural text clipping, actual pointer
hits and preserved editors remain behavioral assertions rather than screenshot-box
proxies.

For a final acceptance run, set `DOC_REVIEW_SMOKE_ARTIFACTS` to an evidence directory.
Set `DOC_REVIEW_SMOKE_KEEP=1` to preserve the isolated installation, authored sources,
state and browser fixtures instead of removing a successful smoke directory.
`installed-runtime.json` records its exact installed path, tarball SHA256 and runtime
hashes without credentials. Optionally set `DOC_REVIEW_APPROVED_RUNTIME` to an
immutable approved `lib` directory: the gate requires byte-for-byte equality.
`preview-fixture.json` names a disposable Field Notes review plus the real changed
source example. Do not print `server.json` or copy its token into a report.
These options do not publish a package or start a lasting preview.

Source lives in `src`; the TypeScript compiler emits Node/SDK ESM into `lib`.
Before checking types, the build generates the shell/SDK palette from
`src/review-palette.js` and the inline toolbar/favicon asset from
`src/assets/doc-review.svg`. Run `node scripts/generate-review-theme.js` and
`node scripts/generate-brand.js` after changing their sources; brand generation
also supports `--check` to reject stale outputs without writing. Keep generated
outputs in sync rather than editing their colors or encoded SVG by hand.
The SDK does not import a palette module at browser runtime, and the favicon
needs no new server route or static bundle output.
Vite separately bundles `src/ui/main.tsx` into deterministic `lib/ui/chrome.js`
and `lib/ui/chrome.css`, still served at `/chrome.js` and `/chrome.css`.
The entry mounts the React toolbar outside the authored iframe, with an independently
centered status badge, a Radix hover/focus tooltip and far-right View/Edit menu.
Only contextual error recovery adds a full-width row; the normal More menu is removed.
Feedback, Focus and adjacent conversations share one mounted conversation tree,
draft owner and editor. Changes controls and both comparison representations
also use React; there is no alternate legacy shell entry.
Legacy styles occupy a lower cascade layer; new tokens and baselines apply only
inside `.review-ui` surfaces and their portals, with generated legacy aliases
sharing the same palette. The component gallery stays separate.
React, Tailwind, Radix-backed shadcn controls, and browser-only dependencies are
build-time dependencies; installed packages require no Vite or UI tooling.
Vite emits bundled dependency licenses in `lib/ui/THIRD_PARTY_NOTICES.md`;
the build also appends the licenses for generated Lucide icons and adapted
shadcn component source.
UI TSX uses strict bundler resolution and the `@` alias for `src/ui`; UI sources
are excluded from Node emission. UI tests and tooling have separate type checks.
See [UI design system](ui-design-system.md) for ownership and the separately
built gallery; `.ui-preview` and `.recovery-preview` are not shipped.
Existing JavaScript remains unchecked while new TypeScript is strict.
Pure contracts have no Node or DOM globals. Browser modules use DOM types
without Node globals; Node consumers use Node 24 typings without DOM globals.
Shared runtime helpers are checked in their consuming environments. Keep `.js`
import specifiers in TypeScript source.

The build script alone removes generated `lib`; Vite never cleans sibling
Node/SDK files. The explicit copied assets are `chrome.html` and `SKILL.md`.
Release candidates in `dist` are separate.
Do not rebuild while another process is testing or serving `lib`.
`preview:shell` copies the built runtime and a populated sample document into
a private `.shell-preview-*` directory before serving. Later builds cannot
change that review candidate. Stop it with Ctrl+C to remove its disposable state.
The fixture contains a saved Discussion and a separate checked change request.
The older `--recovery`, `--comments`, `--contextual` and `--feedback` flags select
this same current shell, never another workflow. `preview:review` is an alias.
Use `node scripts/shell-preview.js --smoke` after building to validate seeding
and clean up without leaving a process. See [the checklist](migration-review.md).
The component gallery uses simulated state; these shell previews use the real
durable server. The installed-package browser smoke below exercises the complete
HTML/Markdown/scripted/URL lifecycle and retained comparisons.

## README media

The media tells one story using the fictional Field Notes landing page:
an adjacent conversation, Feedback with saved pending messages and edits, then
Changes after the requested description and call to action have been revised.
The social cover is a separate composition, not another README banner.

With the local dependencies and Chromium installed, run:

```sh
npm run media:readme
```

The capture recipe in `scripts/capture-readme.js` uses
`test/fixtures/readme-review.js` and a private copy of the built runtime.
It types a real headline edit, adds two selection comments, fills the overall
note, sends a durable submission, applies a scripted revision, submits a complete
response for that exact review, and waits for real SDK history captures. This is a scripted product
example, not a recording of an autonomous agent. No existing review is reused.
Its private server, browser, files, and state are cleaned up on success or failure.

Product captures use a 1120 x 800 viewport at 1.5 device scale (1680 x 1200 PNG),
light mode, English locale, and UTC. `scripts/readme-cover.js` composes the
1280 x 640 social PNG from the actual Review capture. All four outputs must be
below 1 MB. The script checks the saved edit, feedback inventory, successful
response, expected changed text, image dimensions, and browser
errors. It leaves staged PNGs in ignored `output/readme`; use
`node scripts/capture-readme.js --output <directory>` after a build to stage
elsewhere. It does not overwrite tracked images by default.

Inspect all four images at full size and typical README width before copying
the corresponding PNGs into `assets`. Keep the filenames stable:

| Asset | Use |
| --- | --- |
| `doc-review.png` | README hero and highlight-adjacent conversation |
| `doc-review-feedback.png` | Conversation inventory, pending edits, overall note and Send/End actions |
| `doc-review-changes.png` | Completed comparison of the same submission |
| `doc-review-social.png` | GitHub social-sharing cover |

Run `npm run media:preview` to inspect the rendered README, usage guide and
social cover using the tracked images. It prints a loopback URL; stop with
Ctrl+C. The preview only serves those documents and four explicitly named assets.
The README retains absolute `raw.githubusercontent.com/.../main/assets/...`
image URLs for npm compatibility: the GitHub Markdown API used by npm leaves
relative image sources relative. Consequently, GitHub branch previews show
the current `main` images until merge. The local preview maps just those image
references to the local assets, without changing README content. The usage
guide keeps repository-relative links. npm README copy changes appear only
after a package release; this media workflow does not publish one.

To apply the social cover separately, a repository maintainer can open GitHub
**Settings > General > Social preview** and upload `assets/doc-review-social.png`.
Generating or committing that file does not change the repository setting.
Keep the cover at 1280 x 640 and below GitHub's 1 MB upload limit.

## Architecture and tests

Tests import and serve compiled modules. The generated icon consistency check
intentionally reads committed source; after changing the selected icons, run
`node scripts/generate-icons.js`.

### Persistent conversation contract

`src/contracts` exports executable `Schema<T>.parse(unknown)` decoders and inferred
TypeScript types shared by the durable server, agent CLI and browser owner.
Page validators live in `page-boundary.ts` and the barrel; `page.ts` exposes
their types without adding runtime dependencies to SDK consumers.
Representative success and failure cases are in `test/contracts.test.js` and
`test/fixtures/conversation-contracts.js`.

All fields are required unless `optional(...)` appears in the schema. Optional
means **absent**, not null or explicit undefined. Null is accepted only by
`nullable(...)`. Every new object rejects unknown fields, including nested objects,
client-supplied authors and save evidence. No string coercion, trimming, instruction
truncation, default intent on malformed input, or acknowledgement-only response is
allowed. Nonempty text must contain non-whitespace; its original bytes are kept.
The composer defaults to `discuss` and sends that explicit intent. Saved badges are
`Discussion` and `Change requested`; checked requests permit, not mandate, edits.

IDs are opaque nonempty strings, not paths or evidence of authorization. The server
allocates review/thread/message/edit/submission/result/receipt/evidence IDs and
timestamps (integer Unix milliseconds), plus positive integer versions. Request
IDs are caller-generated. Canonical entry/page keys come from the existing target
resolver, not caller assertions; browser session, render ID, generation, and
frame-only capability are ephemeral and cannot replace durable review identity.

In the table, **M** means required `{reviewId,entryKey,requestId,expectedVersion}`;
**R** means `{reviewId,entryKey}`. `operation` is always the exact literal shown.
Transport adapters must assemble and validate the complete DTO, reject conflicting
path/body identities, authenticate using the existing local token/scope gates, and
validate the corresponding output. The table defines the shared producer and
consumer contract.

| Operation / decoder | Concrete request beyond M or R | Output / acceptance boundary |
| --- | --- | --- |
| `open` / `openReviewRequestSchema` | `{operation,requestId,target}` (no M) | `acceptedMutationSchema`; atomically join the sole open review for the canonical entry, or create one. New tabs join, not fork. Exact replay returns the original review even after End. A fresh open request after End creates a fresh review. |
| `join-page` / `joinReviewPageRequestSchema` | M + `target` | Accepted receipt with `pageKey`; server-authorized membership belongs to the shared review, not visited tabs. Open-review/version preconditions apply. |
| `read-review`, `read-page` / `reviewReadRequestSchema` | R; `read-page` also requires `pageKey` | `reviewSchema` / `reviewPageSchema`. Exact old review links recover read-only after restart; never substitute the newest review. Shared canonical source metadata is separate from review-local edit/revert ownership. |
| `create-thread`, `reply`, `update-message` / `reviewerMutationSchema` | M + `body,intent`; create requires `pageKey,target`, reply requires `threadId`, update requires `threadId,messageId,messageVersion` | Receipt with durable IDs. Initial message and thread commit together. Only never-submitted reviewer messages may be edited. Follow-ups are new messages; queued instructions cannot be replaced. |
| `set-thread-status`, `delete-thread` | M + `threadId`; status also requires `status:"open" or "resolved"` | Reviewer-only explicit Resolve/Reopen. Resolve requires no pending/outstanding messages; deletion requires an entirely never-submitted thread and retained replay tombstone. Replies and anchor failures never resolve a thread. |
| `record-edit`, `save-edit`, `revert` | M + `pageKey`; record requires `content`, optionally **both** `editId,editVersion`; save requires `editId,editVersion,expectedSourceHash,html`; revert requires `expectedSourceHash,baselineRevisionId` | Review-local edits have immutable IDs/versions, exact HTML/move/delete fields and asset references. Save evidence is server-only. Save/revert require current writable-source hashes; revert must match this review's baseline and last write. |
| `send` / `sendRequestSchema` | M + `pageKeys`, `messages:[{threadId,messageId,version}]`, `edits:[{pageKey,editId,version}]`; optional `overallNote:{body,intent}` | Receipt with `submissionId`; selected pending items from **any authorized member page of this shared review**, independent of tab visitation. Each item's page must be selected. At least one known page and one item/note; no implicit selection or splitting. |
| `end` | M + `confirmUnsentReadOnly:true` | Shared End receipt. Freezes all reviewer content across tabs. Unsent saved items stay read-only in this review and never transfer or auto-submit. Accepted work still completes; End does not cancel it. |
| `poll`, `status`, `submission` / `reviewReadRequestSchema` | R; `submission` also requires `submissionId` | `pollResponseSchema`: `work` with exact delivered submission, `waiting` only while open, or `ended` after outstanding work is terminal. First delivery advances submission version; repeated delivery preserves it. `reviewStatusSchema` reports pending counts, queued/delivered evidence and blockers, not agent liveness. `submissionReadSchema` returns immutable submission plus nullable result/handling receipt. |
| `respond` / `completeResponseSchema` | M + `submissionId,responses:[{threadId,messageId,messageVersion,body,outcome}],editOutcomes:[{editId,editVersion,outcome,reason}],resultNote`; optional `overallOutcome` | `validateResponseCommit` requires all replies, edit outcomes, **one** result note and receipt together. M's expected version is the **submission** version, not the ended review's version. |
| `abandon` / `abandonRequestSchema` | M + `submissionId,reason,confirmExternalWorkMayContinue:true` | Submission-version precondition; allowed after End. Terminal, immutable retained work; stops delivery and releases exclusions, not external writes. Completion-first yields `ALREADY_HANDLED`; abandonment-first rejects late completion with `SUBMISSION_ABANDONED`. |
| `receipt`, `open-receipt` / `reviewReadRequestSchema` | R + `requestId`; open lookup instead uses `target,requestId` | `receiptLookupSchema`: `accepted` with receipt or `not-found`. A lookup miss is **not** proof an in-flight request was rejected. |
| `list` / `conversationListRequestSchema` | `{operation,scope:{reviewId,entryKey,collection,pageKey,threadId,submissionId,status},query:{limit?,cursor?}}` | Bounded pages of threads, context, history, pages, unsubmitted edits or comparison references. Filter IDs are required nullable fields; only context requires a thread, only comparisons a submission, and only threads permit open/resolved status rather than all. |

`assertReviewScope` / `assertEntityScope` reject unauthenticated, unknown, and
wrong-review/page identities. Every read, context cursor, selected item, write,
poll and receipt lookup needs these server-resolved checks; schema shape checking
alone does not authorize anything. `validateReviewerMutation` and
`validateSendSelection` consume the server's complete review-local item/source
catalogs, not client-supplied catalogs. `join-page` uses the same open/version guard
after canonical target authorization. Author labels are operation attribution in
one trusted local caller domain, not cryptographically distinct individuals or a
sandbox against an agent's filesystem access.

**Durability, replay and exclusions.** Within one serialized accepting transaction:
authenticate/authorize, validate shape, look up `(reviewId,requestId)` across all
mutation operations, call `exactReplay`, then check versions/lifecycle/ownership,
then durably publish. Open requests instead use `(canonical entry,requestId)`.
Persist the canonical JSON payload and receipt indefinitely. Key order is
immaterial; array order, text, intent and expectedVersion are significant. Exact
replay returns the stored receipt **before** stale-version, End, exclusion or
terminal-state checks. Changed content under an existing ID is `REQUEST_CONFLICT`;
a refreshed operation needs a new ID. Other reviewer commands use review-wide
expectedVersion; entity versions additionally identify exact messages/edits.
Delivery, response and abandonment advance submission versions. End does not
invalidate an accepted submission's version.

Receipt storage uses collision-safe tagged tuple keys: `["review",reviewId,requestId]`
for all mutation operations and `["open",entryKey,requestId]` for opening a canonical
entry. Different reviews/entries and the open versus mutation namespaces may reuse
a caller ID; changing payload or operation within the same namespace still conflicts.
Receipt reads search only their specified namespace. Persisted receipt scope and the
original response's pre-completion version are validated again at restart, without
importing or repairing an older store layout. `submissionReadSchema` reconstructs
the delivered version as the handled submission's version minus one.

`list` with `collection:"edits"` returns only unsubmitted review-local records,
matching the pending edit counts on pages and status. Send removes selected edits
from this collection atomically without deleting their records. Submitted edits,
including deferred and abandoned ones, remain immutable in exact submission reads;
history locates those submissions. They never reappear automatically as pending.
A deliberate new `record-edit` without an `editId` creates a new pending identity.

`exclusionKeys` is the sorted unique canonical entry plus all selected submitted
page keys, including explicitly selected note-only pages. `outstandingSubmissions`
includes queued and delivered work in **every review**, including ended ones.
Overlap blocks Send, direct-edit recording, save and revert server-side; discussion
preparation and reading remain available. Hidden source overlap between different
localhost URLs is not detectable. Abandoned/handled work releases exclusions.
Submitted messages/edits, including deferred or abandoned ones, are never silently
queued again: deliberate new records/submissions are required. One cooperating
agent is assumed; persisted response replay does not make filesystem edits
exactly-once.

**Atomic response and source evidence.** Inline outcomes are `applied`, `answered`,
`clarification-needed`, or `deferred`, exactly once per submitted reviewer message
and exact version/thread. `discuss` cannot be `applied`. Overall notes belong only
to the submission; `overallOutcome` exists iff its nonempty note exists and is
subject to **its own** intent. It grants no inline edit authorization. Edit outcomes
are `applied`, `already-saved`, or `deferred`, with nonempty reasons, exactly once
per exact edit version. `already-saved` requires server evidence matching review,
page, edit ID/version and current writable source **at Send**; Markdown, scripted
HTML and localhost source-pending edits cannot invent it. Asset paths are resolved
server-side from staged IDs. Truncated edits cannot claim Applied or saved evidence.

Results store one separate body and generated inline agent messages with
`replyToMessageId`; do not copy inline discussion into the result note.
`responseEffect` reports new agent source work only for Applied outcomes.
`resultTitle` is `What changed` for new work **or already-saved human edits**, else
`Agent response`. Already-saved-only and discussion-only results do not fabricate
new versions/captures. Comparison failure is independent of the committed result.
`submissionReadSchema` checks complete result/receipt associations again on output.

**Bootstrap and exact autosave.** Shared SDK injection consumes only the safe
opening prefix (doctype, complete leading comments/whitespace, optional `html`
and `head` opening tags). Inserting before an existing `html`/`head` can make the
HTML parser redistribute authored whitespace into an implicit head, falsely
classifying a plain file as dynamic and breaking exact save evidence. Do not
normalize authored whitespace or loosen dynamic/save validation to compensate.
Do not search forward for a head tag through potentially unclosed raw text.
`source-save-compat.spec.js` covers real plain-file autosave and scripted-page
feedback-only protection together. In browser evidence scripts, use screenshot
`caret: "initial"` while authored content is editable: Playwright's caret hiding
can leave an otherwise absent empty `style` attribute on the editable body.

**Paging and anchor projections.** Reviewed defaults are 50, maximum 100, minimum
1, for every collection; these are page sizes, not retention or submission caps.
Creation uses a persistent review-wide monotonic `sequence`, independent of mutable
versions and wall-clock timestamps (avoids clock/timestamp ties). Inventory/history
sort newest-first. Context loads newest windows first, each displayed chronologically,
then Load earlier. An exchange is one reviewer message plus its actual optional
reply, never the last two arbitrary messages. Thread summaries contain that one
latest exchange and authoritative total/pending counts. History summaries contain
result notes and comparison counts, not all inline messages or comparison targets.
Full submissions are separately retrievable without silent truncation.

Cursor strings encode strict `{scope,highWater,before}` JSON and are opaque to
consumers, **not secrets or authorization**. Validate scope and nonfuture ranges;
membership is bounded by the captured creation high-water mark, while retained
entities' status/version may refresh. Context excludes replies created after that
mark. Reconnect/refresh starts a new window. Invalid or incompatible cursors fail
with `INVALID_CURSOR`; a valid end has `nextCursor:null`. `validatePageOutput`
enforces requested limits, ordering and cursor continuation. No automatic expiry.

`frameAnchorsSchema` projects only original target metadata plus thread IDs and
current review/page/render/generation/frame-only capability. The API token,
message bodies, intents and results are forbidden. `validateFrameAnchorStates`
checks exact projected membership and current identity. States are `found` with
finite geometry, `missing`, `ambiguous` with multiple candidates, or `unavailable`
for loading/changed/unmeasurable renders. None changes thread status, original
anchors or history; there is no reattachment API.

**Frame boundary.**
`eh:threadAction` carries only the same capability/review/page/render/generation
scope, one projected `threadId`, and `activate`, `reveal`, or `dismiss`.
`validateFrameThreadAction` rejects stale scope, nonmembers and additional fields.
The SDK remeasures before activation/reveal; dismissal remains possible after
target loss. A frame binds review/render identity on its first valid projection
and cannot switch that identity. The shell must independently validate reports
and actions against its current projection; legacy activation is not a substitute.

Found geometry distinguishes `visible`, `above`, `below`, `left` and `right`;
offscreen is not missing. Unavailable reasons additionally distinguish `hidden`,
`invalid-selector` and `render-unavailable`. Loading and failed-render states
must never become missing-target claims. Exact and whitespace-normalized quote
candidates compete together; equally ranked candidates are ambiguous. Duplicate
selectors are ambiguous. Within a render, replacing a previously matched element
with another node using its selector is conservatively `render-changed`, not an
automatic relocation. Moving the same node remains supported. Selector metadata
alone cannot prove semantic identity after a new render; no historical semantic
identity guarantee or anchor rewrite is introduced.

`thread-anchor-controller.ts` validates the producer's complete state report
before accepting a new projection. Its native-module dependencies are served
with the existing opaque-frame CORS and exact immutable-module CSP allowlist.
`e2e/thread-anchors.spec.js` exercises this boundary directly with the real SDK;
`e2e/conversation-adjacent.spec.js` exercises its durable shell consumer and the
same mounted conversation/editor across all hosts.

**Existing safety bounds (no additional content/item caps).**

| Boundary | Retained limit and unit | Evidence / new rejection |
| --- | --- | --- |
| Aggregate JSON request | 24 MiB UTF-8 bytes | `server.js` MAX_BODY; `parseContractJson` rejects `INPUT_TOO_LARGE` (413), malformed JSON is `MALFORMED_JSON` (400). Streaming adapters enforce the byte limit before buffering too. |
| Anchor quote / prefix / suffix / selector / label | 4,000 / 1,000 / 1,000 / 2,000 / 500 UTF-16 code units | `comment-anchor.js`; new validators reject rather than slice. Optional context may be empty, not null. |
| Each direct-edit text/HTML/move field; assets per edit | 200,000 Unicode code points; 20 asset references | `edit-limits.js` and `server.js` asset selection. Reject excess; preserve supplied `truncated` and unique `truncated_fields` metadata, never silently lose assets. |
| Source / semantic / combined snapshots | 8 / 4 / 12 MiB UTF-8 bytes | Existing `revision-schema.js` / `revision-store.js`, `SNAPSHOT_TOO_LARGE` (413). Unchanged; result notes do not depend on capture success. |
| Semantic snapshot structure | 2,000 blocks; 100,000 UTF-16 units/block and combined runs; 1,000,000 total text units; 1,000 runs/block; depth 64; attribute/selector 4,096 units; 100 limitation entries of 500 units | Existing revision validators remain authoritative. These are snapshot bounds, not conversation limits. |

Failures are `{ok:false,error:{code,message,status,retryable}}`, validated against
`ERROR_STATUS`; unknown fields/codes fail validation. Invalid shapes/empty Send are
400, missing auth 401, wrong scope 403, unknown IDs 404, stale/immutable/conflicting
state or incomplete coverage 409, bounds 413, unexpected internal faults 500, and
failed durable persistence 503 (`retryable:true` only for `STATE_PERSIST_FAILED`).
Log unexpected failures locally without bodies/tokens. A transport timeout, lost
connection, unavailable server or malformed response is
`{state:"unknown",requestId,reason}`, **not** a known rejection or success.
`transportOutcomeSchema` distinguishes all three. Reconcile uncertain Send/End/
response acceptance using the same identity/payload and receipt lookup; never
repeat source edits merely because a response was lost.

Conversation storage uses only `conversation-state.json` in the existing state directory;
no import, migration, opt-in, old-file modification or cleanup of old-owned assets.
Retain saved conversations, exact submissions, results, receipts, comparison
snapshots/assets indefinitely. Single atomic JSON storage has unbounded disk/write
growth; the measured diagnostic below is not an expiration policy or
database redesign. No draft persistence/recovery/cross-tab draft sync is promised.

### Durable conversation producer

The authenticated `POST /api/conversation` endpoint consumes the shared
operation-discriminated requests, without changing those schemas. `Store.conversations`
is the synchronous producer behind the endpoint. Mutations clone the complete store,
validate scope/replay/version/lifecycle/exclusions, persist once, then publish.
Inline replies, the independent result note, immutable submission state, and the
handling receipt commit together. A failed write returns `STATE_PERSIST_FAILED`
(503), with neither partial publication nor a successful receipt. Poll delivery
is durable but is **not** evidence of a live agent.

`open` joins the one open review for a canonical entry; End closes the shared
review, not its accepted submissions. A subsequent open creates a fresh identity.
Old `/r/<reviewId>` links bootstrap read-only sessions after restart, including
observers of late results. Saved-unsent content is neither transferred nor sent.
All tabs receive `invalidate` events and an initial reconnect hint; reads do not
emit further invalidations. Clients must refetch authoritative review/status/pages.
Only changes-reported responses request a result reload/capture; a reply-only or
already-saved-only result does neither.

The server also exposes these supporting, authenticated POST boundaries:

| Endpoint | Input / output |
| --- | --- |
| `/api/conversation/session` | A `read-review` request attaches an ephemeral tab; returns `{sessionId,review,path}` with the durable `/r/` link. |
| `/api/conversation/asset` | `{reviewId,entryKey,pageKey,type,base64}` stages a bounded PNG/JPEG/GIF/WebP; returns `{id,preview_src}`. End and outstanding-target guards apply. |
| `/api/conversation/capture` | `{reviewId,entryKey,pageKey,submissionId,sessionId,renderId,generation,expectedSourceHash,semantic,semanticCapturedAt?,view?}`. `submissionId:null` records a pre-Send observation and returns `{revisionId}`; a handled changes-reported submission returns its `comparisonReferenceSchema`. Reuses the existing bounded semantic/view normalization and served-frame/source checks; it is an observation, not reviewer content or an acknowledgement. |
| `/api/conversation/comparison` | `{reviewId,entryKey,submissionId,pageKey,mode:"source"\|"content"}` returns the existing `RevisionComparison` representation, including explicit unavailability. |

Capture observations do not advance reviewer versions. Send uses a rendered
baseline only when its owning frame is still current and its known source matches.
Otherwise it captures source alone (or explicitly has no baseline for a URL).
Completion captures source independently of the result transaction; a failed
capture cannot erase an accepted result. Source-only comparisons are partial.
A later current-frame capture can add rendered content, including after End.
The first source endpoint and its timestamp remain unchanged; mismatched source
or known rendered views are rejected. A rendered endpoint, once committed, is
immutable. Source and DOM snapshots describe observations, not a proof that the
agent caused every difference.

**Direct save evidence:** `record-edit` preserves exact HTML/text/move/delete,
asset and truncation fields. `save-edit` must name that edit/version and the
current source hash; it never trusts a client saved flag. The server proves the
full HTML transition using uniquely matching recorded blocks. A cumulative save
may include multiple already-recorded changes; every source delta must be
accounted for. Later saves refresh evidence only for exact included edits, never
absent records. Updating the same unsent edit proves its next transition from
the previous saved content while retaining the original before-content.
Ambiguous blocks, incomplete edits, unknown changes and stale source are rejected
without truncating instructions. Markdown, scripted HTML and URL edits stay
source-pending. A direct save that would introduce executable content is also
rejected before writing, rather than creating evidence that immediately fails
the writable-source contract. Source guards use the existing SHA-1 identity; immutable revision
content addressing remains SHA-256. Staged assets copied into writable HTML use
unique `assets/<id>` paths; the original staged references remain retained.

Revert requires the review's own latest write ownership and matching source hash.
Ownership changes establish a baseline from current source, not another review's
older file. Revert retains exact unsent records as source-pending; it never reports
that their now-reverted content is saved. Outstanding entry/page targets block
record/save/revert as well as Send, across ended predecessors and note-only work.
Abandonment is an explicit confirmed terminal transition, not cancellation,
successful handling, or rollback; it releases exclusion but rejects late completion.

**Filesystem boundary and recovery:** source/asset writes precede JSON evidence
publication and cannot form one filesystem transaction with it. A failure between
them can leave changed source with no accepted save receipt or evidence. Do not
repeat file edits automatically. Inspect the original request's receipt, current
source, pending exact edit, and the review-local baseline revision. Reconcile the
bytes deliberately (the failure test restores the known original before retrying
the identical request), or keep the edit source-pending for explicit handling.
Source-hash guards reject blind retries. This is not filesystem exactly-once,
a multi-agent lease, or protection against different URLs with unknown shared source.

New revisions/blobs use `conversation-history`; staged assets use
`conversation-pasted`. Startup and garbage collection never inspect or sweep the
obsolete `state.json`, `history`, or `pasted` ownership namespaces. Corrupt,
unreadable and unsupported new state fails startup explicitly. Referenced reviews,
messages, submissions, receipts, assets and revisions are not expired by age or
round count. Unreferenced revision debris has the existing GC grace period;
staged conversation assets are retained conservatively. Protocol 23 prevents
reuse of an incompatible live server, without stealing locks or stopping it.
Old `/s/` links and authenticated legacy session, batch, acknowledgement and
reviewer-write routes return `410 WORKFLOW_REMOVED` with reopen guidance.
Shared render, navigation and execution-control routes remain attachment-scoped,
not alternate submission routes. No legacy browser runtime branch is shipped.

### Response-based agent loop

The packaged CLI speaks only the durable conversation protocol. Open posts the
strict `openReviewRequestSchema`, then attaches `/api/conversation/session`.
All other agent commands require `--review <reviewId> --entry <entryKey>`, never
the latest review resolved by a path. The response file must match those IDs.
Generated CLI and shell handoffs share `agent-handoff.js`; `contracts/agent.ts`
adds strict **output envelopes only**, without changing accepted mutation,
submission, paging, intent, or receipt semantics.

| Command | Machine output |
| --- | --- |
| `<target> [--request-id <id>] [--no-browser]` | `agentOpenSchema`: `{ok:true,receipt,review,url,handoff}`. If durable open succeeds but session attachment fails, exit 1 with `{state:"accepted",value:{ok:true,receipt}}`, not a claim that open was rejected. Retry the original open request ID. |
| `poll --review <id> --entry <key> [--timeout <secs>]` | `agentPollSchema`: `work` with review/submission/canonical pages/handoff, `ended` with review/handoff, or `timeout` with exact reference/handoff. Default 43,200 seconds, including discovery and reconnect. |
| `context --review <id> --entry <key> --thread <id> [--limit <1-100>] [--cursor <token>]` | Existing `contextPageSchema`, additionally checked against requested scope, ordering, limit, and high-water cursor. Latest window is chronological; next cursor loads earlier exchanges. |
| `respond --review <id> --entry <key> --response-file <file> [--timeout <secs>]` | Existing `acceptedMutationSchema`, after strict response shape and producer coverage validation. The file contains the stable request ID and delivered expectedVersion. |
| `receipt --review <id> --entry <key> --request-id <id>` | Existing `receiptLookupSchema`. A miss never proves a request was rejected. |
| `status --review <id> --entry <key>` | `agentStatusSchema`: `{source:"server"\|"disk",status,latestSubmission}`. Latest history supplies handled/abandoned evidence without an unbounded response. |

All commands except poll default to a 60-second transport deadline and accept
`--timeout`. This is a caller waiting budget, not a service SLA. Successful JSON
and typed errors await stdout's write callback. Exit 1 returns the shared
`failureSchema`; exit 2 returns the shared unknown transport outcome with the
original request ID. A response file is read and validated once, then copied for
the retry loop. It is not reread mid-flight. Lost/invalid response bytes and
retryable persistence failures repeat that exact logical request; semantic
rejections (including abandonment) never generate a new completion. The CLI
does not execute source edits. Receipt replay cannot make arbitrary agent
filesystem work exactly-once; one cooperating handler remains the assumption.

`POST /api/conversation/status` takes the existing `status` request and returns
the new status envelope from one synchronous store snapshot. Offline status
parses and validates `conversation-state.json` and uses the same read-only
conversation projection. It does not construct `Store`, prune assets, persist,
start a server, or consult old page/batch state as fallback. Missing, corrupt,
unreadable, or unsupported state is reported explicitly. `source:"disk"` describes
persisted evidence, not live agent availability.

The source skill is also the source of generated project setup guidance; global
setup uses the same template. To refresh distributed copies after installing an
updated package, explicitly run that package's project `setup` and/or
`setup --global`, then reload skills. Repository implementation never updates
user-global instructions automatically. Frozen obsolete strings in
`setup-guidance.js` are **recognition fingerprints only**, not instructions
distributed by the current package.

The CLI rejects target-only polling and acknowledgement completion instead of
falling back. Preview, README media, browser fixtures and installed-package
tests use the same durable boundaries. Internal reusable state/capture helpers
do not expose a second workflow or read/import obsolete `state.json`.

### Feedback conversation consumer

`conversation-controller.ts` is the single in-memory owner for Feedback, Focus and adjacent hosting:
drafts, caret/selection/composition, loaded context, filters, independent expansion,
attention, selected pending messages/edits, overall note and guarded confirmations.
It pages the complete authorized membership and pending inventory, rather than
inferring Send from visited tabs or the latest message alone. Reviewer/reply pairs
remain associated; older inline replies are never copied into the result note.
No draft storage, reattachment workflow, or cross-tab draft sync is added.

`conversation-shell.ts` bridges the accepted conversation APIs to the existing
frame and save controllers. Server-rendered body metadata supplies durable identity;
bootstrap checks it. Invalidation rereads authoritative snapshots. SSE failure
reattaches the same `/r/` identity, replaces ephemeral session/token/render state,
and keeps in-memory conversation state. End does not dispose this observer.
Queued/received evidence never becomes an "Agent working" claim.

Mutations are serialized and use strict runtime schemas, scoped random request IDs,
review/submission versions and checked receipts. Unknown acceptance retains the
original logical body and completion callback. Receipt misses remain unknown;
retries repost only that body. A successful receipt is independent of a subsequent
read or capture failure. Local source recovery explicitly distinguishes receipt
acceptance, retained pending records, and current source bytes.

The save controller's optional `conversation` IO port records exact edits before
saving HTML and does not blindly retry failed source writes. The shell removes
only the SDK serializer's trailing file terminator outside `</html>` (otherwise
HTML parsing invents an unrecorded body text node). Staged image preview URLs are
normalized to their registered relative references, not trusted caller paths.
Later saves translate retained same-review/page assets too; full-transition proof
still rejects any unexplained delta. Oversized captures retain truncation metadata
and stay source-pending. Explicit source reload discards only local source queues,
not durable pending records or conversation drafts.

Draft Save has a synchronous per-draft lock, retained across uncertain acceptance;
only the original request is reconciled. Editable text/selection can advance while
that request is in flight. History refresh rebuilds a continuous high-water window
through the oldest loaded item, refreshing older summaries and bridging missed
pages without duplicates. Load earlier extends that window without resetting
reading positions.
SSE open and browser online events both request authoritative refreshes, including
when an existing event stream survives a period of failed offline reads.

An accepted HTML save returns a source hash to the save controller only after
fresh exact-version edit evidence agrees with a fresh page/source read. A failed
verification is explicitly accepted-but-unverified, not a new mutation or a
successful baseline update. Recovery reads/reloads source without retrying the
write; the source/JSON filesystem boundary is unchanged. Only the global status
owns the lifecycle headline; Feedback/Focus show submission-specific details.

Narrow supporting additions, with no changes to the accepted conversation JSON
schemas: authenticated `POST /api/session/<id>/resolve-target` accepts only `{href}`
and returns `{target}` using the existing local-navigation resolver, without
joining/mutating a review. The owner then uses versioned `join-page` and `goto`.
The durable shell uses strict `eh:threadAnchors`, `eh:threadAnchorStates` and
`eh:threadAction` messages, never the temporary legacy activation bridge.
`eh:submittedEdits` carries only block labels through the
existing capability/generation channel; it releases submitted SDK edit baselines
so later human edits become deliberate new records without a reply-only reload.
SDK deletions retain the exact outer HTML. Moves capture the block's current
content, not an older text-edit baseline; the drag preview uses an animation
rather than modifying authored inline styles. These are source-evidence fixes,
not changes to target matching or adjacent conversation placement.
### Highlight conversation host

`conversation-anchor-controller.ts` owns only the shell's current projection and
verified geometry, not conversations or drafts. It validates exact frame scope,
membership and action direction; replaced/unavailable frames invalidate geometry.
Unchanged targets retain verified states when another thread joins the projection.
The existing frame controller additionally checks actual message source/origin.
A reply-only refresh does not reproject unchanged anchors or reload source.

The owner's `host` is `feedback`, `focus` or `adjacent`. `ConversationApp` keeps
the same keyed cards and textareas mounted; host transfer changes styles and
visibility, not portals or editor instances. Per-thread message/offset reading
anchors preserve loaded history through width changes. Save locks, intent,
composition and selection remain owner-managed. Explicit activation opens one
host; restored targets/new replies never open or expand it automatically.

`placeConversationSurface` measures every target rectangle against the frame and
visual viewport, allows only a clear side placement outside the authored frame
(so neighboring unselected text cannot be covered), and rejects narrow, short
or unavailable targets. Pending viewport measurements stay in the reserved pane
until the SDK reports current dimensions. Desktop hosts reserve the same gutter
to avoid transfer-driven source reflow; narrow Feedback is a separate view.
Fallback retains the conversation and exposes target-specific explanations,
including Jump to for offscreen content. Neither fallback nor Close
changes thread status or anchors. Returning the active thread to Feedback reveals
its Open/Resolved filter if necessary, rather than hiding an active draft.
Panel bounds and short-layout styles follow the visual viewport, including a
keyboard resize that does not resize the layout viewport.
The protocol incompatibility marker is 24. Implementation and fixtures do not
modify an existing live server/store or installed global skill.

Anchor projections, geometry reports and thread actions require a positive safe
integer `projectionRevision`. This is internal shell/SDK correlation, not the
frame generation, a persisted conversation version, or a public API field.
The shell allocates it when the render scope or exact target set changes;
reordering an unchanged set does not advance it. Its counter survives geometry
reset for the lifetime of the shell controller. The SDK echoes the revision in
reports and actions. Identical same-revision projections can be acknowledged
again; changed targets cannot reuse a revision or roll the SDK backwards.

The shell parses the entire report/action and checks the full frame/render scope
before ignoring a retired revision. A retired message cannot update geometry,
consume a pending jump, change placement or activate/dismiss a conversation.
Current-revision membership remains exact; malformed input, future revisions,
foreign scope and unknown current members are errors. Direct contract validators
also reject stale revisions: retirement handling belongs to the shell boundary,
not a more permissive membership validator.

This incompatible shell/SDK contract advances the existing `SERVER_PROTOCOL`
marker from 23 to 24, as required by `paths.js`. Discovery checks both the health
response and server record and refuses an older live server without changing
its writer lock or queued feedback. There is no storage migration or durable
schema bump. Revisionless messages are invalid, not implicitly revision one.
Do not mix an old loaded shell with a new SDK or reuse an old live server.
Before a manual upgrade/restart, preserve any memory-only drafts and follow the
CLI's explicit server restart guidance; reload the shell and frame together.
An already loaded mixed-version tab must reload after its drafts are preserved;
Refresh review cannot upgrade its loaded JavaScript. No automatic source reload,
server termination, or live-state modification is performed.

Focused evidence: `test/conversation-controller.test.js`,
`test/ui/conversation.test.tsx`, `e2e/conversation.spec.js`, plus the retained-preview
producer regression in `test/conversation-server.test.js`. Fixtures isolate
`DOC_REVIEW_STATE_DIR`; restart testing replaces only that fixture's server.

The real-producer growth diagnostic in `test/conversation-server.test.js` creates
threads plus completed submissions and source snapshots, then measures whole-store
write/reload and default 50-thread paging. One Windows run (milliseconds; diagnostic
only, not an SLA) measured:

| Threads / submissions / revisions | JSON bytes | Write | Reload + validation | Page | Page payload bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 50 / 5 / 11 | 166,965 | 15.67 | 9.83 | 2.55 | 54,164 |
| 150 / 15 / 31 | 497,274 | 9.74 | 23.21 | 3.50 | 54,650 |
| 300 / 30 / 61 | 992,994 | 19.76 | 39.16 | 7.30 | 54,650 |

Store costs grow with retained data; page payload size remains bounded by the
requested record count (individual text bodies still have the request byte bound).
No automatic expiration, database change, or total submission item cap is implied.

## Code map

| Area | Ownership |
| --- | --- |
| [`cli.js`](../src/cli.js), [`setup.js`](../src/setup.js) | Commands and agent skill installation |
| [`server.js`](../src/server.js) | Local sessions, APIs, and explicit browser module routes |
| [`contracts`](../src/contracts) | Shared page, frame, feedback, and history shapes |
| [`chrome-api.ts`](../src/chrome-api.ts) | Authenticated requests, response guards, and HTTP errors |
| [`frame-controller.ts`](../src/frame-controller.ts), [`frame-host.ts`](../src/frame-host.ts) | Frame identity, readiness, configuration, reloads, and iframe DOM operations |
| [`save-controller.ts`](../src/save-controller.ts) | Edit queues, save barriers, conflicts, and revert |
| [`conversation-store.js`](../src/conversation-store.js), [`conversation-server.js`](../src/conversation-server.js), [`conversation-save.js`](../src/conversation-save.js) | Atomic durable mutations, receipts, scope/exclusion guards and exact source-save evidence |
| [`conversation-controller.ts`](../src/conversation-controller.ts) | One draft/context/history/selection owner, serialized mutations and unknown-acceptance reconciliation |
| [`conversation-shell.ts`](../src/conversation-shell.ts) | Frame lifecycle, navigation, events/reconnect, source save/capture and comparison request ownership |
| [`ui/components/conversation.tsx`](../src/ui/components/conversation.tsx) | One mounted Feedback/Focus/adjacent tree, toolbar, guarded dialogs and independent scrolling |
| [`conversation-anchor-controller.ts`](../src/conversation-anchor-controller.ts), [`thread-anchor-controller.ts`](../src/thread-anchor-controller.ts) | Exact frame projection/membership and SDK anchor reconciliation |
| [`history-server.js`](../src/history-server.js), [`revision-store.js`](../src/revision-store.js) | Retained immutable snapshots, capture validation and Source/Content comparisons |
| [`ui/components/conversation-comparison.tsx`](../src/ui/components/conversation-comparison.tsx) | Submission/page/format selection, independent availability, error/retry and stable comparison reading state |
| [`ui/components/comparison.tsx`](../src/ui/components/comparison.tsx), [`ui/comparison`](../src/ui/comparison) | Inert React Content/Source rendering, bounded context expansion, saved formatting and stable comparison row identity |
| [`sdk.js`](../src/sdk.js), [`markdown.js`](../src/markdown.js) | Document editing integration and Markdown rendering |
| [`SKILL.md`](../src/SKILL.md) | Instructions installed for coding agents |

Keep lifecycle state with its owning controller rather than duplicating it in
the renderer. Controllers expose commands, subscriptions, and disposal. Reuse
existing capture/comparison helpers. Types do not replace runtime checks
at HTTP, frame, or persisted data boundaries.

Frame configuration confirmation and the visual replacement handoff are
separate milestones. A matching settings acknowledgement cancels its deadline
immediately; the two-paint handoff may remain pending while a background tab
pauses animation frames. Deferred paint callbacks must match the current
render, configuration attempt, and latest acknowledged theme. Missing or mismatched acknowledgements still
fail safely. Lifecycle regressions pause shell painting while leaving messages
and timers running, then verify source updates and interaction after resuming.

## Package validation

Packages contain `lib`, README, LICENSE, and package metadata. `prepack` rebuilds
before packing. The smoke helper installs a tarball with production dependencies
only and lifecycle scripts disabled, checks CLI help/version and isolated setup,
starts the installed server, verifies the actual self-contained UI bundle and
CSS, and traverses SDK module imports. It also checks opaque-origin SDK CORS,
asset headers, notices, and the absence of UI tooling in the installation.
The browser variant checks SDK readiness without external CDN or development
servers. `package-conversation-smoke.js` runs two-tab open/join, discussion with
unchanged source, exact text/format/move/delete/image edits, mixed permissions,
identity-bound CLI context/respond, invalid-response rejection, lost Send/End/
response reconciliation, Resolve/Reopen, shared End with late completion,
restart/read-only links and fresh reviews. It also covers true-source Markdown/
scripted/URL changes, known-page overlap and direct-write exclusion, both
abandonment/completion orders, unavailable capture, ambiguous/missing targets
and single-editor host transfer. Successful responses and comparison availability
are independent. Adoption checks preserve obsolete files, reject corrupt/newer
stores and refuse incompatible live servers without changing their locks.

Source and JSON are separate filesystem writes, not one transaction. A direct
save can be accepted while a follow-up read is unavailable; no stale source hash
is then published. Rendered capture still requires the actual current source
hash. An original served frame may follow a save only when the durable latest
write belongs to this exact review and matches that current hash. Another
review's evidence, stale expected hashes and external changes cannot authorize it.

Scratch projects, home directories, and review state are isolated beneath the
checkout and removed after success. Failed fixtures remain for diagnosis.
They do not change global skills or review state. Set
`DOC_REVIEW_SMOKE_ARTIFACTS` to an existing scratch directory to retain the
tarball, server log, adoption/lifecycle JSON and browser screenshots there.
The exact commands `npm run test:all` and `npm run test:package:browser` create
fresh isolated fixtures themselves; no live-server reset or manual setup is needed.

To check an existing candidate without repacking:

```sh
npm run test:package:browser -- path/to/candidate.tgz
```

Local smoke archives are **not publishable release candidates**. Only the
immutable artifact from CI preparation may be published. Follow
[RELEASING.md](../RELEASING.md) for that process.

## Registry troubleshooting

The manifest and lockfile pin the selected direct dependency versions. The
lockfile retains versions and integrity hashes but omits resolved registry
URLs, so a local mirror does not become a CI requirement. Preserve that format
when updating dependencies:

```sh
npm install --omit-lockfile-registry-resolved
```

`npm ci` uses the configured registry and verifies the locked hashes. npm 12
rejects remote tarballs from another hostname by default. If an approved mirror
serves packages through another trusted hostname, use an explicit command scoped
exception rather than changing machine wide configuration:

```sh
npm ci --allow-remote=all
npm --allow-remote=all run test:package:browser
```

Public npm's same host tarballs need no exception. Verify the destination before
allowing remote tarballs. Do not disable TLS to work around registry failures.
