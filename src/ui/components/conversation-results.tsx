import type { ConversationController } from "../../conversation-controller";
import { Badge } from "./ui/badge";
import { ConversationTime } from "./conversation-controls";

type Snapshot = ReturnType<ConversationController["getSnapshot"]>;
export type ResultDetail = Snapshot["submissions"][number]["value"];
type HistoryItem = Snapshot["history"][number];

export function resultAvailability(item: HistoryItem) {
  if (item.result?.effect === "reply-only") return "No new source changes reported.";
  return {
    "not-requested": "No result capture requested.",
    pending: "Result capture pending.",
    ready: "Saved comparisons available.",
    partial: "Some comparisons are available; capture is incomplete.",
    failed: "Result capture failed. The agent response is still available.",
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
    {result.overallOutcome && <p>Overall note: <Badge variant="outline">{result.overallOutcome}</Badge></p>}
    {detail.submission.edits.length > 0 && <section aria-label="Your submitted edits">
      <h3>Your submitted edits</h3>
      <p>These are your recorded edits. Saved differences alone do not establish who changed the source.</p>
      <ul className="feedback-edit-list conversation-edit-list">{detail.submission.edits.map((edit) => {
        const outcome = result.editOutcomes.find((item) => item.editId === edit.editId && item.editVersion === edit.version);
        return <li key={edit.editId}>
          <div className="conversation-edit-heading"><strong className="feedback-edit-label">{edit.content.label}</strong>
            <Badge variant="outline">{edit.source.state === "saved" ? "Already saved" : "Source pending at Send"}</Badge></div>
          <p>{outcome?.outcome === "already-saved" ? "Saved by you before Send; no additional agent edit reported."
            : outcome?.outcome === "applied" ? "Agent reported applying this source-pending edit."
            : outcome?.outcome === "deferred" ? "Deferred; no application reported for this edit." : "Edit outcome unavailable."}</p>
          {outcome && <p>{outcome.reason}</p>}
          <EditEvidence edit={edit} />
        </li>;
      })}</ul>
    </section>}
  </section>;
}
