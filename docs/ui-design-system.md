# UI design foundations

The production entry is `ConversationApp`. Every review uses the same durable
workflow; the isolated component gallery is not another product entry.

## Ownership and surfaces

`conversation-controller.ts` owns Feedback, Focus, adjacent and new-composition hosting: drafts,
caret/selection/composition, expansion, loaded exchanges/history, reading
positions, pending selection, mutation locks and uncertain acceptance.
`conversation-shell.ts` owns frames, navigation, reconnect, source-save barriers,
capture and comparison requests. React renders these owners rather than creating
parallel state. Drafts are never saved to storage or synced across tabs.

Both Open and Resolved filters start enabled with expanded latest exchanges.
Their shared segmented controls retain selected paint without hover or focus.
Each discussion has one gently rounded bordered card over a subtly different
inventory background, with clear inter-card gaps. Reviewer and agent messages
are unboxed, share author/avatar/time metadata and retain 13px body text.
Cards use 8px padding, with only 4px additional inset in the adjacent panel.
Focused transcripts reserve a 4px horizontal paint gutter for complete textarea
focus outlines without indenting message content or changing editor identity.
Ordinary Discussion and answered states have no pill. A document-and-pencil icon
with a Change requested tooltip and accessible name represents explicit edit
permission; a secondary Pending badge identifies unsent messages. Ended pending
messages retain read-only context in their tooltip and screen-reader text.
Non-default response outcomes remain per-message.
Shared `ConversationSource` shows a one-line excerpt beside the compact action row,
without verbose source-type labels. Full source descriptions remain in tooltips.
Legacy generated location labels use their heading stem without rewriting anchors.
Sidebar, Focus and adjacent discussions use the same source, collapse, navigation
and resolution controls; host styling changes geometry, not message anatomy.
Readable timestamps expose the full date/time through a keyboard-
accessible, hoverable tooltip. The thread's Conversation actions menu holds
eligible Delete thread and host transfers; this is not a
restoration of the removed global More menu. Focus is a named menu action and Edit
is a compact icon control; every card has an icon-only **Show in document** and
**Resolve/Reopen** actions. Collapse/Expand is a separate named icon button.
Reply is a quiet visible action, sharing the last pending message's action row.
Draft permissions use the shared Checkbox primitive. There are no batch-selection
or exclusion controls; Send includes all saved pending messages and edits.
Each exchange associates its original reviewer message with the actual reply.
New messages signal attention without forcing expansion or scrolling. Earlier
pages merge by stable identity; reconnect must not leave an unreachable gap.
Add comment / Add reply / Update comment retain unsent feedback; Send submits all saved pending items across
authorized review pages. Immutable sent corrections are new messages.
Each new message/note defaults to Discussion. The change checkbox appears only
during composition/edit; saved Change requested intent is an icon, not an editable permission.

One mounted thread/editor moves across Feedback, Focus and adjacent geometry.
Editing an unsent message replaces its body inside that exchange, never appending a
duplicate editor after the transcript. No transfer clones a textarea. Collapse and Close preserve drafts and reading
state; neither resolves a thread. One-click Resolve/Reopen is server-guarded
and refuses drafts, pending messages, and accepted work.
Undo is bound to the exact accepted review version and disappears after any newer
review mutation or End; uncertain receipts must reconcile before Undo appears.
The Undo action remains reachable in all hosts. Enter queues the draft, Shift+Enter inserts a newline,
Escape cancels; active IME composition is never intercepted. The overall note
stays multiline and submission-only: Enter must not Send. Comments and Your edits
collapse independently without unmounting their contents. The optional overall
note starts collapsed, shows Draft when nonempty, retains its own permission and
cannot collapse during composition. Collapse/resize preserves its node and caret.

