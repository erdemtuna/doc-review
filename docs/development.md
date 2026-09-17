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
| `npm run typecheck` | Strict shared, browser, and Node checks |
| `npm run build` | Check types, emit ESM, and copy runtime assets |
| `npm run test:unit` | Rebuild and run unit tests |
| `npm run browser:install` | Install the matching Chromium |
| `npm run test:browser` | Rebuild and run browser tests |
| `npm run test:package` | Pack and check an isolated production installation |
| `npm run test:package:browser` | Also open an installed package review in Chromium |
| `npm run test:all` | Build, run unit and browser suites, then check packaging |

Install Chromium before the browser commands. CI uses
`npm run browser:install:ci` to include its system dependencies.
`test:all` runs the browser suite but uses the nonbrowser package smoke; run
`test:package:browser` when validating the installed browser experience too.

Source lives in `src`; the TypeScript compiler emits ESM into `lib` without a
bundler. Existing JavaScript remains unchecked while new TypeScript is strict.
Pure contracts have no Node or DOM globals. Browser modules use DOM types
without Node globals; Node consumers use Node 24 typings without DOM globals.
Shared runtime helpers are checked in their consuming environments. Keep `.js`
import specifiers in TypeScript source.

Builds remove only generated `lib` and copy the explicit assets `chrome.html`,
`chrome.css`, and `SKILL.md`. Release candidates in `dist` are separate.
Do not rebuild while another process is testing or serving `lib`.

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
| [`review-controller.ts`](../src/review-controller.ts) | Refresh, navigation, server events, and shutdown |
| [`chrome-client.js`](../src/chrome-client.js) | Shell rendering, focus, geometry, and user actions |
| [`history-coordinator.js`](../src/history-coordinator.js), [`history-client.js`](../src/history-client.js) | Capture coordination, history selection, and correlated requests |
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
starts the installed server, and traverses its browser module imports.
The browser variant also checks that a real review reaches SDK readiness.

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
