import type { ConversationController } from "../../conversation-controller";
import { Badge } from "./ui/badge";
import { ConversationTime } from "./conversation-controls";
import { useState } from "react";
import type { ConversationShell } from "../../conversation-shell";
import { Button } from "./ui/button";

type Snapshot = ReturnType<ConversationController["getSnapshot"]>;
export type ResultDetail = Snapshot["submissions"][number]["value"];
type HistoryItem = Snapshot["history"][number];

export const responseOutcomeLabels = {
  applied: "Change reported", answered: "Answered", "clarification-needed": "Needs clarification", deferred: "Deferred",
};

export function editOutcomeSummary(outcome: NonNullable<ResultDetail["result"]>["editOutcomes"][number]["outcome"] | undefined) {
  return outcome === "already-saved" ? "Saved by you before Send; no additional agent edit reported."
    : outcome === "applied" ? "Agent reported applying this source-pending edit."
    : outcome === "deferred" ? "Deferred; no application reported for this edit." : "Edit outcome unavailable.";
}

export function ResultActions({ detail, shell }: { detail: ResultDetail; shell: ConversationShell }) {
  const [expanded, setExpanded] = useState(false);
  const responses = detail.result?.responses ?? [];
  const replies = responses;
  const changes = detail.result?.effect === "changes-reported";
  const [busy, setBusy] = useState(false);
  const reveal = async (threadId: string, messageId: string) => {
    setBusy(true);
    try { await shell.owner.commands.revealMessage(threadId, messageId); }
    catch (cause) { shell.owner.report(cause); }
    finally { setBusy(false); }
  };
  return <div className="conversation-result-actions">
    <div className="conversation-actions">
      {(changes || !replies.length) && <Button size="sm" onClick={() => {
        const key = detail.submission.pageKeys.includes(shell.getSnapshot().pageKey ?? "")
          ? shell.getSnapshot().pageKey! : detail.submission.pageKeys[0];
        void shell.commands.comparison(detail.submission.submissionId, key, "content").catch(shell.owner.report);
      }}>{changes ? "View changes" : "View response"}</Button>}
      {!!replies.length && <Button size="sm" variant={changes ? "ghost" : "outline"} disabled={busy}
        aria-expanded={replies.length > 1 ? expanded : undefined}
        onClick={() => replies.length === 1 ? void reveal(replies[0].threadId, replies[0].replyToMessageId) : setExpanded(value => !value)}>
        {replies.length === 1 ? "View reply" : "View replies"}
      </Button>}
    </div>
    {expanded && <ul className="conversation-result-replies">{replies.map(reply => {
      const message = detail.submission.messages.find(item => item.message.messageId === reply.replyToMessageId)?.message.body;
      return <li key={reply.messageId}><Button size="sm" variant="ghost" disabled={busy}
        onClick={() => { void reveal(reply.threadId, reply.replyToMessageId); }}>{message ?? "Open conversation"}</Button></li>;
    })}</ul>}
  </div>;
}

export function resultHeading(detail: ResultDetail) {
  const count = new Set(detail.result?.responses.map(item => item.threadId)).size;
  return detail.result?.effect === "changes-reported" ? "Agent reported changes"
    : count ? `Agent replied to ${count === 1 ? "1 conversation" : `${count} conversations`}` : "Agent response";
}

export function resultAvailability(item: HistoryItem) {
  if (item.result?.effect === "reply-only") return "Discussion only; no new changes reported.";
  return {
    "not-requested": "No result capture requested.",
    pending: "Preparing the change preview.",
    ready: "Saved comparisons available.",
    partial: "Some change previews are not ready yet.",
    failed: "The change preview couldn't be saved. The agent response is still available.",
    unavailable: "Comparison unavailable. The agent response is still available.",
  }[item.comparisonStatus];
}

export function EditEvidence({ edit }: { edit: Snapshot["edits"][number] }) {
  const content = edit.content;
  return <>
    <dl className="conversation-edit-preview">
      <div><dt>Before</dt><dd>{content.before ?? content.before_html}</dd></div>
      {content.kind === "edited" && <div><dt>After</dt><dd>{content.after ?? content.after_html}</dd></div>}
      {content.kind === "deleted" && <div><dt>After</dt><dd>Removed by you</dd></div>}
      {content.kind === "moved" && <div><dt>Position</dt><dd>After: {content.moved_after} · Before: {content.moved_before}</dd></div>}
    </dl>
    {content.truncated && <p>Incomplete capture. The agent must identify the source or clarify; it cannot apply truncated content.</p>}
    <details className="conversation-edit-details"><summary>Exact edit details</summary>
      <pre>{JSON.stringify(content, null, 2)}</pre>
      <p>{edit.source.state === "saved" ? "Already saved by you before Send." : "Source pending; recording this edit does not save it to source."}</p>
      <details><summary>Source evidence and identity</summary><pre>{JSON.stringify({ editId: edit.editId, version: edit.version, pageKey: edit.pageKey, source: edit.source }, null, 2)}</pre></details>
    </details>
  </>;
}

export function SubmissionResultNote({ detail }: { detail: ResultDetail }) {
  const result = detail.result;
  if (!result) return null;
  return <section className="conversation-result-note inventory-card" aria-label="Full submission result note">
    <div className="inventory-meta"><strong>Agent-reported result</strong><ConversationTime value={result.createdAt} /></div>
    <h2>{result.title}</h2>
    <p className="conversation-result-body">{result.body}</p>
    {result.overallOutcome && <p>Note to the agent: <Badge variant="outline">{responseOutcomeLabels[result.overallOutcome]}</Badge></p>}
    {detail.submission.edits.length > 0 && <section aria-label="Your submitted edits">
      <h3>Your submitted edits</h3>
      <p>Edits you included in this batch, separate from new agent-reported work.</p>
      <ul className="feedback-edit-list conversation-edit-list">{detail.submission.edits.map((edit) => {
        const outcome = result.editOutcomes.find((item) => item.editId === edit.editId && item.editVersion === edit.version);
        return <li key={edit.editId}>
          <div className="conversation-edit-heading"><strong className="feedback-edit-label">{edit.content.label}</strong>
            <Badge variant="outline">{edit.source.state === "saved" ? "Already saved" : "Source pending at Send"}</Badge></div>
          <p>{editOutcomeSummary(outcome?.outcome)}</p>
          {outcome && <p>{outcome.reason}</p>}
          <EditEvidence edit={edit} />
        </li>;
      })}</ul>
    </section>}
  </section>;
}
