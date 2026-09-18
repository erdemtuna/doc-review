# UI design foundations

The new UI is being introduced through explicit visual review checkpoints.
Each production shell surface stays intact until its corresponding checkpoint.
The G1 gallery is a developer-only fixture, not a new product screen.

## Preview

Run `npm run preview:ui` and open the printed localhost URL. The command builds
the gallery to `.ui-preview` and serves that fixed output with a small local
Node server. No CDN, downloaded fonts, runtime Vite server, or production API
is involved. Stop the preview before rebuilding it so a manual review remains
stable. An optional `--port=12345` selects a port.

The preview source is in `src/ui/preview`. It is not part of the production
entry or the published package. Its buttons and confirmation dialogs act only
on sample state.

## Component ownership

`components.json` selects the Radix-backed `radix-nova` shadcn family and
CSS-variable theming. Generated component source lives in
`src/ui/components/ui`; we own and maintain it. Use the pinned shadcn CLI to
preview changes before regenerating components. Do not run a new-project
scaffold over this repository.

Keep the root TypeScript `@/*` alias aligned with `components.json` for CLI
discovery. Review generated imports: use our local `cn` helper and `Icon`
adapter rather than adding replacement runtime packages. Preserve the scoped
portal classes, Radix state variants, focus styling and reduced-motion behavior.
The adapted components retain their MIT license alongside their source; the
build includes it and the icon license in the packaged third-party notices.

Radix handles interaction behavior, Tailwind supplies utilities, and semantic
tokens define appearance. Not every control needs a primitive: the styled
native select remains available in the component gallery. Changes selections
use styled radio menus to match View/Edit. Icons reuse the
existing Lucide allowlist through a typed SVG adapter, without HTML injection
or a second icon library.

Review/Changes and Content/Source share `SegmentedControl` and
`SegmentedControlItem`: the same inset border, selected treatment and button
size, while keeping separate labelled groups and their existing commands.

## Tokens and styling

`src/ui/styles/tokens.css` is the canonical light/dark token map:

| Family | Purpose |
| --- | --- |
| background, card, popover | Canvas, surface and floating layers |
| foreground and paired foregrounds | Readable content on each surface |
| primary, secondary, muted, accent | Action hierarchy and supporting states |
| destructive | Failed operations and destructive actions |
| border, input, ring | Separators, controls and visible keyboard focus |
| review-added/removed/modified | Dedicated historical comparison semantics |
| review-insert/delete | Inline comparison emphasis |
| review-count-added/modified/removed | Emerald/blue/rose count and legend icons; separate from comparison highlights |
| review-control-height, radius, spacing, type | Shared compact density |
| review-layer-*, review-duration | Predictable layers and reduced motion |

Keep `doc-review:theme` and `data-theme="light|dark"` as the theme contract.
Light is the default unless the stored preference is exactly `dark`.
The token values and control baseline are scoped to `review-ui`, including
portalled controls. This prevents names such as `--card` from changing the
legacy shell during staged coexistence. The isolated preview marks its root
with `review-ui`; the production shell must opt in surface by surface.

Keep `--radius-md` on that same scope as an alias of `--radius`. The adapted
shadcn compact controls reference it directly in arbitrary utilities; a
root-level alias cannot resolve the surface-scoped token and leaves square
corners. The Changes toolbar uses 12px horizontal padding to keep its controls
inset from the comparison edge.

The UI stylesheet deliberately imports Tailwind theme/utilities without global
Preflight. Its baseline is scoped to `.review-ui`; historical typography will
be explicit rather than relying on browser defaults. Do not inject shell
styles or tokens into the authored-document iframe.

Use semantic utilities rather than hard-coded palette classes. Geometry from
the reviewed frame remains measured, typed CSS variables/styles rather than
constructed Tailwind class names. Keep meaningful text/symbol labels alongside
comparison colors.

## Feedback panel

The toolbar entry and panel title are **Feedback**. Its count matches Send:
saved comments and edits on the current page plus feedback on other pages.
The overall note and unsaved comment drafts are excluded. Counts above 99 use
`99+` visually, with the exact count available in the tooltip and accessible
description. Existing control IDs and stable portal hosts are retained.

`DisclosureSection` composes the existing Button, Badge, and Icon vocabulary
with heading semantics, `aria-expanded`, `aria-controls`, and mounted hidden
content. Comments and Edits have independent controller-owned open states,
initially expanded. Preferences survive panel/page/view/theme changes within
the tab and reset when the controllers are recreated on reload.
The existing edit-list show-more state is separate from disclosure state.

