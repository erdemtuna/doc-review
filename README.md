# Human Review

Review HTML, Markdown, and localhost pages, edit when you choose, leave contextual comments, and send all feedback to your AI agent at once.

[Read the full launch post](https://creatoreconomy.so/p/use-my-human-review-skill-to-edit-html-markdown-visually)

https://github.com/user-attachments/assets/7cab09c9-eaa0-4e8b-984d-2925e810b5c2

## Problem

Giving AI feedback on files in chat is painful.

Sometimes you want to change one sentence yourself. Instead, you end up typing:

> In the third paragraph, change X to Y. Cut the third card because it repeats the first one. Also rewrite the CTA.

Then the agent changes the file and you have to check whether it understood every instruction. This gets even harder when you’re reviewing a long plan, Markdown document, landing page, or multi-page website.

## How to install /human-review

The easiest way to install the skill is to paste this into ChatGPT, Claude Code, Codex, or your favorite coding agent:

```text
Install the /human-review skill globally from https://github.com/petergyang/human-review
```

You can also install it with `npx`:

```sh
npx -y human-review setup --global
```

## How to use /human-review

![Human Review visual editor](assets/human-review.png)

Open an HTML or Markdown file:

```text
/human-review (your file)
```

Review a page running on localhost:

```text
/human-review (localhost URL)
```

Human Review opens in **View** (`Editing off, comments enabled`) so links, buttons, summaries, tabs, and application controls work normally. The centered mode selector switches to **Edit** (`Direct editing on`) when you want to change content directly. Commenting stays available in both modes.

Select text, or hover or focus an element, then use the nearby comment icon. `Ctrl+Alt+M` (`Cmd+Option+M` on macOS) opens a comment for the current selection. Press Enter to submit or Shift+Enter for a new line. On desktop the composer stays beside its target, or pins to the effective top or bottom scrolling edge when that target leaves view. **Back to selection** reveals the target without changing the draft. The full-width sheet is used only at the narrow responsive breakpoint.

**Comments** is the single toolbar entry point for the closed-by-default review drawer. Its feedback inventory scrolls independently while the overall note and **Send to agent** controls remain fixed; keyboard users can skip directly to that send region. Submitting a comment creates its normal highlight and increments the count, but keeps the card closed until you activate its mark or choose **Jump to**. Focus returns to the exact element or selection you reviewed.

Aligned cards show **Edit**, **Close**, and **More**; drawer cards show **Jump to**, **Edit**, and **More**. Delete lives only in **More** and requires an inline confirmation. Quote hints preserve both the beginning and ending of long selections. Editing has explicit **Save** and **Cancel** controls: Enter saves, Shift+Enter adds a line, Escape cancels, and moving focus never autosaves. A draft follows its comment between aligned and drawer cards and keeps its caret through target movement.

For writable HTML files, Edit saves direct changes automatically. Markdown and localhost remain editable feedback-only surfaces: their rendered HTML is never written over the source, so click Send and let the agent apply those edits.

File and rendered Markdown reviews run with authored scripts and inline handlers
blocked, an opaque iframe origin, and no popup or download permission. Their
per-render message capability is rotated for every load and navigation. It is
kept out of document URLs, HTML attributes, authored DOM, and global JavaScript
state; the single-use artifact URL loads a same-origin bootstrap module under a
nonce-based CSP. Relative assets, including a same-artifact `<base>`, resolve
beside the reviewed file, while review navigation always stays relative to the
source file. External bases are ignored.

Localhost reviews keep `allow-same-origin`, popup, and download compatibility so
application behavior still works. Because localhost application scripts are
trusted in that mode, the render capability provides correlation and stale
message rejection rather than an authorization boundary. The authenticated
parent still validates links and never exposes the raw-file save route to a
localhost review.

Agent polling returns an immutable `batch_id`. After applying the batch, the
agent acknowledges that exact receipt and keeps waiting:

```sh
human-review poll path/to/file.html --ack b_0123456789abcdef --timeout 600
```

A stale or repeated batch ID is harmless: it never clears newer feedback. The
complete acknowledgement command is included in each response's `next_step`.

## What this skill lets you do

- **Edit text directly and tweak basic formatting** (e.g., bold, italic).
- **Make bulleted and numbered lists** — type `- ` or `1. ` at the start of a line, or press ⌘⇧8 / ⌘⇧7. Tab and Shift+Tab indent and outdent.
- **Add links** — select text and press ⌘K. ⌘K inside an existing link edits or removes it.
- **Resize images** by dragging their corner, and **move images** by dragging them to a new spot.
- **Rearrange the page** — hover any block and drag the handle on its left edge to move the whole block somewhere else.
- **Paste images** from your clipboard — file reviews save them beside the document; localhost reviews stage them for the agent to place in the app source.
- **Select a phrase and leave a comment** from the contextual icon, or press Ctrl+Alt+M / Cmd+Option+M.
- **Comment on an image, chart, control, or section** from its hover or keyboard-focus affordance without taking over its normal click.
- **Remove elements** without explaining the deletion in chat.
- **Command-click links** to review multiple pages without losing your feedback.
- **Send every edit and comment at once** instead of writing a long chat message.

I use Human Review to edit AI-generated plans, update landing pages, review localhost apps, and remove the extra copy AI likes to add to UX.

## What’s inside

- [`cli.js`](src/cli.js) contains the `human-review`, `poll`, `status`, and `setup` commands.
- [`server.js`](src/server.js) runs the local review session.
- [`sdk.js`](src/sdk.js) handles editing, comments, highlights, and feedback.
- [`chrome-client.js`](src/chrome-client.js) contains the visual review interface.
- [`markdown.js`](src/markdown.js) renders Markdown files for review.
- [`SKILL.md`](src/SKILL.md) teaches Claude Code, Codex, and other agents how to use Human Review.

Everything runs on your computer. Human Review doesn’t require an account, cloud service, database, or API key.
Comment geometry remains local, transient presentation data and is never written to review state or sent to the agent. After the agent acknowledges the exact delivered `batch_id`, the comments carried by that batch disappear; newer comments and corrections remain.

## Want more great AI skills?

Check out [Behind the Craft](https://behindthecraft.com), my personal AI system with over a dozen other quality skills and courses.

Subscribe to my [YouTube channel](https://www.youtube.com/@PeterYangYT?sub_confirmation=1) and [newsletter](https://creatoreconomy.so) for practical AI tutorials and interviews.

## License

MIT
