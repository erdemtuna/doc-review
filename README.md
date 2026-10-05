# Doc Review

**Review and refine documents with your agent.**

Open an HTML file, a Markdown document, or a localhost page. Ask questions,
request changes, and edit the small things yourself. Keep the conversation
beside the document as you iterate with your agent.

![The Field Notes landing page in Review, with highlighted copy and an anchored comment asking for a concrete benefit](https://raw.githubusercontent.com/erdemtuna/doc-review/main/assets/doc-review.png)

*Keep questions and feedback beside the document as you refine it together.*

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

Your agent handles the commands using the installed skill.

## How it works

1. **Open your document.** Read and explore it normally. Reviews start in **View**
   so you will not accidentally edit anything.
2. **Start a conversation.** Highlight a passage to ask a question or request a
   change. Switch to **Edit** to make small changes yourself.
3. **Review and iterate.** Choose **Send to agent**, read the replies, and compare
   what changed. Keep the conversation going until you are happy with the result.

Asking a question does not authorize edits. Check **Request a change** when you
want the agent to change the document.

![Feedback with independent open-conversation and edit counts, a saved headline edit, and the optional Note to agent collapsed](https://raw.githubusercontent.com/erdemtuna/doc-review/main/assets/doc-review-feedback.png)

*Review your comments and edits before sending. Add a note only if you need one.*

![The completed Field Notes submission in Changes, comparing the revised description and call to action with their originals](https://raw.githubusercontent.com/erdemtuna/doc-review/main/assets/doc-review-changes.png)

*See what changed, then continue the conversation.*

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

[Agent reference](https://github.com/erdemtuna/doc-review/blob/main/docs/usage.md#sending-feedback):
commands, response formats, and recovery for integrations.

[Development](https://github.com/erdemtuna/doc-review/blob/main/docs/development.md):
build, test, architecture, and package checks.

[Prepared review example](docs/migration-review.md):
an isolated durable shell preview and a reproducible installed-package lifecycle.

[Releasing](https://github.com/erdemtuna/doc-review/blob/main/RELEASING.md):
the maintainers' release process.

## Credits and license

Doc Review is an independent fork of Peter Yang's
[Human Review](https://github.com/petergyang/human-review), continuing from
upstream v0.6.1. Licensed under
[MIT](https://github.com/erdemtuna/doc-review/blob/main/LICENSE).