Comments automatically reveals an owned edit or deletion confirmation and
blocks collapse until that interaction is saved, cancelled, or completed.
The trigger explains the lock accessibly. Explicit comment activation in an
open panel reveals Comments before focus restoration; background publications
do not undo a user's collapsed preference. Hidden content does not receive
tab focus. Draft and caret ownership remain in the existing controllers.
Other pages remains a separate listing because its counts include edits too.
Comments retains its empty guidance; Edits stays hidden without edits or errors.

The footer is note, optional bounded supporting content, then an action row:
quiet End review on the left and primary Send on the right, in matching keyboard
order. Long status labels wrap inside Send rather than overflowing or stacking
the actions. The note and actions remain reachable while long inventory or
handoff content scrolls. Save problems are outside collapsed content; delivery
errors, draft warnings and capture notices retain their original semantics.
Cancel-first End/Revert confirmations and single-flight commands are unchanged.

## Compact Changes toolbar

`ChangesToolbar` occupies the stable `changesNavigationRoot` portal inside the
sticky comparison header. Round and optional Page sit on the left, navigation
is centred on the full toolbar, and Content/Source with icon counts sits on the
right. Equal outer grid columns keep navigation truly centred despite unequal
side groups. Narrow screens stack these groups in the same DOM/keyboard order,
with navigation still centred. There is no separate normal-state Round card.
Normal availability status is screen-reader-only, not visible toolbar text.
`ChangesControls` is only the nonsticky supporting area for loading, partial,
waiting, error and capture/retry
states; a status message is rendered in exactly one location.

Round/Page/Jump use `ChoiceMenu`, built from the existing outline Button and
nonmodal Radix radio-menu primitives. Their 32px height, padding, radius and
interaction treatment match View/Edit; the existing 38px outer segmented group
is centre-aligned alongside them. Round uses a structured short label on its
trigger; full labels and selection checkmarks remain in the menu. Bounded menu
scrolling and typeahead keep every option reachable.

Navigation is Previous, a position dropdown such as **2 of 6**, and Next. The
position dropdown is Jump to; its menu contains the full change descriptions.
One local disclosure owner prevents multiple Changes menus from opening.
Escape/selection return focus without undoing comparison scrolling. If selecting
a page temporarily disables its trigger, focus can return when it becomes ready,
but intervening pointer, keyboard or focus activity cancels that deferred return.

Counts use plus, pencil and minus icons with numbers, including zero. Hover
titles and complete accessible names describe Added/Modified/Removed, and the
Comparison details disclosure includes a visible legend. The statistics are
not buttons and do not add tab stops. All three badges share the neutral card
surface, border and standard foreground for numbers. Only the icons carry
semantic color: deeper emerald/blue/rose in light mode and lighter counterparts
in dark mode. The legend uses the same icon tokens. Historical row and inline
comparison highlight colors are unchanged.

The toolbar and Before/After headings stay sticky.
Explicit change navigation measures that committed header and applies its height
as the selected row's scroll margin, accounting for wrapped toolbar rows.

Available zero-change comparisons retain format and counts. Navigation remains
hidden for fewer than two changes. The header itself stays available even without
a comparison so Round and Page can still be selected; only the representation
controls, headings and detail hide. Responsive layout uses CSS, not
duplicate control trees or viewport-driven remounts. Controllers and the live
document retain their existing ownership.

## G1 manual review

Inspect both themes and narrow/wide layouts. Try Tab navigation, the sample
menu, native selection, a selected/disabled control, invalid input, and the
confirmation's cancel/confirm/focus-return behavior. Edit/select text in the
sample note before toggling theme. Approval is for the component vocabulary;
toolbar, comments and comparison layouts have separate later checkpoints.

## G2 toolbar integration

The toolbar now owns Review/Changes, the nonmodal View/Edit menu, the Feedback
entry and theme switching through one React root. The theme button moves from
the drawer header to the toolbar and remains available in Changes. Counts above
99 display as `99+`, with the exact count in the badge title. At narrow widths,
the mode and existing recovery menu occupy a second row.

`toolbar-controller.ts` publishes small immutable snapshots; existing runtime
controllers still own mode configuration, saves, frame identity and drafts.
Commands recheck availability, including review shutdown. React never owns or
moves the iframe. At this stage, comments, feedback and comparison renderers remained legacy-owned
until their separate review gates; recovery controls are covered by G3 below.
Do not restore imperative event handlers or DOM writes for React-owned controls.
The mode trigger owns its own toggling even during menu exit animations; an
outside-dismiss handler must not treat that trigger as a second close action.
Its retained DOM IDs also explicitly connect the menu and trigger ARIA attributes.

