import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ConversationShell } from "../../conversation-shell";
import { projectComparison } from "../comparison/projection";
import { ComparisonView } from "./comparison";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { ChoiceMenu } from "./ui/choice-menu";
import { SegmentedControl, SegmentedControlItem } from "./ui/segmented-control";
import { Icon } from "./icon";
import { SubmissionResultNote, resultAvailability } from "./conversation-results";

type Chrome = ReturnType<ConversationShell["getSnapshot"]>;
type Snapshot = ReturnType<ConversationShell["owner"]["getSnapshot"]>;

export function ConversationComparison({ shell, chrome, snapshot }: { shell: ConversationShell; chrome: Chrome; snapshot: Snapshot }) {
  const current = chrome.comparison!;
  const root = useRef<HTMLElement>(null), header = useRef<HTMLElement>(null);
  const context = `${current.submissionId}:${current.pageKey}:${current.mode}`;
  const [selection, setSelection] = useState({ context, index: 0, scroll: false });
  const [menu, setMenu] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const projection = useMemo(() => projectComparison(current.value, current.mode), [current.value, current.mode]);
  const index = selection.context === context ? Math.min(selection.index, Math.max(0, projection.changes.length - 1)) : 0;
  const counts = { added: 0, modified: 0, removed: 0 };
  for (const change of projection.changes) counts[change.kind ?? "modified"]++;
  const choose = (submissionId = current.submissionId, pageKey = current.pageKey, mode = current.mode) =>
    void shell.commands.comparison(submissionId, pageKey, mode).catch(shell.owner.report);
  const jump = (index: number) => setSelection({ context, index, scroll: true });
  const detail = snapshot.submissions.find((item) => item.id === current.submissionId)?.value;
  const submission = detail?.submission;
  const history = snapshot.history.find((item) => item.submissionId === current.submissionId);
  const pages = submission?.pageKeys.map((key) => {
    const target = snapshot.pages.find((item) => item.page.pageKey === key)?.page.target;
    return { value: key, label: target?.kind === "file" ? target.path.split(/[\\/]/).at(-1)! : target?.url ?? "Review page" };
  }) ?? [];
  const submissions = snapshot.history.filter((item) => item.result).map((item) => ({
    value: item.submissionId, label: new Date(item.createdAt).toLocaleString(),
  }));
  useLayoutEffect(() => { setMenu(null); }, [context, chrome.comparisonOpen]);
  useLayoutEffect(() => {
    if (!selection.scroll || selection.context !== context || current.loading || !chrome.comparisonOpen) return;
    root.current?.style.setProperty("--comparison-header-height", `${header.current?.getBoundingClientRect().height ?? 0}px`);
    root.current?.querySelector(".comparison-current")?.scrollIntoView({ block: "center", behavior: "instant" });
  }, [selection, context, current.loading, chrome.comparisonOpen]);
  const disclosure = (name: string) => ({
    open: menu === name && chrome.comparisonOpen, restoreFocus: chrome.comparisonOpen,
    onOpenChange: (open: boolean) => setMenu(open ? name : null),
  });
  const value = current.value;
  const recapture = async () => {
    setCapturing(true);
    try {
      await shell.commands.recapture(current.submissionId, current.pageKey);
      const latest = shell.getSnapshot();
      if (latest.comparisonOpen && latest.comparison?.submissionId === current.submissionId &&
          latest.comparison.pageKey === current.pageKey && latest.comparison.mode === current.mode) {
        await shell.commands.comparison(current.submissionId, current.pageKey, current.mode);
      }
    } catch (cause) { shell.owner.report(cause); }
    finally { setCapturing(false); }
  };
  const view = value?.viewComparison && typeof value.viewComparison === "object" && "message" in value.viewComparison
    ? String(value.viewComparison.message) : "";
  return <section ref={root} className="conversation-comparison review-ui" aria-label="Saved comparison" hidden={!chrome.comparisonOpen}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); if (menu) setMenu(null); else shell.commands.closeComparison(); } }}>
    <div className="conversation-comparison-title"><h2>Submission result</h2>
      <Button variant="ghost" size="sm" onClick={shell.commands.closeComparison}>Close comparison</Button></div>
    {detail?.result && <SubmissionResultNote detail={detail} />}
    {history && <p className="conversation-comparison-summary">{resultAvailability(history)}</p>}
    <header ref={header} className="conversation-comparison-tools">
      <div className="changes-toolbar" role="group" aria-label="Comparison tools">
        <div className="changes-context">
          <ChoiceMenu id="submissionPicker" label="Submission" value={current.submissionId} options={submissions}
            triggerLabel={submissions.find((item) => item.value === current.submissionId)?.label ?? "Submission"} {...disclosure("submission")} onValueChange={(id) => {
              const keys = snapshot.submissions.find((item) => item.id === id)?.value.submission.pageKeys;
              const target = keys?.includes(current.pageKey) ? current.pageKey : keys?.[0];
              if (target) choose(id, target);
            }} />
          {pages.length > 1 && <ChoiceMenu id="historyTarget" label="Comparison page" value={current.pageKey} options={pages}
            triggerLabel={pages.find((item) => item.value === current.pageKey)?.label ?? "Page"} {...disclosure("page")}
            onValueChange={(key) => choose(current.submissionId, key)} />}
        </div>
        {projection.changes.length > 1 && <nav className="changes-navigation" aria-label="Change navigation">
          <Button id="previousChange" variant="outline" aria-label="Previous change" disabled={current.loading || index === 0} onClick={() => jump(index - 1)}>Previous</Button>
          <ChoiceMenu id="changeJump" label="Jump to change" value={String(index)}
            options={projection.changes.map((change, position) => ({ value: String(position), label: `${position + 1}. ${change.kind}: ${change.afterBlock?.text || change.beforeBlock?.text || change.after || change.before}` }))}
            triggerLabel={`${index + 1} of ${projection.changes.length}`} disabled={current.loading}
            {...disclosure("jump")} onValueChange={(value) => jump(Number(value))} />
          <Button id="nextChange" variant="outline" aria-label="Next change" disabled={current.loading || index === projection.changes.length - 1} onClick={() => jump(index + 1)}>Next</Button>
        </nav>}
        <div className="changes-view-tools">
          <SegmentedControl aria-label="Comparison format">
            {(["content", "source"] as const).map((mode) => <SegmentedControlItem key={mode} selected={current.mode === mode}
              onClick={() => choose(current.submissionId, current.pageKey, mode)}>{mode === "content" ? "Content" : "Source"}</SegmentedControlItem>)}
          </SegmentedControl>
          {value?.available === true && <div className="changes-counts">
            {(["added", "modified", "removed"] as const).map((kind) => <Badge key={kind} variant="outline" className={`changes-${kind}`}
              role="img" aria-label={`${counts[kind]} ${kind} changes`}>
              <Icon name={kind === "added" ? "plus" : kind === "modified" ? "pencil" : "minus"} size={14} />{counts[kind]}
            </Badge>)}
          </div>}
        </div>
      </div>
    </header>
    {current.loading && <p className="changes-controls" role="status">Loading saved comparison...</p>}
    {current.error && <div className="changes-controls" role="alert"><p>{current.error}</p>
      {value && <p>Showing the previously loaded snapshot; the refresh failed.</p>}
      <Button variant="outline" size="sm" onClick={() => choose()}>Retry comparison</Button></div>}
    {!current.loading && value?.available === false && <section className="changes-controls" aria-label="Comparison availability">
      <p>{detail?.result?.effect === "reply-only" ? "No new source changes reported. This response has no captured result comparison."
        : `Comparison unavailable: ${String(value.reason ?? "No compatible capture.")}`}</p>
      {detail?.result?.effect === "changes-reported" && <>
        <p>Availability describes the loaded snapshot. Refresh after a new capture to check this page again.</p>
        <Button size="sm" variant="outline" onClick={() => choose()}>Refresh comparison</Button>
        {current.mode === "content" && <Button size="sm" variant="outline" disabled={capturing || current.pageKey !== chrome.pageKey}
          onClick={() => { void recapture(); }}>{capturing ? "Capturing current content…" : "Capture current content"}</Button>}
        {current.mode === "content" && current.pageKey !== chrome.pageKey && <p>Open this page in Review before capturing current content.</p>}
        {chrome.captureError && <p role="alert">{chrome.captureError}</p>}
      </>}
    </section>}
    {value?.available === true && <div className={`comparison-surface comparison-${current.mode}`}>
      <ComparisonView comparison={value} mode={current.mode} comparisonKey={`${current.submissionId}:${current.pageKey}`} selectedIndex={index} />
    </div>}
    <p className="conversation-comparison-summary">The comparison starts at Send. Your earlier edits are recorded above, not counted as new agent work. Captured differences do not prove who authored them.</p>
    {value && <details className="changes-diagnostics"><summary>Comparison details</summary>
      <p>Submission: {current.submissionId} · Page: {current.pageKey}</p>
      {value.available === false && <p>{String(value.reason ?? "No compatible capture.")}</p>}
      <p className="changes-legend">{(["added", "modified", "removed"] as const).map((kind) =>
        <span key={kind} className={`changes-${kind}`}><Icon name={kind === "added" ? "plus" : kind === "modified" ? "pencil" : "minus"} />{kind}</span>)}</p>
      {view && <p>{view}</p>}
      <p>Saved snapshots, not the live layout. Historical scripts, styles and image URLs are never replayed. A handled response does not guarantee a Content capture.</p>
      {(["beforeCapturedAt", "afterCapturedAt"] as const).map((key) => typeof value[key] === "number" &&
        <p key={key}>{key === "beforeCapturedAt" ? "Before" : "After"} captured: {new Date(value[key]).toLocaleString()}</p>)}
      {Array.isArray(value.limitations) && value.limitations.length > 0 &&
        <details><summary>Comparison coverage and limits</summary><ul>{value.limitations.map((item) => <li key={String(item)}>{String(item)}</li>)}</ul></details>}
    </details>}
  </section>;
}
