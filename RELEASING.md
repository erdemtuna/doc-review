# Releasing doc-review

`@erdemtuna/doc-review` is released manually, in two phases, through
[`.github/workflows/release.yml`](.github/workflows/release.yml).

| Phase | Dispatch input | What it does |
| --- | --- | --- |
| `prepare` | `operation=prepare` | Validates, tests, packs and uploads one immutable release candidate. Publishes nothing. |
| `release` | `operation=release` + `prepare_run_id` | Re-verifies that exact candidate, publishes it to npm, then makes the GitHub Release public. |

**The tarball that gets published is always the one CI produced. Never run
`npm pack` locally to produce a publishable archive, and never publish an
archive that did not come from a successful `prepare` run.** A locally packed
archive is unverified, may contain untracked or ignored local files, and will
not match the recorded SHA-256/SHA-512 digests.

## Prerequisites

- The `npm-release` GitHub environment exists, requires Erdem's approval and is
  restricted to the `main` branch. The workflow also refuses to run outside
  `refs/heads/main`; both controls are required.
- npm trusted publishing is configured for the package (see
  [First release bootstrap](#first-release-bootstrap-v070) for the one-time
  exception).
- The tag passed as `previous_tag` already exists in the repository. The
  inherited upstream tag `v0.6.1` must be pushed to the fork before releasing
  `0.7.0`; do not create a GitHub Release for it.
- No npm token exists anywhere in the repository, its secrets or its variables.

## 1. Land a version pull request

```bash
git switch -c release/0.7.0
npm version 0.7.0 --no-git-tag-version
git commit -am "Release 0.7.0"
```

- `npm version --no-git-tag-version` updates `package.json` and
  `package-lock.json` without creating a tag; the release workflow owns tagging.
- Open a pull request and let the `test` workflow finish. Required before merge:
  unit tests on Node 20/24 (Ubuntu) and Node 24 (Windows), plus the Chromium
  browser job.
- Label the pull request so the generated release notes categorise it
  (see [`.github/release.yml`](.github/release.yml)).
- Merge to `main`. Every release runs from the current head of `main`.

## 2. Run `prepare`

Actions → **release** → **Run workflow** on `main`:

| Input | Value |
| --- | --- |
| `operation` | `prepare` |
| `version` | `0.7.0` (must equal `package.json`) |
| `prepare_run_id` | leave empty |
| `previous_tag` | `v0.6.1` (use the previous released tag for later versions) |

The prepare job runs on a GitHub-hosted Ubuntu runner with Node 24 and a pinned
npm 11 CLI, with package-manager caching disabled and all actions pinned by
commit SHA. It runs `npm ci`, the unit tests, Chromium browser tests with one
worker, `npm pack --json`, strict package-content validation and an isolated
packed-tarball smoke test (`--version`, `--help`, `setup --global`).

**Record the run ID.** It appears in the run URL
(`.../actions/runs/<prepare_run_id>`) and in the job summary. You need it
verbatim for the release phase.

## 3. Review the immutable candidate

Download the `release-candidate-<version>` artifact from that run. It contains
exactly three files and is retained for 30 days:

- `erdemtuna-doc-review-<version>.tgz` — the only publishable archive
- `erdemtuna-doc-review-<version>.tgz.sha256` — `sha256sum`-format checksum
- `release-metadata.json` — package, version, filename, repository, source
  commit, prepare run ID and attempt, Node version, npm version, registry,
  SHA-256 digest and npm SHA-512 integrity

Verify locally before approving anything:

```bash
cat release-metadata.json
sha256sum --check erdemtuna-doc-review-0.7.0.tgz.sha256
echo "sha512-$(openssl dgst -sha512 -binary erdemtuna-doc-review-0.7.0.tgz | base64 -w0)"
tar -tzf erdemtuna-doc-review-0.7.0.tgz
```

The printed `sha512-…` value must equal `.integrity` in the metadata.

## First release bootstrap (`v0.7.0`)

npm trusted publishing cannot be configured until the package exists, so
`0.7.0` — and only `0.7.0` — is published interactively. It will therefore have
**no OIDC provenance**; do not claim or test provenance for it.

1. Confirm nothing redirects the scope away from the public registry:

   ```bash
   npm config get @erdemtuna:registry   # must print undefined
   npm config get registry              # note any corporate proxy in use
   ```

2. Authenticate against the public registry explicitly:

   ```bash
   npm login --registry=https://registry.npmjs.org
   npm whoami --registry=https://registry.npmjs.org   # must print erdemtuna
   ```

3. Run `prepare` for `0.7.0` (step 2 above) and verify the artifact (step 3).

4. Publish **the exact CI tarball**, with 2FA. Do not run `npm pack`:

   ```bash
   npm publish ./erdemtuna-doc-review-0.7.0.tgz --access public --registry=https://registry.npmjs.org
   ```

5. Confirm the published `dist.integrity` matches the prepared metadata:

   ```bash
   npm view @erdemtuna/doc-review@0.7.0 dist.integrity --registry=https://registry.npmjs.org
   ```

6. Enable trusted publishing for the now-existing package:

   ```bash
   npm install --global npm@^11.15.0 --registry=https://registry.npmjs.org
   npm trust github @erdemtuna/doc-review --file release.yml --repo erdemtuna/doc-review --env npm-release --allow-publish --registry=https://registry.npmjs.org
   npm trust list @erdemtuna/doc-review --registry=https://registry.npmjs.org
   ```

   `npm trust` requires npm 11.15.0 or newer and account-level 2FA. Review the
   listed publisher and confirm its repository, workflow, environment and
   publish permission before continuing.

   The workflow filename must be exactly `release.yml` and the environment
   exactly `npm-release`; both are part of the trust relationship.

7. Finalize the release through the workflow (next section). It will detect the
   already-published version, require matching integrity, and only then create
   and publish `v0.7.0` with its assets and generated notes.

Never share an npm credential or token with an agent, and never store one in
GitHub.

## 4. Run `release`

Actions → **release** → **Run workflow** on `main`:

| Input | Value |
| --- | --- |
| `operation` | `release` |
| `version` | `0.7.0` |
| `prepare_run_id` | the recorded prepare run ID |
| `previous_tag` | `v0.6.1` |

Before requesting approval the workflow proves, fail-closed, that:

- the dispatch ref is `refs/heads/main` and the dispatched commit is the current
  head of `main`;
- `version` equals `package.json`;
- the referenced run belongs to this repository, ran `.github/workflows/release.yml`
  via `workflow_dispatch`, succeeded, ran on `main`, and its head SHA equals both
  the current `main` head and the commit recorded in the artifact metadata;
- the downloaded artifact matches its metadata, SHA-256 checksum and SHA-512
  integrity, and its packed manifest carries the expected name and version.

Then the deployment waits on the `npm-release` environment.

### Approving

Approve the `npm-release` deployment in the run page only after reviewing the
verification summary. Self-approval by the initiator is expected for this
single-maintainer repository.

The privileged job re-downloads and re-verifies the same artifact, asserts that
no `NODE_AUTH_TOKEN`, `NPM_TOKEN` or `_authToken`/`_auth` npmrc entry exists and
that an OIDC token endpoint is available, then publishes with the pinned npm 11
CLI directly to `https://registry.npmjs.org`. It never runs tests, installs
project dependencies or repacks after approval.

Order of operations after approval:

1. Inspect the tag and release state.
2. Inspect npm for an existing `<package>@<version>` **and for the package's
   current `latest` dist-tag**.
3. Create or reuse the **draft** GitHub Release, targeting the prepared commit,
   with the tarball and `.sha256` attached and notes generated from `previous_tag`.
4. `npm publish <tarball>` through trusted publishing, if the version is absent.
5. Re-read the registry with retries and require the published SHA-512 integrity
   to equal the prepared artifact. The `latest` dist-tag is required to equal the
   version only when the version is the one npm should be serving as latest.
6. Only then flip the GitHub Release from draft to public and mark it latest.

### Ordering and the `latest` tags

The workflow never publishes out of order and never moves `latest` backward:

- If the target version is **absent** on npm and npm's `latest` is already a
  greater version, the run hard fails. Release a version newer than npm `latest`
  instead.
- If the target version **exists with matching integrity** and is npm's `latest`
  (or npm has no newer version), the run behaves normally: it finalizes the
  GitHub Release and marks it latest.
- If the target version **exists with matching integrity but npm `latest` is
  newer**, the version is superseded. The run continues only as asset repair of
  an **already published** GitHub Release. It leaves npm's `latest` alone, does
  not re-mark the GitHub Release as latest, and verifies only that the version's
  integrity still matches.
- If a superseded version has a **missing or draft** GitHub Release, the run
  hard fails rather than finalizing an old release after a newer one.

Version comparison uses `sort -V` over plain `MAJOR.MINOR.PATCH` values; a
non-plain `latest` dist-tag on the registry is a hard failure that must be
resolved manually.

## 5. Verify the release

```bash
npm view @erdemtuna/doc-review version --registry=https://registry.npmjs.org
npm view @erdemtuna/doc-review@0.7.0 dist.integrity --registry=https://registry.npmjs.org
npx -y @erdemtuna/doc-review@0.7.0 --version
gh release view v0.7.0 --json tagName,isDraft,targetCommitish,assets,body
```

Confirm:

- the npm version and integrity match `release-metadata.json`;
- `doc-review --version` and `--help` show the new identity;
- the `v0.7.0` tag targets the released commit;
- the GitHub Release is public and carries both the `.tgz` and its `.sha256`;
- the generated notes start after `v0.6.1` and are not empty.

## 6. Verify OIDC with `v0.7.1`

The bootstrap did not exercise trusted publishing, so verify it immediately
rather than at the next feature release:

1. Land a small `0.7.1` version/release-automation pull request.
2. Run `prepare` for `0.7.1`; record the run ID.
3. Run `release` with that exact run ID and `previous_tag=v0.7.0`.
4. Approve the `npm-release` deployment.
5. Confirm the publish step used OIDC and that npm shows provenance:

   ```bash
   npm view @erdemtuna/doc-review@0.7.1 --registry=https://registry.npmjs.org
   ```

6. Only after this succeeds, require 2FA for publishing and disallow classic
   publishing tokens in the npm package settings.

## Recovery

All recovery paths reuse the **same** `prepare_run_id` and the same artifact.
Never prepare a new candidate to "fix" a half-finished release unless the
version itself changes.

| Situation | Behaviour | What to do |
| --- | --- | --- |
| Draft release already exists for `v<version>` | Reused; its target commit is reset to the prepared commit and assets are re-uploaded with `--clobber`. | Re-run `release` with the same run ID. |
| npm publish succeeded but the GitHub Release step failed | The npm version is detected with matching integrity and publication is skipped; the draft is completed, published and marked latest. | Re-run `release` with the same run ID. |
| Release already published, assets missing or corrupt | Allowed only as asset repair, and only if the tag points at the prepared commit. Notes are not regenerated, the release stays public and its latest state is left untouched. | Re-run `release` with the same run ID. |
| Asset repair of an older published release after a newer release exists | Allowed. npm `latest` is not required to equal the target version, the target's integrity is still verified, and neither npm `latest` nor GitHub's latest release is changed. | Re-run `release` for that older version with its original prepare run ID. |
| Older version is missing or still a draft while npm `latest` is newer | Hard fail; the workflow refuses to finalize a release older than npm `latest`. | Do not backfill an old release. Release a version newer than npm `latest`. |
| Target version absent on npm while npm `latest` is newer | Hard fail; publishing would be out of order and would move `latest` backward. | Bump to a version greater than npm `latest`, land it, `prepare` and release that. |
| npm `latest` is not a plain `MAJOR.MINOR.PATCH` version | Hard fail; the ordering check cannot be trusted. | Fix the registry dist-tags manually, then re-run. |
| Tag `v<version>` exists but points at another commit | Hard fail. | Do not move the tag. Land a new patch version and release that. |
| npm version exists with matching SHA-512 integrity | Idempotent; publishing is skipped, verification continues. | Nothing; this is the bootstrap and rerun path. |
| npm version exists with different integrity | Hard fail. | Never bypass it. npm versions are immutable: bump to a new patch version, land it, `prepare` again and release that. |
| Prepare artifact expired (older than 30 days) | Download fails. | Re-run `prepare` on the current `main` head and use the new run ID. |
| `main` moved after `prepare` | Guard fails because the dispatched commit is no longer the head of `main`. | Re-run `prepare` on the new head and use that run ID. |

## Notes

- Concurrency group `release` with `cancel-in-progress: false` serialises
  releases; an in-flight release is never cancelled by a newer dispatch.
- Only the final publishing job holds `contents: write` and `id-token: write`.
  Guard, prepare and verification jobs are read-only.
- The inherited `release.published` publish workflow was removed, so making a
  GitHub Release public can no longer trigger a second npm publish.