Feedback is a nonmodal flush-right 380px sidebar below the measured toolbar.
With at least 640px left for the document it docks; below 1020px it floats without
resizing the authored iframe. Neither mode replaces the frame or alters source.
The SDK retains a visible text range and restores its vertical position on width
changes without modifying the selection. Ordinary Feedback has no backdrop or
inert stage; modal confirmations retain their separate blocking behavior.
The inventory, including Your edits, scrolls independently from the note and bottom
actions; footer support text has its own overflow area. End stays left and Send
right. The note-only Request a change checkbox uses the shared Radix primitive
and defaults unchecked; it does not grant permission to other messages.
Note to agent has its own disclosure and one accessible label, with no nested accordion.
Its editor remains mounted while collapsed. Routine counts are in the Send button
and its accessible description; unfinished drafts and unknown counts remain explicit.
New comments originate in the document; there is no general New message button.
History has one heading, quiet timestamps and receipt details after the result.
History and Changes share human-readable edit-outcome summaries; conversation
badges and note outcomes share labels such as Change reported and Needs clarification,
rather than exposing wire values such as `already-saved` or `clarification-needed`.
Empty Changes offers Open Feedback as an explicit destination; Back to review
still restores the exact initiating context.
Focus/adjacent has one transcript scroll area with a reachable header
and composer. Status/error overflow must not push actions off-screen.
Synchronous per-draft Save locks prevent double delivery while typing stays
available. A newer draft survives acceptance of an older saved value.
Confirm/Send locks begin before asynchronous barriers. Send also freezes exact
selected versions and the note before its first await; concurrent arrivals stay
pending and revised selections fail explicitly rather than being substituted.
Dialogs initially focus
Cancel and restore focus after the authoritative update, not before it.

Only one global lifecycle headline is shown: Reviewing, Waiting for agent, or
Review ended. Submission-specific queued/received/handled/abandoned evidence
is separate; received is not agent liveness. End retains the read-only observer
for late results. Source conflicts, deferred edits, capture availability and
response success remain independently visible. Unknown acceptance uses the
original request identity and explicit reconciliation.

## Target safety and placement

`conversation-anchor-controller.ts` validates frame identity and exact projected
membership. `thread-anchor-controller.ts` reconciles original metadata in the
SDK. Frames receive IDs/targets, never message bodies, permissions, results or
the API token. Correlated geometry/status is presentation, not source authority.

Explicit highlight activation opens one adjacent conversation. Shared targets
offer a count/chooser. Missing, ambiguous, hidden/not-measurable, loading,
render-changed and failed/unavailable renders have distinct explanations.
Offscreen is not missing: Show in document scrolls only a verified target. A successful jump
retains Feedback when the target can remain visible, or hides a floating panel
that would cover it. Feedback
returns to the retained inventory position and drafts. Cross-page jumps wait for
the source barrier and current scoped projection; unavailable targets retain
their explanation and disabled action. Resolved and ended threads remain navigable.
There is no manual reattachment or automatic anchor mutation.

`placeConversationSurface` and `placeNewMessageSurface` share measured side,
then above/below placement against every visible target rectangle, clipping edge,
toolbar and visual viewport. Local surfaces may cover unselected prose, never
the selected target; there is no document gutter or width-only placement failure.
Thread height comes from its actual header, transcript and controls. Short threads
fit their contents; long transcripts shrink to the available space while reserving
Reply or the editor and its actions. Initial measurement is noninteractive and
hidden until a placement exists. Host transitions wait for matching layout and
fresh frame geometry; observers do not move keyboard focus or reset reading.
Adjacent cards and Feedback never dim or make the authored stage inert. Only
unavailable geometry or insufficient usable target-safe space falls back to
Feedback, with an explanation. Insufficient-space fallback retains the focused
conversation so a long transcript cannot push its active editor below the inventory.
Unavailable targets return to the inventory with their target-specific explanation.
Fallback preserves input and never changes thread status. It does not automatically
jump back to adjacent placement.

