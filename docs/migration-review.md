# Disposable conversation review

Run `npm run preview:shell` (or its alias `npm run preview:review`) and open
the printed `/r/<reviewId>` link. This copies the built runtime and a Field Notes
sample into a private `.shell-preview-*` directory with isolated state.
It seeds a Discussion and a separate checked change request. It never reads,
imports or replaces an existing review store. Ctrl+C stops only this fixture
and removes its private directory. After building, `node scripts/shell-preview.js
--smoke` validates seeding and exits; it leaves no server running.

Check expanded Open/Resolved exchanges, independent collapse, pending replies
and explicit Resolve/Reopen. Move a draft between Feedback, Focus and its
highlight-adjacent host: text, caret and reading position must stay intact.
Close hides the host, not the thread. Missing or ambiguous targets retain their
original quote and accessible discussion, without a false Jump or reattachment.

Open the same link in another tab to inspect shared End and late results.
End freezes reviewer content in both tabs; it does not stop accepted agent work.
Unsent saved items stay in the ended review. Unsaved drafts are memory-only.
Use the generated identity-bound CLI commands for responses, never a target-only
poll or acknowledgement.

For the automated complete loop, run:

```sh
npm run test:all
npm run test:package:browser
```

The installed-package fixture creates its own source files, temporary home,
state and server. It tests HTML/Markdown/scripted/URL changes, exact human edits,
two-tab lifecycle/restart, uncertainty and receipt replay, permission boundaries,
overlap, abandonment, retained comparisons/assets and safe adoption.
Set `DOC_REVIEW_SMOKE_ARTIFACTS` to retain its tarball, JSON evidence,
server log and browser screenshots in a chosen scratch directory.
Failed fixtures are retained for diagnosis. No global skill, live server,
release version, branch or commit is changed.

See [development](development.md#package-validation) for package reproduction
and [usage](usage.md) for lifecycle and filesystem limitations.