## G3 recovery and status integration

More now uses a nonmodal Radix menu with shared tokens and explicit trigger/menu
ARIA references. It preserves the currently displayed frame's execution policy,
even when the source has changed. Keyboard dismissal returns focus; an iframe
interaction cancels focus restoration, including messages arriving after native
dismissal while the menu is animating out. Repeated trigger clicks must not
immediately dismiss a reopened menu.

`recovery-controller.ts` owns recovery requests and immutable snapshots. Commands
coalesce duplicate requests, reject malformed responses, and ignore stale frame
identities. Server events still own draft-safe frame replacement. Recovery is
not permission to overwrite scripted source or silently discard pending drafts.

Notices use the existing React root through the stable `noticesRoot` portal.
The permanent `document-host` wrapper is present in initial HTML, never added
around a loaded iframe. Notices occupy bounded space above this host instead of
covering the first lines. Their semantic notice layer retains priority over the
legacy drawer backdrop. Loading, held source updates, failed loads, and recovery
request errors preserve existing actions and warning copy.

For manual review, run `npm run preview:recovery`. Its separately built
`.recovery-preview` output leaves the G1 gallery unchanged and offers simulated
ready/loading/update/conflict/failure states using the production components.
Sample messages and mock actions are labelled as fixtures, not production behavior.
Run `npm run preview:shell -- --recovery` for real draft-safe reloads in an isolated
shell snapshot. Inspect More, Escape/outside focus, both themes, wrapping at narrow
widths, and comment-draft preservation. This gate does not approve or redesign
the comments drawer, composer, feedback controls, or Changes rendering.

## G4 comments inventory integration

The drawer header, comment inventory and other-page summaries now share the
React root through stable portal hosts. The outer drawer remains a stable
layout host for edits and feedback controls (migrated in G6 below); React controls
its visibility without rebuilding those fields. The existing desktop rail,
720px full-width breakpoint and nonmodal behavior are retained. Closed drawers
are inert, but opening a drawer never makes the document or toolbar inert.

`chrome-session.ts` is the typed, shared owner of comment confirmation
and edit state for the inventory and aligned card (migrated in G5 below).
`comments-controller.ts` publishes immutable presentation and guards commands.
Draft text, selection, composition and pending requests are not component-local
state. The existing mutation flights, page-epoch checks, acknowledgement
reconciliation and correction-ID migration remain authoritative.

Cards keep stable keys across unrelated updates. Following G5 review feedback,
drawer and aligned cards expose 32px icon buttons with accessible names and
native title tooltips instead of a comment More menu. Both expose Edit and
Delete; drawer cards also expose Jump to, and aligned cards expose Close.
Delete opens the existing inline textual Cancel/Delete confirmation without
sending a request. Header actions are hidden while that card owns editing or
confirmation; other card actions are disabled during a pending deletion.
Escape cancels an idle confirmation and restores focus to its Delete icon.
Successful drawer saves return focus to Edit; deletion focuses the next card's
Delete icon or the empty inventory. Toolbar More remains a nonmodal Radix menu.

Run `npm run preview:shell -- --comments` for populated and empty G4 reviews
with disposable data. The populated fixture includes a long list, long text and
another reviewed page. Contextual commenting, edits and feedback controls are
not redesigned by this gate.

## G5 contextual commenting integration

The selection composer and aligned saved-comment card now use the same React
root through permanent, nonmodal portal hosts. `contextual-controller.ts` owns
the typed session draft (text, caret, composition, error and retry state); React
does not maintain a second authoritative draft. The aligned card reuses the
inventory's controls and single comment edit/confirmation owner, including
surface migration, correction IDs and single-flight mutations.

Only the outer hosts' visibility, pass-through class and measured position
remain in the shell adapter. ResizeObserver and one cancellable animation-frame
job coalesce geometry, viewport, notice and content-size updates. Existing SDK
render/target correlation and positioning helpers remain authoritative; React
never reparents the authored iframe. Composer keyboard/IME and card actions
have one owner rather than parallel legacy handlers. Source reload retains the
draft as an unresolved excerpt; late submit responses cannot clear a different
draft or replace a newly loaded page.

