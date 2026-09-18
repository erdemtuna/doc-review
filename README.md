# Doc Review

**Review your coding agent's work in the browser, not in a wall of chat.**

Open an HTML file, a Markdown document, or a localhost page. Point to what needs
changing, edit the small things yourself, and send your feedback to the agent
in one batch.

![The Field Notes landing page in Review, with highlighted copy and an anchored comment asking for a concrete benefit](https://raw.githubusercontent.com/erdemtuna/doc-review/main/assets/doc-review.png)

*Feedback stays beside the work. Your agent gets the comments, edits, and overall note together.*

## Get started

Requires **Node.js 24.21.0 or newer** and a coding agent that can run shell commands.
Install the skill once:

```sh
npx -y @erdemtuna/doc-review setup --global
```

Start a fresh agent session, then ask it to open a review:

```text
/doc-review path/to/landing-page.html
```

The same command works with Markdown or a running local app:

```text
/doc-review path/to/plan.md
/doc-review http://localhost:3000
```

Reviews start only when you request them. Your agent uses the installed skill
to open the page, wait for feedback, and apply the changes.

## From feedback to the next version

1. **Open and explore.** Reviews start in **View**, so you can read and use page
   controls without accidentally editing.
2. **Point out what matters.** Select text or choose an element to leave a
   comment. Switch to **Edit** for direct changes to wording, formatting, images,
   or layout. Commenting works in either mode.
3. **Send one batch.** Open **Feedback**, inspect Comments and Edits, add an overall note if needed, and
   choose **Send to agent**. No need to describe where every sentence lives.
4. **Check the result.** Use **Changes** to compare a review round's captured
   before and after content, then continue reviewing. Comparisons show observed
   changes, not a guarantee that every request was resolved.

You can review a plan, refine a landing page, or walk through a local app without
moving your feedback into a separate document.

![The Feedback panel with separate Comments and Edits sections, an overall note, and End review beside Send to agent](https://raw.githubusercontent.com/erdemtuna/doc-review/main/assets/doc-review-feedback.png)

*One batch, with the context attached: comments, your edits, and the overall direction.*

![The completed Field Notes review round in Changes, comparing the revised description and call to action with their originals](https://raw.githubusercontent.com/erdemtuna/doc-review/main/assets/doc-review-changes.png)

*Check the result beside the original. Move between changes or switch to Source for the saved file text.*

## What happens to your edits?

| What you open | Where edits go |
| --- | --- |
| Plain HTML | Saved directly to the file, with Revert available |
| Scripted HTML or Markdown | Sent to the agent to apply to the original source |
| Localhost page | Sent to the agent to update the app's source |

Self contained HTML can run inline scripts. For an app with separate script
dependencies, use its localhost URL instead.

Doc Review runs locally and needs no Doc Review account, hosted backend, or API
key. The page you review and the coding agent you use may still contact external
services.

## Learn more

[Usage guide](https://github.com/erdemtuna/doc-review/blob/main/docs/usage.md):
setup options, comments, comparisons, limitations, and upgrades.

[Development](https://github.com/erdemtuna/doc-review/blob/main/docs/development.md):
build, test, architecture, and package checks.

[Prepared review example](docs/migration-review.md):
disposable HTML/Markdown sessions with saved comparison rounds and a shell review checklist.

[Releasing](https://github.com/erdemtuna/doc-review/blob/main/RELEASING.md):
the maintainers' release process.

## Credits and license

Doc Review is an independent fork of Peter Yang's
[Human Review](https://github.com/petergyang/human-review), continuing from
upstream v0.6.1. Licensed under
[MIT](https://github.com/erdemtuna/doc-review/blob/main/LICENSE).
