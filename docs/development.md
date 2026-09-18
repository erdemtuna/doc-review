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
| `npm run build` | Check types, emit Node/SDK ESM, bundle UI, and copy runtime assets |
| `npm run test:unit` | Rebuild and run Node unit and UI component tests |
| `npm run test:ui` | Run focused Vitest/Testing Library component tests in jsdom |
| `npm run preview:ui` | Build and serve the isolated G1 component gallery |
| `npm run preview:recovery` | Build and serve the isolated G3 recovery-state gallery |
| `npm run preview:shell` | Build and serve a disposable shell review on an isolated runtime snapshot |
| `npm run preview:review` | Seed real HTML/Markdown history and serve the integrated migration review guide |
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

Source lives in `src`; the TypeScript compiler emits Node/SDK ESM into `lib`.
Vite separately bundles `src/ui/main.tsx` into deterministic `lib/ui/chrome.js`
and `lib/ui/chrome.css`, still served at `/chrome.js` and `/chrome.css`.
The entry mounts the React toolbar and More menu outside the authored iframe,
with recovery/status notices portalled into a stable host above the document.
The comments inventory, selection composer, aligned card, edits and feedback
footer share that root through stable portals; session controllers own their
drafts and mutations. Changes controls and both comparison representations also
use React; the old imperative comparison renderer and route have been removed.
Legacy styles occupy a lower cascade layer; new tokens and baselines apply only
inside `.review-ui` surfaces and their portals. The G1 gallery stays separate.
React, Tailwind, Radix-backed shadcn controls, and browser-only dependencies are
build-time dependencies; installed packages require no Vite or UI tooling.
Vite emits bundled dependency licenses in `lib/ui/THIRD_PARTY_NOTICES.md`;
the build also appends the licenses for generated Lucide icons and adapted
shadcn component source.
UI TSX uses strict bundler resolution and the `@` alias for `src/ui`; UI sources
are excluded from Node emission. UI tests and tooling have separate type checks.
See [UI design system](ui-design-system.md) for the separately built gallery and
the staged review gates; `.ui-preview` and `.recovery-preview` are not shipped.
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
Pass `-- --recovery` to use the G3 fixture with draft-safe reload instructions.
Pass `-- --comments` for populated and empty G4 comments reviews, including long
feedback and another reviewed page. These flags select fixtures, not old UI versions.
Pass `-- --contextual` for the real G5 composer/aligned-card fixture with selectable
text, page-owned controls, long/nested scrollers and sample saved comments.
Pass `-- --feedback` for the G6 note, seven sample edits, send/handoff and
Revert/End confirmation fixture. Its feedback and destructive actions affect
only the disposable review. Earlier fixture snapshots are unchanged.
The state gallery uses the actual recovery components with simulated state;
the shell fixture exercises the real server and iframe lifecycle.

For an integrated review, `preview:review` uses headless Chromium to create two
HTML rounds, multi-page Source-only coverage, a completed Markdown round,
pending comments, a real saved edit and a separate empty review. It prints a
landing page linking the disposable sessions and explaining what to inspect.
See [the review checklist](migration-review.md). After building, use
`node scripts/migration-review.js --smoke` to verify seeding and clean up without
leaving servers running. This launcher copies `lib` before seeding; like the
other previews, its runtime does not change during later builds.

## README media

The media tells one story using the fictional Field Notes landing page:
Review with an anchored comment, Comments with the complete unsent batch, then
Changes after the requested description and call to action have been revised.
The social cover is a separate composition, not another README banner.

With the local dependencies and Chromium installed, run:

```sh
npm run media:readme
```

The capture recipe in `scripts/capture-readme.js` uses
`test/fixtures/readme-review.js` and a private copy of the built runtime.
It types a real headline edit, adds two selection comments, fills the overall
note, sends the batch, applies a scripted revision, acknowledges the exact
batch, and waits for real SDK history captures. This is a scripted product
example, not a recording of an autonomous agent. No existing review is reused.
Its private server, browser, files, and state are cleaned up on success or failure.

Product captures use a 1120 x 800 viewport at 1.5 device scale (1680 x 1200 PNG),
light mode, English locale, and UTC. `scripts/readme-cover.js` composes the
1280 x 640 social PNG from the actual Review capture. All four outputs must be
below 1 MB. The script checks the saved edit, feedback inventory, successful
round, expected changed text, centered navigation, image dimensions, and browser
errors. It leaves staged PNGs in ignored `output/readme`; use
`node scripts/capture-readme.js --output <directory>` after a build to stage
elsewhere. It does not overwrite tracked images by default.

Inspect all four images at full size and typical README width before copying
the corresponding PNGs into `assets`. Keep the filenames stable:

| Asset | Use |
| --- | --- |
| `doc-review.png` | README hero and contextual commenting example |
| `doc-review-feedback.png` | Feedback inventory, direct edit, overall note, Send |
| `doc-review-changes.png` | Completed comparison of the same feedback round |
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

## Code map

| Area | Ownership |
| --- | --- |
| [`cli.js`](../src/cli.js), [`setup.js`](../src/setup.js) | Commands and agent skill installation |
| [`server.js`](../src/server.js) | Local sessions, APIs, and explicit browser module routes |
| [`contracts`](../src/contracts) | Shared page, frame, feedback, and history shapes |
| [`chrome-api.ts`](../src/chrome-api.ts) | Authenticated requests, response guards, and HTTP errors |
| [`frame-controller.ts`](../src/frame-controller.ts), [`frame-host.ts`](../src/frame-host.ts) | Frame identity, readiness, configuration, reloads, and iframe DOM operations |
| [`save-controller.ts`](../src/save-controller.ts) | Edit queues, save barriers, conflicts, and revert |
| [`feedback-controller.ts`](../src/feedback-controller.ts) | Save and capture coordination, delivery, and committed feedback |
| [`feedback-panel-controller.ts`](../src/feedback-panel-controller.ts), [`ui/components/feedback.tsx`](../src/ui/components/feedback.tsx) | Session-owned overall note/caret, immutable feedback presentation, nonblocking comparison notices and guarded asynchronous End/Revert dialogs |
| [`review-controller.ts`](../src/review-controller.ts) | Refresh, navigation, server events, and shutdown |
| [`chrome-client.js`](../src/chrome-client.js) | Shell rendering, focus, geometry, and user actions |
| [`toolbar-controller.ts`](../src/toolbar-controller.ts), [`ui/components/toolbar.tsx`](../src/ui/components/toolbar.tsx) | Cached toolbar snapshots, guarded commands, and React navigation controls |
| [`recovery-controller.ts`](../src/recovery-controller.ts), [`ui/components/recovery.tsx`](../src/ui/components/recovery.tsx) | Recovery requests, immutable presentation, More menu, and status notices; frame replacement remains server-event-owned |
| [`chrome-session.ts`](../src/chrome-session.ts), [`comments-controller.ts`](../src/comments-controller.ts), [`ui/components/comments.tsx`](../src/ui/components/comments.tsx) | Shared typed comment ownership, cached inventory snapshots, drawer portals, and card controls |
| [`contextual-controller.ts`](../src/contextual-controller.ts), [`ui/components/contextual.tsx`](../src/ui/components/contextual.tsx) | Session-owned composer draft/caret, guarded contextual commands and React composer/aligned-card portals; bounded shell adapter owns measured outer-host geometry |
| [`history-coordinator.js`](../src/history-coordinator.js), [`history-client.js`](../src/history-client.js) | Capture coordination, history selection, and correlated requests |
| [`changes-controller.ts`](../src/changes-controller.ts), [`ui/components/changes.tsx`](../src/ui/components/changes.tsx) | Typed immutable Changes presentation, guarded selection/capture commands, diagnostics and post-commit navigation scrolling |
| [`ui/components/comparison.tsx`](../src/ui/components/comparison.tsx), [`ui/comparison`](../src/ui/comparison) | Inert React Content/Source rendering, bounded context expansion, saved formatting and stable comparison row identity |
| [`sdk.js`](../src/sdk.js), [`markdown.js`](../src/markdown.js) | Document editing integration and Markdown rendering |
| [`SKILL.md`](../src/SKILL.md) | Instructions installed for coding agents |

Keep lifecycle state with its owning controller rather than duplicating it in
the renderer. Controllers expose commands, subscriptions, and disposal. Reuse
the existing history and comment helpers. Types do not replace runtime checks
at HTTP, frame, or persisted data boundaries.

## Package validation

Packages contain `lib`, README, LICENSE, and package metadata. `prepack` rebuilds
before packing. The smoke helper installs a tarball with production dependencies
only and lifecycle scripts disabled, checks CLI help/version and isolated setup,
starts the installed server, verifies the actual self-contained UI bundle and
CSS, and traverses SDK module imports. It also checks opaque-origin SDK CORS,
asset headers, notices, and the absence of UI tooling in the installation.
The browser variant checks that a real review reaches SDK readiness without
external CDN or development-server requests. It exercises contextual comments,
overall-note preservation, Cancel-first End/Revert dialogs, a real saved edit
and revert, feedback delivery, a real acknowledged round with both Content and
Source comparison, and confirmed shutdown in the installed package.

Scratch projects, home directories, and review state are isolated beneath the
checkout and removed afterward. They do not change global skills or review state.

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
