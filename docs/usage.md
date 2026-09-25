# Using Doc Review

[Back to the README](../README.md)

Open files or localhost pages in the browser, leave contextual feedback, and let
your coding agent apply it. This guide covers the details behind the
[basic review loop](../README.md#from-feedback-to-the-next-version).

## Setup and activation

Use Node.js **24.21.0 or newer**. Install personal skill instructions with:

```sh
npx -y @erdemtuna/doc-review setup --global
```

For project guidance, run `npx -y @erdemtuna/doc-review setup` from the project.
You can also ask your coding agent:

```text
Install the /doc-review skill globally from https://github.com/erdemtuna/doc-review
```

Start a fresh agent session after setup, or reload its skills. In Copilot CLI,
use `/skills reload`. Setup copies the template from the package you execute;
running an older package can restore older instructions.

Explicitly invoke `/doc-review` or ask for an interactive browser review.
Writing or updating a document, or asking for a general review, does not
automatically open the browser. Once started, the review continues until you
end it or switch tasks.

To open a target directly from the terminal:

```sh
npx -y @erdemtuna/doc-review path/to/file.html
npx -y @erdemtuna/doc-review http://localhost:3000
```

The CLI opens the review and prints its durable identity and generated commands;
an agent still needs to poll and respond to the feedback.
The installed [skill instructions](../src/SKILL.md) describe that workflow.

## Comments and editing

Reviews start with **View** selected. Use page controls normally,
or switch to **Edit** to change content. Comments are available in both modes.

Select text, or hover or focus an element, then use its nearby comment icon.
New comments use measured space beside, above or below the selection or element
without resizing the document or covering the target. The toolbar's **Feedback**
opens the same unsaved editor in the panel. Only unavailable geometry or insufficient
target-safe space uses Feedback instead; narrow PC windows are not an automatic
fallback. Offscreen composition is pinned to the target's
clipping edge and offers **Back to selection**. An editor's X or Escape closes
empty/unchanged work immediately; meaningful unsaved text or a saved message's
changed permission prompts **Keep editing / Discard**. Keep editing restores
your caret. Save or discard dirty work before switching its target.
Feedback's outer X only hides the panel and preserves drafts.

For saved conversations, **Jump to** (with a location icon) reveals the exact passage and hides Feedback; **Focus** gives one conversation a larger transcript with its
header and composer reachable. Activate an existing highlight with a click,
Enter or Space to open one conversation beside it. A shared-target count and
chooser expose other conversations at that highlight. **Beside target**,
**Focus** and **Back to Feedback** move the same mounted editor, preserving text,
selection, caret, composition, loaded exchanges and reading position.

The card never covers its highlighted target. Short discussions fit their contents;
long transcripts scroll with Reply or the active editor kept reachable. No host
reserves a document gutter or reflows the authored page. Local cards may cover
unselected prose. If no usable target-safe placement fits, the conversation stays
accessible in focused Feedback with an explanation and its editor still reachable. Narrow
Feedback covers the document without changing its width: Close it or use **Jump to**
to return to the document. Reopening Feedback restores the sidebar reading position and drafts.
An offscreen target offers **Jump to**, not a missing-target warning.
Missing, ambiguous, hidden and unavailable targets have an explanation and no
false jump. Original anchors and conversations are retained; there is no
reattachment control. A recovered target does not reopen a card automatically.

| Action | Control |
| --- | --- |
| Comment on the current selection | `Ctrl+Alt+M`, or `Cmd+Option+M` on macOS |
| Save a pending message, reply or edit | `Enter` or **Save**; this does not dispatch |
| Add a line inside a message | `Shift+Enter` |
| Cancel a local draft | `Escape` or the editor's X; confirm **Discard** for unsaved changes |
| Find a thread's target, including another review page | **Jump to** |
| Return to an offscreen target | **Jump to** |
| Dismiss the conversation host | **Close conversation**, or `Escape` from its controls (not a composing editor) |
| Delete a never-submitted thread | **Conversation actions → Delete thread**, then confirm deletion |

Saving queues a message. Every new message starts with **Request a change**
unchecked. Saved change requests display **Change requested**; ordinary discussions
and answered replies need no status pill. Other response outcomes remain explicit;
only unsent messages have Edit controls. Correct sent instructions with a new
message instead of changing immutable history. Closing Feedback or collapsing a
thread only hides content. **Resolve** and **Reopen** in **Conversation actions** are separate shared actions; save or cancel a
local draft first. Pending/outstanding messages prevent Resolve.

While Save is in flight, typing and selection remain available but another Save
and editor cancellation are locked through acceptance or reconciliation. Newer typing is retained.
Active IME composition never triggers Save or cancellation. The overall note remains
multiline: Enter never sends or saves it independently.

![An anchored comment beside highlighted Field Notes copy, asking what readers can collect and how it helps them](../assets/doc-review.png)

*The reusable highlight-adjacent conversation includes
Feedback/Focus transfers, shared-target selection and safe placement fallback.*

In Edit you can change text and basic formatting, make lists, add links,
resize or move images, rearrange blocks, and remove elements. Type `- ` or `1. `
to start a list; use Tab and Shift+Tab to change nesting. On macOS, `Cmd+K`
adds or edits a link, and `Cmd+Shift+8` / `Cmd+Shift+7` creates lists.
Pasted images are saved beside file reviews or staged for the agent in localhost
reviews. Command clicking links lets you review multiple pages in one session.

Open **Feedback** for conversations, pending edits, submission history and the
overall note. Open and Resolved filters both start enabled; cards start expanded
with their latest exchange and saved pending follow-ups. Selected filters remain
visibly selected after you move away. Separate bordered discussion cards contain
plain reviewer/agent messages with author, avatar and time. **Reply** is visible;
hover or focus a timestamp for its full date and time.
**Conversation actions** also holds **Beside target** when available.
**Load earlier** reads
actual associated reviewer/agent exchanges. Collapse and filters are independent
and local to this tab. New activity is marked without forcing expansion or scroll.
The inventory includes all shared-review member pages, not just this tab's visits.
Uncheck **Include in Send** or an edit to omit that pending item.

Feedback opens as a 380px right-side overlay, including at 720px PC widths (clamped to the viewport on smaller screens),
without resizing or reloading the document. Click its backdrop or Close to
return to the page; the toolbar remains available. The inventory scrolls
independently of the note and bottom action row.
On short phone-sized screens, the filters share the Close row and the plus
button starts a new message. **Comments** and **Your edits** collapse independently.
**Overall note (optional)** starts collapsed and shows **Draft** when it contains
text. Expand it to edit its independent permission. Collapse and resize keep its
text and caret; a composing note cannot be collapsed. End and Send remain available,
including note-only Send. On very short screens, expand the note to see the detailed
selection counts. No disclosure saves, clears or changes either draft's permission.
The toolbar count is saved pending messages plus edits across all review pages,
not unread activity. Excluded items remain pending and stay in that count.
The footer lists the selected saved messages, pending edits and optional note;
**Send (N)** counts that exact selection. During loading, failed reads or unknown
acceptance, the count is unavailable rather than zero and Send stays disabled.
The overall note can be sent on its own. It stays in this tab when you close
Feedback, inspect a comparison, or change theme. Open message drafts are not
included until explicitly saved. Drafts are never persisted or synchronized
across tabs; closing/reloading the browser loses them. The note is submission
input, not a thread, and its permission applies only to itself.
**End review** is on the left; **Send** is on the right.

## Appearance

The theme button switches the review shell and in-page annotation tools
together. It remembers the light/dark preference in this browser; it does not
change the document's own colors or saved source. The rounded teal brand tile
stays the same in both themes.

If annotation tools cannot confirm a theme change, an explicit notice offers
**Retry theme**. This retries the latest preference without reloading the page,
changing editing mode, or discarding drafts. On initial loading, annotation
tools stay hidden until the theme is applied; after a live toggle, their last
applied appearance remains until recovery. **Reload source (discard local page edits)** remains a separate
recovery action for document/render problems, not a theme-retry mechanism.

## Files, scripts, and local apps

| Target | Save behavior |
| --- | --- |
| Plain HTML, including ordinary JSON data blocks and escaped code examples | Direct autosave and Revert |
| HTML containing executable scripts or event handlers | Feedback for the agent to apply to source |
| Markdown | Rendered for review; the agent updates Markdown source |
| Localhost | The agent updates the corresponding app source |

Self contained HTML runs inline scripts and event handlers automatically.
There is no approval switch to renew after source updates. Scripted previews
are never written back as replacement source, even with scripts disabled.
The renderer checks save behavior again when the source changes.

The toolbar no longer includes a More menu or normal script-policy toggles.
Source/render failures expose **Reload source (discard local page edits)** in
the contextual recovery row; unconfirmed theme updates expose **Retry theme**.
Reviewing, Waiting for agent and Review ended have hover/focus explanations in
the centered status badge. View/Edit is at the far right. Frame reload handling preserves
in-memory drafts and reports source conflicts; a full browser reload does not
recover unsaved drafts.

Separate script files, application imports, workers, and embedded applications
are outside the self contained file mode. Use localhost for app workflows.
Localhost pages are fetched and rewritten by the review server, so their
original cookies, storage, and requests that depend on origin may behave
differently. This is not an identical browser session in the original app.

Files use an opaque iframe origin and relative assets stay scoped to the file.
Localhost reviews retain their artifact origin, popup, and download behavior.
The shell authenticates API calls and checks frame identity, but authored scripts
share the document with the SDK: correlated feedback is not proof of human
authorship.

## Sending feedback

![Feedback showing collapsible Comments and Edits, an overall note, and End review to the left of Send to agent](../assets/doc-review-feedback.png)

*Review the submission before sending. Every message has independent discussion
or change-request intent. The overall note has its own intent, not blanket
permission across individual messages or pages.*

Send waits for edit persistence and writable HTML saves, then attempts a short
baseline capture for comparisons. Missing comparison data does not block
delivery. Save or delivery failures are reported without discarding feedback.
An incomplete comparison appears as a supporting notice after sending, not
another confirmation gate. Unknown acceptance exposes the original request ID,
**Check receipt**, and **Retry same request**. A lookup miss remains unknown.
Never repeat source edits because the response was lost.

**Revert** and **End review** ask for confirmation with **Cancel** focused.
Escape cancels just that confirmation. Revert keeps comments and the overall
note. End freezes persisted unsent items read-only in that review; it neither
sends them nor transfers them to a fresh review. A source or
feedback change invalidates an open confirmation; cancel it and review the
latest state. Pending actions cannot be submitted a second time.

End applies to every tab; it does not cancel accepted source work. The ended UI
keeps observing late responses after reconnection or server restart. A fresh
open creates a different review; old links never silently follow it. Outstanding
predecessor or selected-page work blocks Send and affected Edit/Revert, but you
can still prepare discussion. **Abandon submission** remains available after
End, with a separate confirmation naming the review/submission and warning to
stop the old agent and inspect source. It stops redelivery, not external work,
and promises neither cancellation nor undo.

The agent receives one immutable submission covering the selected known pages.
Open returns `review`, `receipt`, `url`, and `handoff`. All subsequent commands
use the exact `reviewId` and `entryKey`, even after End or a server restart.
Copy the generated commands rather than reusing these placeholders:

```sh
npx -y @erdemtuna/doc-review poll --review <reviewId> --entry <entryKey> --timeout 600
npx -y @erdemtuna/doc-review context --review <reviewId> --entry <entryKey> --thread <threadId>
```

Poll returns `state: "work"` with `review`, immutable delivered `submission`,
canonical `pages`, and scoped `handoff` commands. A message's `discuss` intent
means an answer without source edits. `request-change` permits only that message's
change, not a mandatory edit. Clarification and deferral are valid outcomes.
Context returns bounded exchanges with `reviewer` and nullable `response`;
use `--cursor <nextCursor>` for earlier windows. Default 50, maximum 100.

The agent writes a complete response file and submits it:

```sh
npx -y @erdemtuna/doc-review respond --review <reviewId> --entry <entryKey> --response-file response.json --timeout 600
```

The file contains `operation: "respond"`, `reviewId`, `entryKey`, `submissionId`,
the delivered submission's `expectedVersion`, a stable caller `requestId`,
`responses`, `editOutcomes`, and one `resultNote`. Include `overallOutcome` only
when an overall note exists. Every selected message and edit must be covered
exactly once with its exact version. See the
[complete example and allowed outcomes](../src/SKILL.md#complete-response-then-wait).
Discussion cannot be reported as Applied; saved human edits use `already-saved`
only when server evidence exists. Clarify/defer incomplete or ambiguous work.

Successful output is `{ok:true,receipt}` after atomic persistence. Newer unsent
items survive. Inline exchanges, result notes, and receipts remain durable.
Neither target-only polling nor acknowledgement-only completion is accepted.
One cooperating handler is assumed; there is no worker lease or guarantee of
exactly-once external filesystem edits.

On connection loss the CLI retries the identical logical response within its
deadline, never source edits. Exit 1 returns typed `{ok:false,error}`. Exit 2
returns `{state:"unknown",requestId,reason}` when acceptance is uncertain:
reuse the same file and request ID. A `receipt` lookup can show acceptance,
but `not-found` is not proof of rejection. Changing the payload under the same
identity fails rather than returning a foreign result.

Without `--timeout`, polling stops after 12 hours. An explicit timeout includes
server discovery, reconnection, and retry delays. Recoverable connection drops
are retried; authorization errors, invalid responses, and incompatible servers
fail visibly. A `state: "timeout"` result does not discard feedback or prove no accepted work
exists. Check immediately with:

```sh
npx -y @erdemtuna/doc-review status --review <reviewId> --entry <entryKey>
npx -y @erdemtuna/doc-review receipt --review <reviewId> --entry <entryKey> --request-id <requestId>
```

Status returns `source: "server"|"disk"`, validated `status`, and
`latestSubmission`. It distinguishes open/ended, queued/delivered/handled/abandoned
evidence, pending counts, and overlapping or predecessor blockers. Delivered is
not proof of a live handler. Offline status reads validated `conversation-state.json`
without starting a server or modifying files; corruption is an explicit error,
not an empty status or an old-store fallback.

Restart polling if the review is still wanted. End does not cancel work already
accepted: queued submissions still arrive, and delivered ones can finish after
End/restart. Stop on `state: "ended"` once that exact review has no outstanding
work. Abandonment is separate confirmed management, including after End: it
releases exclusion and rejects late responses, without claiming cancellation,
success, or undo. Never retry an abandoned response under a new request ID.

Each edit text or HTML field is limited to **200,000 Unicode code points**.
Oversized fields are identified by `truncated: true` and `truncated_fields`.
An agent must obtain the complete edit from an authoritative source, or ask you
for it, rather than treating partial content as a complete replacement.

## Submission history and Changes

Feedback shows the latest agent result before the discussion inventory. **View
result** opens its full result note and retained comparison. The note is available
even when a capture is pending, unavailable, or failed. **History** in the Feedback
header opens earlier submissions without replacing your reply or overall-note
editors. Use **Back to Feedback** to return to their retained text, permissions and
reading position. Completed submissions are collapsed in **Submissions and results**;
expand one for its note, receipt details, named pages and **Content changes** or
**Source changes** actions. History also contains the **Agent command** and
**Advanced actions → Abandon submission**, with the existing confirmation.

Content-capture problems appear with the affected result/page, not as an unrelated
source-save warning. Automatic and explicit captures share one exact in-flight
request. An immutable conflict is reconciled only when that same result's Content
comparison is authoritatively available; Source alone is not proof. Changed source,
changed visible view and genuine capture failures remain explicit.

The document stays mounted and retains unsent drafts while Changes is open. A comparison
normally compares content captured when feedback was sent with the result
captured after the agent reported source changes in a complete response. Previous submissions keep their
own fixed endpoints instead of changing on each reload.

![The Field Notes submission comparison, with before-and-after text for the revised description and call to action](../assets/doc-review-changes.png)

*The same example after its feedback was applied and answered.*

Content presents an aligned before and after reading surface with expandable
context. Source presents source hunks with line numbers for file reviews.
Narrow screens use a unified view with before and after attribution.
Deleted passages remain readable, and uncertain matches do not claim an exact
current target.

Comparisons cover captured text, structure, formatting, links, and image
references. They do not prove who made a change or whether every comment was
resolved. Image bytes changed at the same URL, canvas pixels, external stylesheet
appearance, inaccessible embedded content, and hidden application states are
outside the comparison guarantee. History requires no extension, screenshots,
or automatic Git commits.

Content results can wait for the original identifiable tab or panel. Return to
that view to retry; Doc Review does not click through tabs automatically.
Unknown views are labelled unverified. Source comparison covers the file
independently and can be available while Content is pending.

Source results are captured independently of the browser after a changes-reported response.
Content is captured when the appropriate page is ready. Their timestamps can
differ, and neither claims to be the exact instant of response acceptance.
Reply-only results do not fabricate a version, capture, or reload. A result note
can still be titled "What changed" for an already-saved human edit.
Reloading the source can retry unavailable rendered capture without erasing a response.
A page that keeps changing may never produce a stable snapshot. Use the
submission's **Capture current content** action when available on the open page.
If you opened Changes before that capture finished, **Refresh comparison** reads
the saved evidence again without recapturing it; a failed comparison read has a
separate **Retry comparison** action. Missing or failed capture is
never presented as zero changes, and does not undo a handled response.

**Your edits** shows readable Before/After previews, an independent
Include in Send checkbox, and **Already saved** or **Source pending** evidence.
**Exact edit details** retains the complete recorded content and source identity.
The result note separates edits you saved before Send from agent-reported work;
deferred edits do not imply that source was changed. At very short heights, the
latest-result preview puts its text first; scroll the inventory for its result
link and remaining details. No result preview, edit disclosure, or comparison
navigation saves an unsent draft.

### Storage and limits

Snapshots live in `~/.doc-review`. They can contain document content, so treat
this directory as private. Comment geometry is temporary local presentation
data, not persisted feedback or data sent to the agent.

Referenced conversations, results, receipts, history, revisions and staged assets
are retained indefinitely, not limited to five rounds or 30 days.
Unreferenced snapshots are collected at startup and periodically, with a one
hour grace period. History cannot reconstruct documents from older receipts
that had no snapshots.

| Default capture limit | Value |
| --- | --- |
| File source | 8 MiB |
| Normalized content | 4 MiB |
| Semantic blocks | 2,000 |
| Total text | 1,000,000 characters |
| Text in one block | 100,000 characters |

Comparisons have independent size, token, and edit work limits, including
1,000,000 characters and a 250 ms processing budget. A stored snapshot can exceed
comparison limits. These cases are reported as limitations, not complete
comparisons or zero changes.

## Upgrading and troubleshooting

This version requires Node **24.21.0 or newer**; Node 20, Node 22, and earlier
Node 24 patches are not supported by the compiled runtime.

The current CLI requires server protocol **23**. End active reviews and stop the
specific old server, or let it exit when idle, before restarting. Older servers
are not silently reused or forcibly replaced. Keep `.doc-review`: pending
accepted submissions and exact receipt IDs survive a controlled restart.
The new store is `conversation-state.json`; old `state.json`, history, and pasted
assets are left untouched, with no importer, migration switch, or destructive reset.

After updating the package, rerun its `setup --global` and project `setup`
commands, then reload skills or start a fresh agent session. Updating the CLI
without the instructions is not a complete upgrade.

Setup owns a marked section of project `AGENTS.md`. It migrates known generated
blocks but preserves custom guidance with a migration message. Correct invalid
or duplicate markers before running setup again. Review custom instructions
yourself if they still request automatic activation.

This fork uses `doc-review`, `/doc-review`, and `~/.doc-review`. It does not
install a `human-review` alias or migrate upstream state and skill files.
The retired `/trust` API returns 410 and old decision files are unused.

External source writes refresh the rendered baseline without clearing unsent
feedback, but do not automatically resolve conflicts. If saving reports a
conflict, review the changed source and use the offered reload action. Do not
bypass the required frame identity and source hash on save or revert requests.