New comments extend the former 340px contextual surface with one title, a subdued
target cue, Textarea, and unchecked Request a change / Add comment on one horizontal row.
Each action's tooltip and accessible description explain queuing versus Send and keyboard
shortcuts without a permanent help row. There is no Element badge, duplicate
New message heading, permanent Cancel, or host-transfer action.
New/reply/edit X and Escape use controller-owned cancellation: empty new/reply
drafts (including whitespace) and unchanged edits close immediately; meaningful
text or an existing edit's changed permission requires Keep editing / Discard.
Keep editing restores the same input and caret. IME and active/uncertain saves
block cancellation; Discard cannot retract an accepted mutation. Feedback's outer
X remains hide/preserve. Cancel retires frame target generations and SDK composition
state, preventing late intents from reopening the editor. Heading labels include
the selected heading itself; stored anchors and selectors are never rewritten.
The same mounted `new` draft remains in the inventory while its host changes.
Contextual composition neither makes the authored stage inert nor adds a backdrop.
`placeNewMessageSurface` uses the measured complete composer height and rejects
overlapping placements. Its target is clipped to the authored scroll region, but
the parent popover can extend outside that region without covering the target.
No usable placement keeps the draft in Feedback with its explanation.
On Feedback host entry or a change to the available inventory dimensions, a
clipped new-message textarea is revealed by scrolling that inventory only.
This does not move keyboard focus or recreate the editor. Theme/status renders
and deliberate inventory scrolling do not trigger repositioning; saved-thread
reading positions keep their existing behavior.

The existing `eh:openComment` / `eh:targetGeometry` boundary supplies
`targetGeneration`, anchor and optional presentation geometry. The frame channel
still checks source, capability, page and frame generation before consumption.
No protocol field/version or public/storage schema changes are required.
`readNewMessageTarget` validates the durable target and positive safe generation,
clips usable rectangles to the effective clip, and treats missing geometry as
Feedback-only. Geometry cannot replace the accepted anchor. Retired intents
cannot reopen a saved/cancelled draft; a rejected retarget leaves the original
generation authoritative. Frame replacement removes placement, not draft text.
Existing-thread geometry still uses the separately revisioned projection contract.

## Components and tokens

`components.json` selects Radix-backed `radix-nova` shadcn components.
Owned generated source is in `src/ui/components/ui`. Preview changes with the
pinned CLI rather than running a new-project scaffold over this repository.
Keep the `@/*` alias aligned with `components.json`; use the existing `cn` and
typed SVG `Icon` adapter. Retain scoped portals, focus, Radix state variants and
reduced-motion behavior. Component and icon licenses ship in third-party notices.

Button, Badge, Textarea, ChoiceMenu and SegmentedControl are shared by production
surfaces. Native controls are appropriate where they preserve accessible
behavior. Radio menus have one open owner and Escape returns focus to the
trigger. Do not add a second icon library or HTML-based icon injection.

`src/review-palette.js` owns the light/dark color map. Build-time generation
updates semantic UI tokens, shell aliases and SDK tool colors together.
`src/ui/styles/tokens.css` owns non-color density, typography, layering and
motion. Keep generated outputs synchronized, never manually recolored.

| Token family | Purpose |
| --- | --- |
| background/card/popover, paired foregrounds | Surfaces and readable text |
| primary/secondary/muted/accent | Action hierarchy and supporting states |
| destructive | Failure and destructive action |
| border/input/ring | Decoration, essential input boundaries and keyboard focus |
| review-added/removed/modified | Comparison backgrounds with paired foregrounds |
| review-count-added/modified/removed | Olive/amber/rose count and legend inks |
| review-insert/delete | Inline change emphasis |
| radius/spacing/type/control-height/layer/duration | Consistent density and motion |

Use `--input`, not quieter `--border`, for essential input boundaries. Comparison
backgrounds are not text inks. Labels/symbols accompany color. Teal indicates
actions/focus, not successful saves. `--radius-md` aliases `--radius` on the same
surface scope so compact controls remain rounded.

Tailwind theme/utilities are imported without global Preflight. Baselines and
tokens are scoped to `.review-ui`, including portals. Never inject shell styles
or tokens into authored HTML/body. The SDK themes only review-owned tools,
highlights and selection cues; it does not serialize theme metadata into source.

## Brand, toolbar and theme

`src/assets/doc-review.svg` owns the paper comment-bubble mark: opposing arrow
cutouts on a teal rounded-square tile, 64x64 with 14-unit corner radius.
Its `#17685F` and `#FFFDF7` colors do not invert. `generate-brand.js` validates
and generates the toolbar and outer-shell favicon. Do not replace the reviewed
document's title, favicon or head.