Composer keyboard hints explicitly retain two spacing units above them after
the scoped paragraph reset, leaving clearance outside the textarea focus ring.

Run `npm run preview:shell -- --contextual` for a labelled, isolated real G5
runtime snapshot with selectable paragraphs, controls, long/nested scrollers
and saved comments. Existing preview snapshots remain unchanged. Inspect both
themes at 320/390/768/1440 pixels, reveal/scroll, keyboard and draft preservation.
Edits, feedback and application confirmation dialogs are covered by G6 below.

## G6 feedback, edits and confirmations

The permanent `editsRoot` and `sendSection` hosts now receive React portals from
the same root. `feedback-panel-controller.ts` owns the overall note's text,
selection and IME state, edit expansion, clipboard status and asynchronous
confirmation state. The textarea stays mounted when the drawer closes or
Changes opens. No authoritative note value is read from the DOM.

Shared Button, Textarea, Label and Badge components present edits, save failures
and conflicts, note-only feedback, delivery progress, success, errors and agent
handoff. Inventory and supporting handoff/capture messages scroll separately;
the compact note and primary Send stay visible on short screens. Tokens remain
scoped to the shell, never the authored frame.

Delivery still belongs to `feedback-controller.ts`: it snapshots the note,
waits for saves, avoids duplicate flights, and clears only the exact sent note.
Optional capture failure remains nonblocking and appears as a supporting post-send notice.
The old capture-override HTML was dormant, with no controller recovery commands;
G6 does not introduce those commands or a new send gate. Ambiguous delivery is
not automatically retried; committed feedback cannot become an error-shaped retry
because history refresh failed.

End and Revert use the existing adapted Radix AlertDialog primitive. Cancel is
the safe initial focus; Escape cancels only this dialog, never a comment draft
or drawer. Trigger focus returns after cancellation. Confirm revalidates the
page/render/source and action state, flushes queued SDK edits, checks identity
again, and allows one pending action. Failed requests remain explicit and
retryable; stale actions require cancel/review. End distinguishes persisted
unsent items from tab-only drafts. Native browser beforeunload remains native.

Run `npm run preview:shell -- --feedback` for a disposable G6 candidate with
seven sample edits and real send/revert/end operations. Inspect 320/390/768/1440
widths, both themes, keyboard focus, note/caret preservation, narrow handoff
wrapping and confirmation cancellation before confirming on disposable data.
Browser tests inject server and optional capture failures without production debug
switches. This checkpoint does not redesign Changes controls or comparisons.

## G7 Changes controls and diagnostics

`changes-controller.ts` projects typed, cached control snapshots from the
existing history owner. Round/page/format selections, navigation, capture and
finalization are guarded commands. Normalization is committed during history
refresh rather than mutating authoritative state during rendering.

Permanent control, navigation and diagnostic hosts receive React portals.
NativeSelect preserves familiar keyboard selection; Button, Badge and semantic
tokens make counts, status, partial coverage and error/retry states consistent
with the rest of the shell. Escape on these controls does not cancel a hidden
comment or note draft. Disclosures preserve their open state across updates.

## G8 and G9 React comparison rendering

Content and Source use `ComparisonPortal`, backed by typed projections and
allowlisted React block/run components. The imperative comparison renderer
and its server route are removed. The history coordinator still owns
round/page/format and selected-change state; React owns its rendered detail
and bounded unchanged-context disclosure.

Stable keys preserve text nodes, selections and expanded context when the
selected change or freshness changes. Explicit navigation scrolls the selected
row after React commits. Changing the saved endpoints, round, page or format
resets the relevant expansion state rather than carrying it to another document.

Content preserves inline word changes, formatting, structural metadata, saved
positional table rows and list numbering. Images and links are inert references,
not remote fetches or navigable historical controls. Source renders literal
text, line numbers/gaps, long lines and newline/CRLF diagnostics. Neither
representation replays authored HTML, scripts, styles, attributes or URLs.
Existing non-color insertion/deletion cues and dedicated diff tokens remain.

## G10 integrated review

`npm run preview:review` builds a fixed runtime snapshot and seeds real SDK
history into disposable HTML/Markdown examples. The landing page links complete,
partial and empty review states, including pending comments and a real saved
edit. See [the focused manual-review checklist](migration-review.md).

The integrated regressions cover both themes at 320/390/768/1440px, keyboard
ownership, drafts/caret, source policy, frame identity, history selection and
inert comparisons. Installed-package smoke exercises the bundled experience
without React, Vite or other UI tooling installed at runtime.
