import type { ConversationController } from "../../conversation-controller";
import { Badge } from "./ui/badge";
import { ConversationSource, ConversationTime } from "./conversation-controls";
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import type { ConversationShell } from "../../conversation-shell";
import { Button } from "./ui/button";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { Icon } from "./icon";
import { MessageMarkdown } from "./message-markdown";

type Snapshot = ReturnType<ConversationController["getSnapshot"]>;
export type ResultDetail = Snapshot["submissions"][number]["value"];
type HistoryItem = Snapshot["history"][number];
export type RevealReply = (detail: ResultDetail, index: number, trigger: HTMLButtonElement) => Promise<void>;

export const responseOutcomeLabels = {
  applied: "Change reported", answered: "Answered", "clarification-needed": "Needs clarification", deferred: "Deferred",
};

export function editOutcomeSummary(outcome: NonNullable<ResultDetail["result"]>["editOutcomes"][number]["outcome"] | undefined) {
  return outcome === "already-saved" ? "You saved this edit before sending."
    : outcome === "applied" ? "The agent says this edit has been applied."
    : outcome === "deferred" ? "The agent left this edit for later." : "No update is available for this edit.";
}

export function ResultPreview({ body, actions }: { body: string; actions: (expandControl: ReactNode) => ReactNode }) {
  const id = useId(), preview = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false), [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const node = preview.current;
    if (!node) return;
    const measure = () => {
      if (node.clientWidth) setOverflow(node.scrollHeight > 80 + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [body]);
  return <>
    <div ref={preview} id={id} className={`conversation-result-preview${expanded ? " is-expanded" : ""}`}
      onFocusCapture={() => { if (overflow) setExpanded(true); }}><MessageMarkdown body={body} /></div>
    {actions(overflow && <DisclosureTrigger expanded={expanded}
      controls={id} onClick={() => setExpanded(value => !value)}>{expanded ? "Show less" : "Read more"}</DisclosureTrigger>)}
  </>;
}

export function ResultActions({ detail, shell, onReveal, leadingAction }: {
  detail: ResultDetail; shell: ConversationShell; onReveal: RevealReply; leadingAction?: ReactNode;
}) {
  const repliesId = useId();
  const [expanded, setExpanded] = useState(false);
  const responses = detail.result?.responses ?? [];
  const replies = responses;
  const changes = detail.result?.effect === "changes-reported";
  const [busy, setBusy] = useState(false);
  const reveal = async (index: number, trigger: HTMLButtonElement) => {
    setBusy(true);
    try { await onReveal(detail, index, trigger); }
    catch (cause) { shell.owner.report(cause); }
    finally { setBusy(false); }
  };
  return <div className="conversation-result-actions">
    <div className="conversation-actions">
      {leadingAction}
      {(changes || !replies.length) && <Button size="sm" onClick={() => {
        const key = detail.submission.pageKeys.includes(shell.getSnapshot().pageKey ?? "")
          ? shell.getSnapshot().pageKey! : detail.submission.pageKeys[0];
        void shell.commands.comparison(detail.submission.submissionId, key, "content").catch(shell.owner.report);
      }}>{changes ? "View changes" : "View response"}</Button>}
      {!!replies.length && <DisclosureTrigger className="ml-auto" variant={changes ? "ghost" : "outline"} disabled={busy}
        expanded={expanded} controls={repliesId} onClick={() => setExpanded(value => !value)}>
        Replies ({replies.length})
      </DisclosureTrigger>}
    </div>
    <ul id={repliesId} hidden={!expanded} className="conversation-result-replies">{replies.map((reply, index) => {
      const submitted = detail.submission.messages.find(item => item.message.messageId === reply.replyToMessageId);
      return <li key={reply.messageId}><Button size="sm" variant="ghost" disabled={busy}
        className="h-auto w-full min-w-0 justify-between whitespace-normal py-2 text-left"
        onClick={(event) => { void reveal(index, event.currentTarget); }}>
        <span className="conversation-result-reply-label">
          {submitted && <ConversationSource target={submitted.target} />}
          <span className="conversation-result-reply-excerpt">{submitted?.message.body ?? "Open conversation"}</span>
        </span><Icon name="chevronRight" size={14} />
      </Button></li>;
    })}</ul>
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
    {content.truncated && <p>This preview is incomplete. The agent needs the full text before applying the edit.</p>}
    <details className="conversation-edit-details"><summary>Exact edit details</summary>
      <pre>{JSON.stringify(content, null, 2)}</pre>
      <p>{edit.source.state === "saved" ? "Saved directly to the document." : "Recorded for the agent to apply."}</p>
      <details><summary>Source evidence and identity</summary><pre>{JSON.stringify({ editId: edit.editId, version: edit.version, pageKey: edit.pageKey, source: edit.source }, null, 2)}</pre></details>
    </details>
  </>;
}

export function SubmissionResultNote({ detail }: { detail: ResultDetail }) {
  const result = detail.result;
  if (!result) return null;
  return <section className="conversation-result-note inventory-card" aria-label="Full submission result note">
    <div className="inventory-meta"><strong>Agent-reported result</strong><ConversationTime value={result.createdAt} /></div>
    <h2>Full response</h2>
    <MessageMarkdown className="conversation-result-body" body={result.body} />
    {result.overallOutcome && <p>Note to the agent: <Badge variant="outline">{responseOutcomeLabels[result.overallOutcome]}</Badge></p>}
  </section>;
}

export function SubmittedEdits({ detail }: { detail: ResultDetail }) {
  const result = detail.result;
  return detail.submission.edits.length > 0 && <section aria-label="Your submitted edits">
      <h3>Your submitted edits</h3>
      <p>Edits you included in this batch, separate from new agent-reported work.</p>
      <ul className="feedback-edit-list conversation-edit-list">{detail.submission.edits.map((edit) => {
        const outcome = result?.editOutcomes.find((item) => item.editId === edit.editId && item.editVersion === edit.version);
        return <li key={edit.editId}>
          <div className="conversation-edit-heading"><strong className="feedback-edit-label">{edit.content.label}</strong>
            <Badge variant="outline">{edit.source.state === "saved" ? "Already saved" : "Sent for the agent to apply"}</Badge></div>
          <p>{editOutcomeSummary(outcome?.outcome)}</p>
          {outcome && <MessageMarkdown body={outcome.reason} />}
          <EditEvidence edit={edit} />
        </li>;
      })}</ul>
    </section>;
}

export function SubmittedFeedback({ detail }: { detail: ResultDetail }) {
  return <section aria-label="Submitted feedback">
    {detail.submission.overallNote && <section><h3>Note to agent</h3><MessageMarkdown body={detail.submission.overallNote.body} /></section>}
    {detail.submission.messages.map(({ message, target }) => <section key={message.messageId}>
      <ConversationSource target={target} /><MessageMarkdown body={message.body} />
      {detail.result?.responses.filter(reply => reply.replyToMessageId === message.messageId).map(reply =>
        <section key={reply.messageId}><h4>Agent: {responseOutcomeLabels[reply.outcome]}</h4><MessageMarkdown body={reply.body} /></section>)}
    </section>)}
    {!detail.submission.messages.length && !detail.submission.overallNote && <p>This submission contained only manual edits.</p>}
  </section>;
}