The toolbar reuses the former release (`1e85f842`) presentation through
`ToolbarControls`: the named noninteractive 32px brand and Review/Changes
segmented destination on the left, the lifecycle badge at the true horizontal
toolbar midpoint, and compact Feedback/theme actions followed by the icon-bearing
View/Edit radio menu at the far right. The production More menu and its optional
script-policy entries are removed; contextual error recovery remains. The legacy controller is
not mounted. Multi-page navigation uses one existing ChoiceMenu next to the
destinations; a single-page review does not duplicate its filename. Revert stays
with the Feedback edit actions, not a separate toolbar strip.

At widths up to 760px, toolbar tools move to a second row; below 640px, the
lifecycle badge shares the destinations row without requiring exact midpoint alignment.
Keep established type sizes. Feedback groups its filters and Close control before
the body. Inline reply/edit drafts disclose the independent overall note and
Send details, but retain the same mounted editor, focused/composing note and
bottom actions. Active inline-card controls stick within the inventory; repeated
target explanations follow the draft. Saved-edit headings lose redundant spacing
and the empty-conversation hint is omitted when edits already explain the body.
These rules do not change ordinary desktop or tall-phone presentation.

Responsive tests measure natural text Range rectangles after every ancestor's
overflow clip, before scrolling or refocusing the editor. The full first glyph
line, not a guessed line-height or visible card box, must survive at 390×480
and 320×400. Intentional inventory scrolling remains independent of theme changes.

One shared Badge occupies its own centered grid track and remains
visible in Changes: quiet outlined Reviewing, muted amber Waiting for agent, subdued
Review ended. The status span is intentionally keyboard-focusable, not a button
or action: the installed Radix Tooltip primitive/provider explains its state on
hover or focus, dismisses with Escape, and preserves receipt/source-save details
in the accessible description (and submission details in Feedback). No competing
native title is rendered. Ended outstanding work explicitly remains accepted.
Normal lifecycle
states reserve no extra row. Errors, uncertain receipts, disconnection and
actionable recovery alone create a full-width row beneath the controls; closed
Feedback and Changes retain the complete error/receipt details and recovery actions.
A ResizeObserver measures that header, including wrapped recovery content, and
shares its lower edge with document, Feedback/Focus, adjacent placement and
comparison surfaces. No viewport-specific fixed status offset competes with
buttons. Equal outer grid tracks keep the status at the actual midpoint, not the
center of remaining space. Durable review uses a second row at 760px and below;
at 480px and below the centered badge and right-aligned mode occupy separate rows
to avoid overlapping the longest Waiting label. Legacy toolbars retain 600px. Conversation
placement uses actual target and surface measurements, not that toolbar breakpoint.

Changes retains the last valid submission/page/format selection, otherwise
selects handled history or shows an explicit empty state without issuing a
request with fabricated IDs. Review, Changes, Feedback, theme and page navigation
remain readable after End; writing stays guarded. Mode/theme/destination changes
do not replace the frame or the conversation editor. The Feedback count shows
saved pending messages plus edits across every review page, independently of
unread activity. Its accessible description retains the
exact count even above the compact 99+ display. The footer separately describes
all saved pending messages, edits and an optional overall note; Send counts all
three. The controller derives presentation and Send payload from one selection
helper over complete paginated pending contexts and edits, including versions
at activation. Memory-only message drafts and submitted/handled work are not
selected. Loading, disconnected, failed/incomplete reads and uncertain acceptance
show an unavailable count, never a false zero, and disable Send.

`doc-review:theme` and `data-theme="light|dark"` are the preference contract;
light is default unless the stored value is exactly dark. A revisioned
`eh:setTheme` is acknowledged by `eh:themeApplied`, separately from review-mode
configuration. Missing confirmation exposes Retry theme without replacing the
iframe or losing drafts. A retained old frame has only a theme channel, not an
edit channel. Frame configuration and the two-paint replacement handoff are
separate milestones, including in background tabs.

## Retained comparison presentation

