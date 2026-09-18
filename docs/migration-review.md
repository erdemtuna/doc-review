# Reviewing the React shell migration

The shell now uses React, TypeScript, Vite, Tailwind and Radix-backed shadcn
components. The authored document and its SDK remain outside React. This review
should check both the refreshed controls and the behavior that must not change.

## Start the prepared example

```sh
npm ci
npm run browser:install
npm run preview:review
```

Open the printed **Migration review guide** URL. Startup uses headless Chromium
to send sample feedback, acknowledge the sample batches, and capture real before
and after versions through the SDK. It then closes that browser and leaves a
read-only guide and three review sessions running.

The pending HTML title edit is seeded through the authenticated edit/save APIs
with a current frame identity and source hash. Its source is genuinely saved,
and its original baseline remains available to Revert.

Everything is copied into a fresh ignored `.shell-preview-*` directory: runtime,
HTML, Markdown, a local image and review state. The original fixtures, repository
documents and personal review state are not edited. There is no listening agent
attached to these examples. The printed links work while this command is running.
Stop it with Ctrl+C to remove its disposable files; restart it for fresh data.
The existing `preview:shell` fixtures remain available for narrower inspection.

For an automated seed-and-cleanup check, run the build followed by
`node scripts/migration-review.js --smoke`.

## What to inspect

| Surface | Prepared example and action | Expected result |
| --- | --- | --- |
| Toolbar and themes | Open HTML; switch Review/Changes, View/Edit and both themes. Type in the page-owned input first. | The same live document and authored input value survive. Menus fit the viewport, dismiss once with Escape, and return focus appropriately. |
| Feedback and composer | Open Feedback; collapse Comments and Edits, then edit a saved comment and try Delete then Cancel. Select new text; open a comment; scroll the nested panel. | Section choices survive panel/page/view changes and reset on reload. Active comment edits keep Comments expanded until Save or Cancel. Other-page feedback stays separate. Direct icon actions have labels/tooltips. Draft, caret and selection survive surface changes. Back to selection reveals the original target. |
| Feedback and edits | HTML starts with one real saved edit and two comments. Add an Overall note; switch views; open Revert all or End review and cancel. | The note stays intact. Cancel receives initial focus; Escape only closes the confirmation. The triggering control regains focus. Confirming Revert affects only the disposable file; confirming End ends only that example session. |
| Send and handoff | Send disposable feedback from HTML or Markdown. | A single batch is sent, the committed note clears, and the no-agent handoff gives a copyable prompt. Optional capture failure must not prevent feedback delivery. Unsent drafts are not silently included or discarded. |
| Changes controls | HTML has two completed rounds. Open Round and Page menus; switch Content/Source. Use Previous/Next and click the position dropdown (such as **2 of 6**) to jump. Hover the count icons and open Comparison details. | Round and optional Page sit left, navigation is centred on the toolbar, and format with icon counts sits right on wide screens. Normal readiness is announced without visible status text; loading and recovery messages remain visible. Menus match View/Edit, show the selected option and close cleanly with Escape or selection. Plus/pencil/minus counts expose Added/Modified/Removed explanations, including a visible legend. Labels, content, navigation and coverage refer to the same selected round/page. Switching view or theme does not replace the document. |
| Content comparison | HTML Round 2 and the Markdown example have both representations. HTML Round 1 includes more structural changes. | Check inline word changes, formatting, table rows/cells, ordered lists, code, image/link references and added/removed blocks. Historical links/images stay inert. Long unchanged context can expand without being collapsed again by change navigation. |
| Source comparison | Inspect both HTML rounds and Markdown. Select notes.md in HTML Round 1. | Literal source stays literal, including code/markup. Check line numbers, gaps, long lines, newline/line-ending diagnostics and word-level additions/removals. |
| Partial and empty states | HTML Round 1 / notes.md intentionally has Source-only coverage. The third example has no comments or rounds. | Missing Content is explained honestly; Source remains usable. Empty Feedback and Changes are helpful, and Send is disabled when nothing is queued. End and Send stay beside each other; long supporting messages scroll without hiding either action. |
| Responsive and keyboard | Repeat at 2000, 1440, 768, 390 and 320 pixels in both themes; also try 320x568 and 768x400. Use Tab, Shift+Tab, Enter and Escape. | Changes toolbar groups wrap in reading order and the selected change remains visible below the sticky header. No clipped controls or unintended horizontal page overflow. Primary Send remains reachable while long inventory/secondary handoff scrolls. Focus is visible. Nonmodal review surfaces do not trap the authored document; confirmation dialogs do. |

## Reading the seeded history

- **HTML Round 1:** changes from an all-at-once launch to a staged rollout. It
  includes feedback on `notes.md`, whose baseline deliberately has no Content
  snapshot. This produces a real, stable Source-only comparison, not a mocked
  loading state.
- **HTML Round 2:** smaller wording, ownership and table-cell changes, with a
  long unchanged middle section for expansion/navigation checks.
- **Markdown Round 1:** a completed feedback-only review with both Content and
  Source. The source remains Markdown when you edit its rendered appearance.
- The pending HTML title edit was made **after** the completed rounds. Reverting
  that edit must not rewrite the historical endpoints.

## Review boundaries

The example exercises normal and partial states, not every transport failure.
Automated regressions cover stale responses, retries, failed saves, pending
confirmation actions, source changes and capture failures. For an optional
manual retry check, use browser request blocking on these disposable sessions;
do not stop unrelated review servers or use a real document.

The migration does not change API/persistence formats, broaden script execution
policy, turn the document iframe into a React component, or introduce a required
capture step before Send. Historical Content remains a readable reconstruction,
not a replay of authored layout, scripts or remote assets.
