import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { FeedbackPanelController } from "../../feedback-panel-controller.js";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { DisclosureSection } from "./ui/disclosure-section";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "./ui/alert-dialog";

type Props = { runtime: FeedbackPanelController };

export function FeedbackEdits({ runtime }: Props) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const persistentStatus = state.saveError || state.saveStatus === "saving";
  const saveStatus = <p id="saveLine" className="feedback-save" data-error={state.saveError} role={state.saveError ? "alert" : "status"}>
    <span id="saveText">{state.saveText}</span>
  </p>;
  return <div id="editsBox" className="feedback-edits" hidden={!state.editCount && !state.saveError}>
    <DisclosureSection label="Edits" headingId="editsHeading" countId="editCount" contentId="editsContent"
      count={state.editCount} open={state.editsOpen} onOpenChange={runtime.commands.setEditsOpen}
      disabled={state.disabled || !!state.dialog} status={persistentStatus ? saveStatus : null}>
    <div className="feedback-edit-status">
      {!persistentStatus && saveStatus}
      <Button id="revert" variant="ghost" size="sm" className="feedback-revert"
        disabled={state.disabled || state.busy || !!state.dialog || !state.editCount}
        onClick={() => runtime.commands.open("revert")}>Revert all</Button>
    </div>
    <ul id="editList" className="feedback-edit-list">
      {state.edits.map((edit, index) => <li key={`${edit.label}-${edit.kind}-${index}`}>
        <span className="feedback-edit-label">{edit.label}</span><Badge variant="outline">{edit.kind}</Badge>
      </li>)}
    </ul>
    {state.editCount > 5 && <Button size="sm" variant="ghost" onClick={runtime.commands.expand}>
      {state.expanded ? "Show fewer" : `${state.editCount - 5} more…`}
    </Button>}
    </DisclosureSection>
  </div>;
}

export function FeedbackFooter({ runtime }: Props) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const input = useRef<HTMLTextAreaElement>(null);
  const draft = state.note;
  const update = (element: HTMLTextAreaElement, composing = draft.composing) => runtime.commands.updateNote({
    text: element.value, selectionStart: element.selectionStart, selectionEnd: element.selectionEnd, composing,
  });
  useLayoutEffect(() => {
    const element = input.current;
    if (!element || draft.composing) return;
    element.setSelectionRange(draft.selectionStart, draft.selectionEnd);
  }, [draft.selectionStart, draft.selectionEnd, draft.composing]);
  const notice = state.delivery.phase === "delivered" ? state.delivery.notice : null;
  const failure = state.delivery.phase === "failed" || state.delivery.phase === "uncertain" ? state.delivery.message : null;
  const hasSupport = !!(state.drafts || failure || notice || state.agent === "working" ||
    state.delivery.sent || state.agent === "stranded");
  return <>
    <div className="send-primary feedback-primary">
      <Label htmlFor="note">Overall note</Label>
      <Textarea ref={input} id="note" rows={2} placeholder="Overall note…" value={draft.text}
        disabled={state.disabled} aria-describedby={state.drafts ? "draftWarning" : undefined}
        onChange={(event) => update(event.currentTarget)}
        onSelect={(event) => update(event.currentTarget)}
        onCompositionStart={(event) => update(event.currentTarget, true)}
        onCompositionEnd={(event) => update(event.currentTarget, false)} />
    </div>
    <div className="send-secondary feedback-secondary" hidden={!hasSupport}>
      {state.drafts > 0 && <p id="draftWarning" className="feedback-help">
        {state.drafts} open {state.drafts === 1 ? "draft is" : "drafts are"} not included. Save comments explicitly before sending.
      </p>}
      {failure && <p className="feedback-error" role="alert">{failure}</p>}
      {notice && <p id="captureNotice" className="feedback-help" role="status">{notice}</p>}
      {state.agent === "working" && <p id="agentLine" className="feedback-help" role="status">
        <span id="agentText">Feedback delivered — page reloads when fixes land</span>
      </p>}
      {state.delivery.sent && state.agent !== "working" && state.agent !== "stranded" &&
        <p className="feedback-help" role="status">Feedback sent. Waiting for the agent.</p>}
      {state.agent === "stranded" && <section id="handoff" className="feedback-handoff">
        <h3>Sent — but no agent is listening yet.</h3>
        <p>Paste this into your agent — Claude Code, Codex, or Cursor:</p>
        <code id="handoffCmd">{state.prompt}</code>
        <Button id="handoffCopy" size="sm" variant="outline" disabled={!state.prompt || state.copyStatus === "copying"}
          onClick={() => { void runtime.commands.copy(); }}>
          {state.copyStatus === "copying" ? "Copying…" : state.copyStatus === "copied" ? "Copied" : "Copy prompt"}
        </Button>
        {state.copyStatus === "copied" && <span className="sr-only" role="status">Prompt copied</span>}
        {state.copyError && <p className="feedback-error" role="alert">{state.copyError}</p>}
      </section>}
    </div>
    <div className="feedback-actions">
      <Button id="endReview" variant="ghost" className="feedback-end" disabled={state.disabled || state.busy || !!state.dialog}
        title="Stop this review and release the waiting agent" onClick={() => runtime.commands.open("end")}>End review</Button>
      <Button id="send" className="feedback-send h-auto min-h-8 min-w-0 shrink whitespace-normal" disabled={state.sendDisabled}
        aria-busy={state.busy} onClick={() => { void runtime.commands.send(); }}>{state.sendText}</Button>
    </div>
  </>;
}

export function FeedbackConfirmation({ runtime }: Props) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const dialog = state.dialog;
  const returnTo = useRef("endReview");
  if (dialog) returnTo.current = dialog.action === "end" ? "endReview" : "revert";
  return <AlertDialog open={!!dialog && !state.ended} onOpenChange={(open) => { if (!open) runtime.commands.cancel(); }}>
    <AlertDialogContent onEscapeKeyDown={(event) => {
      event.stopPropagation();
      if (dialog?.pending) event.preventDefault();
    }} onCloseAutoFocus={(event) => {
      event.preventDefault();
      const target = document.getElementById(returnTo.current);
      const fallback = document.getElementById("commentsSection");
      if (target && !target.closest("[hidden], [inert]") && !(target as HTMLButtonElement).disabled) target.focus();
      else if (fallback && !fallback.closest("[inert]")) fallback.focus();
    }}>
      <AlertDialogHeader>
        <AlertDialogTitle>{dialog?.action === "revert" ? "Revert all edits?" : "End this review?"}</AlertDialogTitle>
        <AlertDialogDescription>{dialog?.description}</AlertDialogDescription>
      </AlertDialogHeader>
      {dialog?.stale && !dialog.pending && <p className="feedback-error" role="alert">The page or feedback changed. Cancel and review the current state before trying again.</p>}
      {dialog?.error && <p className="feedback-error" role="alert">{dialog.error}</p>}
      {dialog?.pending && <p role="status">{dialog.action === "end" ? "Ending review…" : "Reverting edits…"}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={dialog?.pending} onClick={(event) => {
          event.preventDefault(); runtime.commands.cancel();
        }}>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" disabled={dialog?.pending || dialog?.stale}
          onClick={(event) => { event.preventDefault(); void runtime.commands.confirm(); }}>
          {dialog?.action === "revert" ? "Revert all" : "End review"}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