`conversation-comparison.tsx` owns submission/page/Document-or-Source controls,
independent loading/error/unavailable states, retry, counts and change navigation.
`conversation-results.tsx` composes existing inventory, Badge, and timestamp
primitives for a capture-independent submission note and exact human edit evidence.
The latest-result preview precedes thread cards in Feedback. Shared `ResultActions`
and `resultHeading` own the same outcome vocabulary and routes in Feedback and
History: **View replies**, **View changes**, or summary-only **View response**.
Response navigation uses the persisted reviewer/agent association, loads older
context when needed, and preserves resolved/filter state. It never substitutes
the latest message for a requested historical reply.
The result surface has a persistent **Back to review**, retained draft nodes and
local focus restoration. Closing invalidates in-flight comparison reads; failures
cannot strand the reviewer or reopen an obsolete result. Discussion-only results
do not render comparison tools. Summary widths stay readable, while actual diffs
may expand. Lifecycle status is centered in the desktop toolbar, separate from View/Edit.
Waiting has one centered toolbar status rather than repeated queued/sent notices.
Feedback contains no waiting explanation or technical disclosure after Send.
The header's **History** destination holds submission status, notes and results without
CLI commands, raw identifiers, receipt JSON or technical disclosures.
Waiting submissions show status and time without an actions menu or abandonment control;
related-review links remain available for overlapping work.
History and Feedback retain the same mounted reply/note
editors and independent reading positions. Capture errors belong to their exact
result/page; older issues remain discoverable through the History issue count.
Source-save, disconnected and uncertain-acceptance recovery stays visible.
At heights up to 440px,
only this preview puts its body before metadata so the first line remains readable
in the existing short inventory. Its 13px text uses a 20px line box, avoiding a
fractional predecessor height that would round a transferred reading anchor.

Changes fills the region below the approved global toolbar. The full note scrolls
normally above the former comparison toolbar; it is not a sticky banner. Pending
edits reuse the former readable inventory with
explicit source-persistence badges. Complete content, receipts and source identities
remain in secondary details; they are never inferred from a successful capture.

Shell request sequencing prevents a slow response from replacing a newer choice
or reopening a closed surface. Closing hides the retained subtree; identical
data preserves expanded context and row identity. Changing endpoint resets the
relevant comparison selection.
Automatic and manual capture share a flight keyed by existing review/entry,
submission, page, session/render/generation, source hash and observed view identity.
Only a typed version/immutable conflict may trigger same-result Content reconciliation.
No blanket 409 suppression, source-only success or late comparison reopening is allowed.
Before requesting, selection must identify a loaded handled submission, a member
page, and Content or Source. The existing response contract already requires
`available` and the requested `mode`; wrong or missing mode is an explicit error.
No public or protocol fields are added. A previously unavailable loaded snapshot
can be refreshed after capture; explicit recapture cannot reopen a dismissed or
different selection. Capture failure remains visible beside the independent note.

`ComparisonView` renders bounded inert historical content. It reconstructs
supported formatting and image descriptions, not scripts, network images,
iframes or live links. Narrow screens use readable unified attribution.
Sticky tools must leave the selected change visible in short viewports.
Historical comparisons remain accessible after shared End.

Rendered capture is optional evidence, not response acceptance. Reply-only
responses do not reload/capture a fake version. Source and Content have distinct
availability, provenance and timestamps. Reusable comparison/capture helpers
are not a legacy submission API.

## Preview and regression gates

`npm run preview:ui` builds the gallery to `.ui-preview`; the recovery gallery
uses `.recovery-preview`. Both serve fixed, local output without CDN fonts,
Vite runtime or production mutations and are excluded from the package.
Stop a gallery before rebuilding it. `npm run preview:shell` instead serves
the actual production workflow using copied runtime/source and isolated state.

Use Node/controller tests for contract/lifecycle guards, Vitest for component
behavior, and Playwright for real iframe, focus/IME, geometry, theme,
source-save and retained-history boundaries. Test both themes, 320/390px narrow
and keyboard-like short viewports, plus desktop. The full gates are
`npm run test:all` and `npm run test:package:browser`.
See [development](development.md) for ownership and reproducible package evidence.
# Conversation reading redesign

The toolbar is the surface reference for conversation chrome. Feedback inventory
uses the same card surface, not a large muted-color slab. Discussion boundaries
remain visible through borders and spacing; messages inside a discussion stay
unboxed. Target navigation and thread actions share a compact header. Focus is a
named menu action, while Show in document and Resolve/Reopen stay visible. Routine pending/unread state uses
quiet text rather than competing badges. Exceptional outcomes and edit permissions
remain explicit. In-place element highlights use one restrained edge treatment,
with separate keyboard focus indication.
