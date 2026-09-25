import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ConversationShell } from "../../conversation-shell.js";
import type { ConversationController, ConversationDraft } from "../../conversation-controller.js";
import { intentBadge } from "../../contracts/feedback.js";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Textarea } from "./ui/textarea";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from "./ui/alert-dialog";
import { ConversationComparison } from "./conversation-comparison";
import { ToolbarControls } from "./toolbar";
import { ChoiceMenu } from "./ui/choice-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { Checkbox } from "./ui/checkbox";
import { Icon } from "./icon";
import { ConversationAuthor, ConversationMenu, ConversationTime } from "./conversation-controls";
import { EditEvidence, resultAvailability } from "./conversation-results";
import { SegmentedControl, SegmentedControlItem } from "./ui/segmented-control";

type Snapshot = ReturnType<ConversationController["getSnapshot"]>;
type Thread = Snapshot["threads"][number];
function act(owner: ConversationController, action: () => unknown) {
  try { Promise.resolve(action()).catch(owner.report); } catch (cause) { owner.report(cause); }
}
function time(value: number) { return new Date(value).toLocaleString(); }
function ResponsiveNote({ composing, hasText, children }: { composing: boolean; hasText: boolean; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const open = expanded || composing;
  return <div className="conversation-note-region" data-compact="true">
    <Button className="conversation-note-toggle" variant="ghost" size="sm" disabled={composing}
      aria-expanded={open} aria-controls="conversationNoteDetails" onClick={() => setExpanded(value => !value)}>
      <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
      Overall note (optional){hasText && <Badge variant="secondary">Draft</Badge>}
    </Button>
    <div className="conversation-note-content" id="conversationNoteDetails" hidden={!open}>{children}</div>
  </div>;
}
function rememberExchange(owner: ConversationController, id: string, transcript: HTMLElement, container: HTMLElement) {
  const bounds = container.getBoundingClientRect();
  const visible = [...transcript.querySelectorAll<HTMLElement>("[data-message]")].find((element) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > bounds.top + 1 && rect.top < bounds.bottom;
  });
  if (visible?.dataset.message) owner.rememberReadingAnchor(id, {
    messageId: visible.dataset.message, offset: visible.getBoundingClientRect().top - bounds.top,
  });
}
function Draft({ owner, id, draft, disabled, saving }: { owner: ConversationController; id: string; draft: Readonly<ConversationDraft>; disabled: boolean; saving: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const cancelling = state.draftCancellation === id;
  const selection = useRef({ start: 0, end: 0 });
  useLayoutEffect(() => {
    if (id !== "note" && !disabled) {
      input.current?.focus({ preventScroll: true });
      input.current?.setSelectionRange(draft.selectionStart, draft.selectionEnd);
    }
  }, []); // The editor stays mounted across collapse, filters, Feedback and Focus.
  useLayoutEffect(() => {
    if (id === "note" || id === "new" || state.host !== "feedback" || !state.open) return;
    const field = input.current, inventory = field?.closest<HTMLElement>(".conversation-inventory");
    if (!field || !inventory) return;
    const preserveReading = !!owner.readingAnchor(id);
    let width = preserveReading ? inventory.clientWidth : -1, height = preserveReading ? inventory.clientHeight : -1;
    const observer = new ResizeObserver(() => {
      if (!inventory.clientHeight || !inventory.clientWidth ||
          (width === inventory.clientWidth && height === inventory.clientHeight)) return;
      width = inventory.clientWidth; height = inventory.clientHeight;
      const bounds = inventory.getBoundingClientRect(), editor = field.getBoundingClientRect();
      const composer = field.closest(".conversation-composer")!.getBoundingClientRect();
      if (!editor.height || editor.top < bounds.top || composer.top >= bounds.bottom) return;
      const firstLine = Math.min(36, editor.height);
      if (editor.top + firstLine > bounds.bottom) inventory.scrollTop += editor.top + firstLine - bounds.bottom;
    });
    observer.observe(inventory);
    return () => observer.disconnect();
  }, [id, state.host, state.open]);
  const label = id === "note" ? "Overall note" : id === "new" ? "New message" : draft.messageId ? "Edit message" : "Reply";
  return <div className="conversation-composer" data-composer={id} onKeyDown={(event) => {
    if (id === "note" || event.key !== "Escape" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || draft.composing) return;
    event.stopPropagation(); event.preventDefault();
    owner.commands.cancelDraft(id);
  }}>
    {id === "note" ? <label htmlFor={`draft-${id}`}>{label}</label> : <div className={id === "new" ? "sr-only" : "conversation-composer-heading"}>
      <label htmlFor={`draft-${id}`}>{label}</label>
      {id !== "new" && !disabled && <Button variant="ghost" size="icon-xs"
        aria-label={`Close ${draft.messageId ? "edit" : "reply"}`} disabled={saving || draft.composing}
        onClick={() => owner.commands.cancelDraft(id)}><Icon name="x" /></Button>}
    </div>}
    <Textarea ref={input} className="min-h-9" id={`draft-${id}`} rows={id === "note" ? 2 : undefined}
      placeholder={id === "note" ? "Overall note…" : undefined} value={draft.text} readOnly={disabled}
      onChange={(event) => owner.commands.update(id, { text: event.target.value, selectionStart: event.target.selectionStart, selectionEnd: event.target.selectionEnd })}
      onSelect={(event) => owner.commands.update(id, { selectionStart: event.currentTarget.selectionStart, selectionEnd: event.currentTarget.selectionEnd })}
      onBlur={(event) => owner.commands.update(id, { selectionStart: event.currentTarget.selectionStart, selectionEnd: event.currentTarget.selectionEnd })}
      onCompositionStart={() => owner.commands.update(id, { composing: true })}
      onCompositionEnd={(event) => owner.commands.update(id, { composing: false, text: event.currentTarget.value })}
      onKeyDown={(event) => {
        if (id === "note" || disabled || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || draft.composing) return;
        if (event.key !== "Enter" && event.key !== "Escape") return;
        if (event.key === "Enter" && event.shiftKey) return;
        event.stopPropagation();
        event.preventDefault();
        if (saving) return;
        if (event.key === "Escape") owner.commands.cancelDraft(id);
        else act(owner, () => owner.commands.saveDraft(id));
      }}
    />
    {!disabled && <div className="conversation-composer-actions">
      <label className="conversation-intent"><Checkbox checked={draft.intent === "request-change"}
        onCheckedChange={(checked) => owner.commands.update(id, { intent: checked === true ? "request-change" : "discuss" })} />Request a change</label>
      {id !== "note" && <TooltipProvider><Tooltip><TooltipTrigger asChild>
        <Button aria-describedby={`save-help-${id}`} disabled={saving || !draft.text.trim() || draft.composing}
          onClick={() => act(owner, () => owner.commands.saveDraft(id))}>Save</Button>
      </TooltipTrigger><TooltipContent>Enter to save · Shift+Enter for a new line. Save does not send.</TooltipContent></Tooltip></TooltipProvider>}
      {id !== "note" && <span className="sr-only" id={`save-help-${id}`}>Enter to save. Shift+Enter for a new line. Save does not send; choose Send in Feedback.</span>}
    </div>}
    <AlertDialog open={cancelling} onOpenChange={(open) => { if (!open) owner.commands.keepEditing(); }}>
      <AlertDialogContent onOpenAutoFocus={() => {
        selection.current = { start: input.current?.selectionStart ?? draft.selectionStart, end: input.current?.selectionEnd ?? draft.selectionEnd };
      }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          input.current?.focus({ preventScroll: true });
          input.current?.setSelectionRange(selection.current.start, selection.current.end);
        }}>
        <AlertDialogHeader><AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>Your unsaved text and permission changes will be discarded. Saved feedback is not removed.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel onClick={owner.commands.keepEditing}>Keep editing</AlertDialogCancel>
          <Button disabled={saving || draft.composing} variant="destructive" onClick={owner.commands.discardDraft}>Discard</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
function NewMessage({ shell, snapshot, chrome }: {
  shell: ConversationShell; snapshot: Snapshot; chrome: ReturnType<ConversationShell["getSnapshot"]>;
}) {
  const element = useRef<HTMLDivElement>(null);
  const contextual = snapshot.host === "compose";
  useLayoutEffect(() => {
    if (contextual && snapshot.open && snapshot.review?.state === "open") {
      element.current?.querySelector("textarea")?.focus({ preventScroll: true });
    }
  }, [contextual, snapshot.open]);
  useLayoutEffect(() => {
    if (!contextual || !element.current) return;
    const node = element.current;
    const measure = () => shell.commands.measureComposer(node.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [contextual, shell]);
  useLayoutEffect(() => {
    if (snapshot.host !== "feedback" || !snapshot.open || chrome.comparisonOpen || snapshot.focusId) return;
    const field = element.current?.querySelector("textarea");
    const inventory = element.current?.closest<HTMLElement>(".conversation-inventory");
    if (!field || !inventory) return;
    let width = -1, height = -1;
    const revealOnResize = () => {
      const nextWidth = inventory.clientWidth, nextHeight = inventory.clientHeight;
      if (!nextWidth || !nextHeight || (width === nextWidth && height === nextHeight)) return;
      width = nextWidth; height = nextHeight;
      const top = inventory.getBoundingClientRect().top + inventory.clientTop;
      const editor = field.getBoundingClientRect();
      if (editor.top < top || editor.bottom > top + height) {
        inventory.scrollTop += editor.top - top;
      }
    };
    // A host/space change reveals the draft, without moving keyboard focus.
    // Ordinary renders and deliberate inventory scrolling do not reset its position.
    revealOnResize();
    const observer = new ResizeObserver(revealOnResize); observer.observe(inventory);
    return () => observer.disconnect();
  }, [snapshot.host, snapshot.open, snapshot.focusId, chrome.comparisonOpen]);
  const item = snapshot.newMessage;
  if (!item) return null;
  const edge = chrome.composerRelation === "above" || chrome.composerRelation === "below";
  return <div ref={element} className="conversation-new-message" hidden={!!snapshot.focusId}>
    <header className="compose-head">
      <strong>Add comment</strong>
      <Button variant="ghost" size="icon" aria-label="Close comment" title="Close comment"
        disabled={snapshot.busy || !!snapshot.uncertain || snapshot.savingDraftIds.includes("new") || item.draft.composing || snapshot.review?.state !== "open"}
        onClick={() => shell.owner.commands.cancelDraft("new")}><Icon name="x" /></Button>
    </header>
    {chrome.composerNotice && <p className="conversation-notice" role="status">{chrome.composerNotice}</p>}
    <div className="contextual-direction" hidden={!edge}>
      {edge && <span>{item.target.kind === "selection" ? "Selection" : "Element"} is {chrome.composerRelation}</span>}
      {edge && <Button size="xs" variant="ghost" onClick={shell.commands.revealSelection}>Back to selection</Button>}
    </div>
    <blockquote className="conversation-new-target quote" data-new-target-kind={item.target.kind}>
      {item.target.kind === "selection" ? item.target.anchor.quote : item.target.anchor.label ?? item.target.anchor.selector}
    </blockquote>
    <Draft owner={shell.owner} id="new" draft={item.draft} disabled={snapshot.review?.state !== "open"}
      saving={snapshot.busy || !!snapshot.uncertain || snapshot.savingDraftIds.includes("new")} />
  </div>;
}
function ThreadCard({ owner, item, snapshot, shell, chrome }: {
  owner: ConversationController; item: Thread; snapshot: Snapshot; shell: ConversationShell;
  chrome: ReturnType<ConversationShell["getSnapshot"]>;
}) {
  const id = item.thread.threadId, focus = snapshot.focusId === id;
  const adjacent = focus && snapshot.host === "adjacent";
  const target = chrome.anchorViews[id] ?? { canJump: false, offscreen: false, reason: "Checking the target." };
  const peers = chrome.anchorPeers[id] ?? [id];
  const disabled = snapshot.review?.state !== "open" || !!snapshot.uncertain || snapshot.busy;
  const transcript = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null), previousDraft = useRef(item.draft);
  const focusAfterDraft = useRef<Readonly<ConversationDraft> | null>(null);
  useLayoutEffect(() => {
    const previous = previousDraft.current;
    previousDraft.current = item.draft;
    if (previous && !item.draft) focusAfterDraft.current = previous;
    if (item.draft || disabled) return;
    const completed = focusAfterDraft.current;
    focusAfterDraft.current = null;
    if (!completed || document.activeElement !== document.body) return;
    const buttons = [...(article.current?.querySelectorAll<HTMLButtonElement>("button[data-edit-message]") ?? [])];
    const trigger = completed.messageId ? buttons.find((button) => button.dataset.editMessage === completed.messageId)
      : article.current?.querySelector<HTMLButtonElement>("button[data-reply]");
    trigger?.focus({ preventScroll: true });
  }, [item.draft, disabled]);
  const wasFocused = useRef(focus);
  useLayoutEffect(() => {
    const element = transcript.current;
    const previousFocus = wasFocused.current;
    wasFocused.current = focus;
    if (!element || !snapshot.open || (snapshot.focusId && !focus) || (!focus && !previousFocus)) return;
    if (focus !== previousFocus) element.scrollTop = focus ? owner.readingPosition(id, "focus") : 0;
    const anchor = owner.readingAnchor(id);
    const container = focus ? element : element.closest<HTMLElement>(".conversation-inventory");
    const message = anchor && [...element.querySelectorAll<HTMLElement>("[data-message]")].find((item) => item.dataset.message === anchor.messageId);
    if (container && message && anchor) container.scrollTop += message.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset;
  }, [focus, snapshot.host, chrome.adjacent?.width, chrome.adjacent?.height]);
  const quote = item.thread.target.kind === "selection" ? item.thread.target.anchor.quote : item.thread.target.anchor.label || item.thread.target.anchor.selector;
  const trailingTargetNotice = !!item.draft && !focus && chrome.viewport.width <= 480 && chrome.viewport.height <= 550;
  const replyControl = !item.draft && !disabled && item.thread.status === "open" &&
    <Button variant="outline" size="sm" data-reply onClick={() => owner.commands.reply(id)}>Reply</Button>;
  const peersControl = peers.length > 1 && <label className="conversation-peers"><span>{peers.length} conversations at this target</span>
    <select aria-label="Conversation at this target" value={id} onChange={(event) => {
      if (adjacent) act(owner, () => shell.commands.adjacent(event.target.value));
      else owner.commands.focus(event.target.value);
    }}>{peers.map((peer, index) => {
      const thread = snapshot.threads.find((item) => item.thread.threadId === peer);
      return <option key={peer} value={peer}>{index + 1}: {thread?.latestExchange?.reviewer.body.slice(0, 60) || "Conversation"} · {thread?.thread.status}</option>;
    })}</select>
  </label>;
  return <article ref={article} className={`conversation-thread inventory-card${focus ? " focused" : ""}`} data-thread={id}
    hidden={snapshot.host === "compose" || (snapshot.focusId ? !focus : !snapshot.filters[item.thread.status])}>
    <header>
      {(!adjacent || !!target.reason) && <Button variant="ghost" size="xs" className="conversation-thread-title justify-start rounded-none border-l-2 border-l-border font-normal text-muted-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground" aria-expanded={item.expanded} aria-controls={`thread-${id}`}
        onMouseDown={(event) => event.preventDefault()} onClick={() => owner.commands.collapse(id)}>
        <Icon name={item.expanded ? "chevronDown" : "chevronRight"} size={14} />
        <span className="conversation-target-quote" title={quote}>{quote}</span>
      </Button>}
      <div className="conversation-thread-actions">
      {item.thread.status === "resolved" && <Badge variant="secondary">Resolved</Badge>}
      <Button size="icon-xs" variant="ghost" className="conversation-icon" title={focus && !adjacent ? "Back to Feedback" : "Focus"}
        aria-label={focus && !adjacent ? "Back to Feedback" : "Focus"} onMouseDown={(event) => event.preventDefault()}
        onClick={() => owner.commands.focus(focus && !adjacent ? null : id)}><Icon name="messages" /></Button>
      <Button variant="ghost" size="xs" className="conversation-jump" hidden={adjacent && !target.reason} disabled={!target.canJump}
          aria-label="Jump to" aria-describedby={target.reason ? `target-status-${id}` : undefined} title={target.reason || "Jump to the exact passage"}
          onMouseDown={(event) => event.preventDefault()} onClick={() => act(owner, () => owner.commands.jump(id))}>
          <Icon name="locate" />Jump to</Button>
      <ConversationMenu actions={[
        ...(adjacent && !target.reason ? [{ label: item.expanded ? "Collapse conversation" : "Expand conversation",
          run: () => owner.commands.collapse(id) }] : []),
        { label: item.thread.status === "resolved" ? "Reopen" : "Resolve", disabled, run: () => act(owner, () => owner.commands.confirm("resolve", id)) },
        ...(!adjacent && chrome.viewport.width >= 900 && chrome.viewport.height >= 452 ? [{
          label: "Beside target", disabled: !target.canJump || target.offscreen || item.thread.pageKey !== chrome.pageKey,
          run: () => act(owner, () => shell.commands.adjacent(id)),
        }] : []),
        ...(adjacent ? [{ label: "Back to Feedback", run: () => owner.commands.focus(null) }] : []),
        ...(item.messageCount === item.pendingMessageCount ? [{ label: "Delete thread", disabled, destructive: true,
          run: () => act(owner, () => owner.commands.confirm("delete", id)) }] : []),
      ]} />
      {focus && <Button size="icon-xs" variant="ghost" className="conversation-icon" aria-label="Close conversation" title="Close conversation"
        onMouseDown={(event) => event.preventDefault()} onClick={() => owner.commands.open(false)}><Icon name="x" /></Button>}
      {item.attention && <Button className="conversation-activity" size="xs" variant="secondary" onClick={() => owner.commands.markRead(id)}>New activity</Button>}
      </div>
      {adjacent && peersControl}
    </header>
    <div id={`thread-${id}`} className="conversation-thread-content" hidden={!item.expanded}>
      <div className="conversation-transcript" ref={transcript} onScroll={() => {
        if (focus && transcript.current) {
          owner.rememberReadingPosition(id, "focus", transcript.current.scrollTop);
          rememberExchange(owner, id, transcript.current, transcript.current);
        }
      }}>
        {item.messageCount > item.exchanges.length && <Button size="sm" variant="outline" onClick={() => {
          const element = focus ? transcript.current : transcript.current?.closest<HTMLElement>(".conversation-inventory");
          const previousHeight = element?.scrollHeight ?? 0, previousTop = element?.scrollTop ?? 0;
          act(owner, async () => {
            await owner.commands.earlier(id);
            requestAnimationFrame(() => {
              if (element && element.scrollTop === previousTop) element.scrollTop = previousTop + element.scrollHeight - previousHeight;
            });
          });
        }}>Load earlier</Button>}
        {item.exchanges.map(({ reviewer, response }, index) => <section className="conversation-exchange" key={reviewer.messageId} data-message={reviewer.messageId}>
          <div className="conversation-meta inventory-meta"><ConversationAuthor role="You" /><ConversationTime value={reviewer.createdAt} />
            {reviewer.intent === "request-change" && <Badge variant="outline">{intentBadge(reviewer.intent)}</Badge>}
            {reviewer.submissionId === null && <Badge variant="secondary">{snapshot.review?.state === "ended" ? "Saved unsent · read-only" : "Pending"}</Badge>}
          </div>
          <p className="conversation-body">{reviewer.body}</p>
          {reviewer.submissionId === null && !disabled && <div className="conversation-actions">
            <label><Checkbox aria-label="Send message" checked={!snapshot.excluded.includes(reviewer.messageId)}
              onCheckedChange={(checked) => owner.commands.select(reviewer.messageId, checked === true)} />Include in Send</label>
            <Button size="icon-xs" variant="ghost" className="conversation-icon" aria-label="Edit message" title="Edit message"
              data-edit-message={reviewer.messageId} onClick={() => act(owner, () => owner.commands.edit(reviewer))}><Icon name="pencil" /></Button>
            {index === item.exchanges.length - 1 && replyControl}
          </div>}
          {response && <div className="conversation-response"><div className="conversation-meta inventory-meta"><ConversationAuthor role="Agent" /><ConversationTime value={response.createdAt} />
            {response.outcome !== "answered" && <Badge variant="outline">{response.outcome}</Badge>}</div><p className="conversation-body">{response.body}</p></div>}
        </section>)}
        {item.exchanges.at(-1)?.reviewer.submissionId !== null && replyControl}
        {target.reason && !trailingTargetNotice && <p id={`target-status-${id}`} className="conversation-target-status">{target.reason}</p>}
        {!adjacent && peersControl && <details className="conversation-target-details"><summary>Conversations at this target ({peers.length})</summary>{peersControl}</details>}
      </div>
      {item.draft && <Draft owner={owner} id={id} draft={item.draft} disabled={snapshot.review?.state !== "open"}
        saving={snapshot.busy || !!snapshot.uncertain || snapshot.savingDraftIds.includes(id)} />}
      {target.reason && trailingTargetNotice && <p id={`target-status-${id}`} className="conversation-target-status">{target.reason}</p>}
    </div>
  </article>;
}
function History({ snapshot, shell }: { snapshot: Snapshot; shell: ConversationShell }) {
  const owner = shell.owner;
  return <section className="conversation-history"><h3>Submissions and results</h3>
    {snapshot.history.map((item) => {
      const detail = snapshot.submissions.find((entry) => entry.id === item.submissionId)?.value;
      return <details key={item.submissionId} open={item.result ? undefined : true} className="conversation-submission">
        <summary>{time(item.createdAt)} · {item.state}</summary>
        <details><summary>Receipt details</summary><small>{item.submissionId}</small></details>
        {detail?.submission.overallNote && <section><h4>Submitted overall note {detail.submission.overallNote.intent === "request-change" && <Badge variant="outline">{intentBadge(detail.submission.overallNote.intent)}</Badge>}</h4>
          <p>{detail.submission.overallNote.body}</p></section>}
        {item.result && <section className="conversation-result"><h4>{item.result.title}</h4><p>{item.result.body}</p></section>}
        {detail?.result?.editOutcomes.map((outcome) => <p key={outcome.editId}>{outcome.outcome}: {outcome.reason}</p>)}
        {item.state === "abandoned" && <p role="status">Abandoned. External source work may still have happened; check the source. No undo or cancellation is guaranteed.</p>}
        {(item.state === "queued" || item.state === "delivered") && <Button variant="outline" disabled={snapshot.busy || !!snapshot.uncertain}
          onClick={() => owner.commands.confirm("abandon", item.submissionId)}>Abandon submission</Button>}
        {item.result && <p>{resultAvailability(item)}</p>}
        {detail?.submission.pageKeys.map((key) => item.result && <span className="conversation-actions" key={key}>
          <Button variant="ghost" size="sm" onClick={() => act(owner, () => shell.commands.comparison(item.submissionId, key, "content"))}>Content changes</Button>
          <Button variant="ghost" size="sm" onClick={() => act(owner, () => shell.commands.comparison(item.submissionId, key, "source"))}>Source changes</Button>
          {item.result.effect === "changes-reported" && ["pending", "partial", "failed", "unavailable"].includes(item.comparisonStatus) &&
            <Button variant="ghost" size="sm" onClick={() => act(owner, () => shell.commands.recapture(item.submissionId, key))}>Capture current content</Button>}
        </span>)}
      </details>;
    })}
    {snapshot.historyCursor && <Button variant="outline" onClick={() => act(owner, owner.commands.historyEarlier)}>Load earlier submissions</Button>}
  </section>;
}
function LatestResult({ snapshot, shell }: { snapshot: Snapshot; shell: ConversationShell }) {
  const latest = snapshot.history.find((item) => item.result);
  if (!latest?.result) return null;
  const detail = snapshot.submissions.find((item) => item.id === latest.submissionId)?.value;
  const key = detail?.submission.pageKeys.includes(shell.getSnapshot().pageKey ?? "")
    ? shell.getSnapshot().pageKey : detail?.submission.pageKeys[0];
  return <section className="conversation-result-peek inventory-card" aria-label="Latest submission result">
    <div className="conversation-result-peek-heading"><h3>{latest.result.title}</h3>
      <span className="inventory-meta">Latest · Agent</span><ConversationTime value={latest.result.createdAt} /></div>
    <p className="conversation-result-preview">{latest.result.body}</p>
    <div className="conversation-actions">
      <Button size="sm" disabled={!detail?.result || !key} onClick={() => act(shell.owner,
        () => shell.commands.comparison(latest.submissionId, key!, "content"))}>View in Changes</Button>
      {detail?.result && <span>{detail.result.responses.length} thread replies</span>}
    </div>
    {!detail && <Button size="sm" variant="ghost" onClick={() => act(shell.owner, shell.owner.commands.refresh)}>Refresh result details</Button>}
  </section>;
}
export function ConversationApp({ shell }: { shell: ConversationShell }) {
  const owner = shell.owner;
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const chrome = useSyncExternalStore(shell.subscribe, shell.getSnapshot);
  const inventory = useRef<HTMLDivElement>(null), priorFocus = useRef(snapshot.focusId);
  const wasOpen = useRef(snapshot.open), confirmationTrigger = useRef<HTMLElement | null>(null);
  const [restoreConfirmationFocus, setRestoreConfirmationFocus] = useState(false);
  const [commentsExpanded, setCommentsExpanded] = useState(true);
  const [editsExpanded, setEditsExpanded] = useState(true);
  const contextual = snapshot.host === "compose" && !!snapshot.newMessage;
  const composerBounds = chrome.composer && {
    left: chrome.composer.left, top: chrome.composer.top, width: chrome.composer.width, height: chrome.composer.height,
  };
  const overlayVisible = snapshot.open && !chrome.comparisonOpen && snapshot.host !== "adjacent" && !contextual;
  useLayoutEffect(() => {
    const stage = document.querySelector<HTMLElement>(".stage");
    if (!stage) return;
    const previous = stage.inert;
    stage.inert = overlayVisible;
    return () => { stage.inert = previous; };
  }, [overlayVisible]);
  useLayoutEffect(() => {
    if (!restoreConfirmationFocus || snapshot.busy || snapshot.confirmation) return;
    const trigger = confirmationTrigger.current;
    (trigger?.isConnected && !trigger.hasAttribute("disabled") ? trigger :
      document.querySelector<HTMLButtonElement>(".conversation-panel:not([hidden]) .conversation-thread:not([hidden]) .conversation-thread-title") ??
        document.getElementById("commentsButton"))?.focus({ preventScroll: true });
    setRestoreConfirmationFocus(false);
  }, [restoreConfirmationFocus, snapshot.busy, snapshot.confirmation]);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [statusTooltipOpen, setStatusTooltipOpen] = useState(false);
  const statusTrigger = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!statusTooltipOpen) return;
    // Radix's hover grace tracks parent pointermove, which stops inside an iframe.
    const enteredFrame = (event: PointerEvent) => {
      if (event.target instanceof HTMLIFrameElement && document.activeElement !== statusTrigger.current) setStatusTooltipOpen(false);
    };
    document.addEventListener("pointerover", enteredFrame, true);
    return () => document.removeEventListener("pointerover", enteredFrame, true);
  }, [statusTooltipOpen]);
  const modeFocus = useRef(true);
  useEffect(() => {
    const close = () => { modeFocus.current = false; setModeMenuOpen(false); setPageMenuOpen(false); };
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, []);
  useEffect(() => {
    if (chrome.loading || chrome.comparisonOpen || snapshot.review?.state === "ended") {
      modeFocus.current = false; setModeMenuOpen(false); setPageMenuOpen(false);
    }
  }, [chrome.loading, chrome.comparisonOpen, snapshot.review?.state]);
  useLayoutEffect(() => {
    document.body.classList.toggle("comparing", chrome.comparisonOpen);
    return () => document.body.classList.remove("comparing");
  }, [chrome.comparisonOpen]);
  useLayoutEffect(() => {
    if (wasOpen.current && !snapshot.open) document.getElementById("commentsButton")?.focus({ preventScroll: true });
    if (!wasOpen.current && snapshot.open && !snapshot.focusId && inventory.current) {
      inventory.current.scrollTop = owner.readingPosition("inventory", "feedback");
    }
    wasOpen.current = snapshot.open;
  }, [snapshot.open]);
  useLayoutEffect(() => {
    document.body.dataset.conversationPane = snapshot.open ? "open" : "closed";
    document.body.dataset.conversationHost = snapshot.host;
    document.body.dataset.conversationCompact = String(chrome.viewport.width < 900);
    document.body.dataset.conversationShort = String(chrome.viewport.height <= 550);
  }, [snapshot.open, snapshot.host, chrome.viewport.width, chrome.viewport.height]);
  // Keep presentation flags stable while child layout effects restore reading anchors.
  useLayoutEffect(() => () => {
    delete document.body.dataset.conversationPane; delete document.body.dataset.conversationCompact;
    delete document.body.dataset.conversationHost; delete document.body.dataset.conversationShort;
  }, []);
  useLayoutEffect(() => {
    if (priorFocus.current === snapshot.focusId) return;
    if (inventory.current) {
      if (!snapshot.focusId && !owner.readingAnchor(priorFocus.current ?? "")) inventory.current.scrollTop = owner.readingPosition("inventory", "feedback");
    }
    priorFocus.current = snapshot.focusId;
  }, [snapshot.focusId]);
  const readonly = snapshot.review?.state !== "open";
  const disabled = readonly || snapshot.busy || !!snapshot.uncertain;
  const work = snapshot.status?.work;
  const status = !snapshot.review ? "Loading review" : readonly ? "Review ended" : work ? "Waiting for agent" : "Reviewing";
  const workDetails = work ? work.state === "queued" ? "Queued; not received" : "Received; delivery is not evidence of an active agent" : "";
  const statusDetails = [
    !snapshot.review ? "Loading the shared review." : readonly
      ? `This shared review has ended. Saved-unsent messages and edits remain read-only here.${work ? " Accepted work can still finish; ending the review does not cancel it." : ""}`
      : work ? "Feedback has been submitted and is waiting for an agent response."
      : "Review the page, add feedback, or switch to Edit. Saved feedback is not sent until you choose Send.",
    workDetails && `${workDetails}.`,
    chrome.save.status === "saved" ? "Source saved." : chrome.save.status === "saving" ? "Saving source." : null,
  ].filter(Boolean).join(" ");
  const outsideFeedback = !snapshot.open || chrome.comparisonOpen || contextual;
  const globalErrors = outsideFeedback ? [snapshot.error, chrome.sourceError && `Source: ${chrome.sourceError}`, chrome.connectionError].filter(Boolean) : [];
  const globalUncertain = outsideFeedback && snapshot.uncertain;
  const needsSourceRecovery = chrome.reloadPending || !!chrome.sourceError || (chrome.loading && !!snapshot.error);
  const showRecovery = globalErrors.length > 0 || globalUncertain || !snapshot.connected ||
    chrome.themeSync.status === "failed" || needsSourceRecovery;
  const paneTop = Math.max(chrome.viewport.top, chrome.contentTop);
  const paneWidth = chrome.viewport.width <= 720 ? chrome.viewport.width : Math.min(380, chrome.viewport.width - 32);
  const fallbackBounds = {
    left: chrome.viewport.left + chrome.viewport.width - paneWidth, top: paneTop,
    width: paneWidth, height: Math.max(0, chrome.viewport.top + chrome.viewport.height - paneTop),
  };
  const selection = snapshot.selection;
  const selectionDescription = selection
    ? `${selection.messages} saved messages · ${selection.edits} pending edits${selection.note ? " · 1 overall note" : ""} selected`
    : snapshot.loading ? "Checking pending feedback…" : "Pending selection unavailable. Refresh the review.";
  const panel = <aside aria-label={contextual ? "Add comment" : "Feedback"} data-host={snapshot.host}
    className={`conversation-panel review-ui${snapshot.focusId ? " has-focus" : ""}${contextual ? ` is-composing contextual-compose ${chrome.composer?.kind ?? ""}` : ""}${snapshot.host === "adjacent" && chrome.adjacent ? " is-adjacent" : ""}`}
    style={{ ...(contextual && composerBounds ? composerBounds : snapshot.host === "adjacent" && chrome.adjacent ? chrome.adjacent : fallbackBounds), right: "auto", bottom: "auto" }}
    hidden={!snapshot.open || chrome.comparisonOpen} inert={!snapshot.open || chrome.comparisonOpen} onKeyDown={(event) => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing && !snapshot.newMessage?.draft.composing && !snapshot.threads.some((item) => item.draft?.composing) &&
          !(event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        if (contextual) owner.commands.cancelDraft("new"); else owner.commands.open(false);
      }
    }}>
    <header className="conversation-panel-header" hidden={!!snapshot.focusId || contextual}><h2>Feedback</h2>
      <Button variant="ghost" size="icon" aria-label="Close" title="Close feedback" onClick={() => owner.commands.open(false)}><Icon name="x" /></Button></header>
    <div className="conversation-overview" hidden={contextual}>
    {chrome.anchorNotice && !snapshot.focusId && <p className="conversation-notice" role="status">{chrome.anchorNotice}</p>}
    <div className="conversation-status" role="status" aria-label="Submission details"
      hidden={snapshot.focusId ? !work && !readonly :
        !work && !readonly && !snapshot.history[0] && !snapshot.attentionCount && snapshot.connected && !snapshot.notice}>
      {work && <span>{workDetails}</span>}
      {readonly && <span>{snapshot.status?.pendingMessageCount ?? 0} saved-unsent messages and {snapshot.status?.pendingEditCount ?? 0} edits remain read-only here.</span>}
      {!work && snapshot.history[0] && <span>Latest submission: {snapshot.history[0].state}</span>}
      {!!snapshot.attentionCount && <span>{snapshot.attentionCount} conversations have new activity</span>}
      {!snapshot.connected && <span>Disconnected; displayed state may be stale.</span>}
      {snapshot.notice && <span>{snapshot.notice}</span>}
    </div>
    {(snapshot.error || chrome.sourceError || chrome.connectionError) && <div className="conversation-error" role="alert">
      {snapshot.error && <p>{snapshot.error}</p>}{chrome.sourceError && <p>Source: {chrome.sourceError}</p>}{chrome.connectionError && <p>{chrome.connectionError}</p>}
      <Button size="sm" variant="outline" onClick={() => act(owner, owner.commands.refresh)}>Refresh review</Button>
    </div>}
    {snapshot.uncertain && <div className="conversation-error"><strong>{snapshot.uncertain.operation}: acceptance unknown</strong><p>{snapshot.uncertain.message}</p>
      <code>{snapshot.uncertain.requestId}</code><div className="conversation-actions">
        <Button disabled={snapshot.busy} onClick={() => act(owner, () => owner.commands.reconcile(false))}>Check receipt</Button>
        <Button disabled={snapshot.busy} onClick={() => act(owner, () => owner.commands.reconcile(true))}>Retry same request</Button>
      </div></div>}
    {!!snapshot.status?.blockers.length && <div className="conversation-blockers">{snapshot.sendBlocked
      ? "Send and affected source writes are blocked by outstanding work:" : "Other member pages have outstanding work; their source writes are blocked:"}
      {snapshot.status.blockers.map((blocker) => <p key={blocker.submissionId}><a href={`/r/${encodeURIComponent(blocker.reviewId)}`} target="_blank" rel="noreferrer">{blocker.reviewId}</a> · {blocker.submissionId}</p>)}</div>}
    <div className="conversation-filters" hidden={!!snapshot.focusId}>
      <SegmentedControl aria-label="Conversation filters">{(["open", "resolved"] as const).map((kind) => <SegmentedControlItem key={kind} size="sm" selected={snapshot.filters[kind]}
        onClick={() => owner.commands.filter(kind)}>{kind === "open" ? "Open" : "Resolved"} ({snapshot.threads.filter((item) => item.thread.status === kind).length})</SegmentedControlItem>)}</SegmentedControl>
      <Button className="conversation-new-trigger" aria-label="New message" size="sm" variant="ghost" disabled={disabled || !chrome.pageKey} onClick={() => act(owner, () => owner.commands.begin(chrome.pageKey!, { kind: "element", anchor: { selector: "body", label: chrome.pageName || "Page" } }))}>
        <Icon name="plus" /><span>New message</span>
      </Button>
    </div>
    {(snapshot.captureNotice || chrome.captureError) && <p className="conversation-notice" role="status">{snapshot.captureNotice || chrome.captureError}</p>}
    </div>
    <div className="conversation-inventory" ref={inventory} onScroll={() => {
      if (snapshot.open && !snapshot.focusId && inventory.current) {
        owner.rememberReadingPosition("inventory", "feedback", inventory.current.scrollTop);
        for (const article of inventory.current.querySelectorAll<HTMLElement>("[data-thread]")) {
          if (!article.hidden && article.dataset.thread) rememberExchange(owner, article.dataset.thread, article, inventory.current);
        }
      }
    }}>
      {snapshot.newMessage && <NewMessage shell={shell} snapshot={snapshot} chrome={chrome} />}
      <div hidden={!!snapshot.focusId || contextual}><LatestResult snapshot={snapshot} shell={shell} /></div>
      <Button className="conversation-section-toggle" variant="ghost" size="sm" hidden={!!snapshot.focusId || contextual}
        aria-expanded={commentsExpanded} aria-controls="conversationComments" onClick={() => setCommentsExpanded(value => !value)}>
        <Icon name={commentsExpanded ? "chevronDown" : "chevronRight"} size={14} />Comments ({snapshot.threads.length})
      </Button>
      <div className="conversation-comments" id="conversationComments" hidden={!commentsExpanded && !snapshot.focusId}>
      {snapshot.threads.map((item) => <ThreadCard key={item.thread.threadId} owner={owner} item={item} snapshot={snapshot} shell={shell} chrome={chrome} />)}
      {!snapshot.threads.length && !snapshot.newMessage && <p className={snapshot.edits.length ? "conversation-empty-with-edits" : undefined}>No conversations yet. Select text in the document or start a new message.</p>}
      </div>
      <div hidden={!!snapshot.focusId || contextual}>
        {(!!snapshot.edits.length || chrome.canRevert) && <section className="conversation-edits">
          <div className="feedback-edit-status">
            <Button className="conversation-section-toggle" variant="ghost" size="sm" aria-expanded={editsExpanded}
              aria-controls="conversationEdits" onClick={() => setEditsExpanded(value => !value)}>
              <Icon name={editsExpanded ? "chevronDown" : "chevronRight"} size={14} />Your edits ({snapshot.edits.length})
            </Button>
            <Button className="feedback-revert" variant="ghost" size="sm" disabled={chrome.blocked || chrome.loading || !chrome.canRevert}
              onClick={() => owner.commands.confirm("revert")}>Revert</Button></div>
          <ul id="conversationEdits" hidden={!editsExpanded} className="feedback-edit-list conversation-edit-list">{snapshot.edits.map((edit) => <li key={edit.editId}>
            <div className="conversation-edit-heading"><label className="feedback-edit-label"><Checkbox disabled={disabled}
              aria-label={`Include ${edit.content.label} in Send`} checked={!snapshot.excluded.includes(edit.editId)}
              onCheckedChange={(checked) => owner.commands.select(edit.editId, checked === true)} />{edit.content.label}</label>
              <Badge variant="outline">{edit.source.state === "saved" ? "Already saved" : "Source pending"}</Badge>
              <Badge variant="outline">{edit.content.kind}</Badge></div>
            <EditEvidence edit={edit} />
          </li>)}</ul></section>}
        <History snapshot={snapshot} shell={shell} />
      </div>
    </div>
    <footer className="conversation-footer" hidden={!!snapshot.focusId || contextual}>
      <ResponsiveNote composing={snapshot.note.composing} hasText={!!snapshot.note.text.trim()}>
      <Draft owner={owner} id="note" draft={snapshot.note} disabled={readonly} saving={snapshot.busy || !!snapshot.uncertain} />
      </ResponsiveNote>
      <div className="conversation-footer-support">
        <p id="sendSelectionDescription" className="feedback-help" role="status">{selectionDescription}</p>
        {!!snapshot.unsavedMessageDraftCount && <p className="feedback-help">{snapshot.unsavedMessageDraftCount} unsaved message drafts are not included. Save messages before sending.</p>}
        {work && <details className="conversation-handoff"><summary>Agent command</summary><code>{chrome.pollCommand}</code></details>}
      </div>
      <div className="feedback-actions">
        <Button id="endReview" variant="ghost" className="feedback-end" disabled={disabled || chrome.loading} onClick={() => owner.commands.confirm("end")}>End review</Button>
        <Button id="send" className="feedback-send" aria-label="Send" aria-describedby="sendSelectionDescription" aria-busy={snapshot.busy}
          disabled={disabled || chrome.loading || snapshot.sendBlocked || !selection?.total || snapshot.note.composing}
          onClick={() => act(owner, owner.commands.send)}>{selection ? `Send (${selection.total})` : "Send"}</Button>
      </div>
    </footer>
  </aside>;
  return <>
    <ToolbarControls changesId="conversationChanges" readOnlyNavigation editDisabled={chrome.blocked}
      feedbackCount={selection?.pendingCount ?? null} feedbackCountLabel="saved pending feedback items"
      status={<TooltipProvider delayDuration={300}><Tooltip open={statusTooltipOpen} onOpenChange={setStatusTooltipOpen}>
        <TooltipTrigger asChild>
          <Badge ref={statusTrigger} className="conversation-lifecycle" variant={readonly && snapshot.review ? "secondary" : work ? "warning" : snapshot.review ? "outline" : "quiet"}
            tabIndex={0} role="status" aria-label={status} aria-description={statusDetails}>{status}</Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom" onEscapeKeyDown={(event) => event.stopPropagation()}>{statusDetails}</TooltipContent>
      </Tooltip></TooltipProvider>}
      state={{ comparing: chrome.comparisonOpen, mode: chrome.mode, modeDisabled: chrome.loading, modeMenuOpen,
        restoreModeFocus: modeFocus.current, editDescription: chrome.policy === "writable" ? "Edits save directly to the file" : "Edits are sent to the agent",
        drawerOpen: snapshot.open && !contextual, feedbackCount: snapshot.attentionCount, theme: chrome.theme, ended: readonly }}
      commands={{
        setComparing: (value) => act(owner, () => value ? shell.commands.showChanges() : shell.commands.closeComparison()),
        setMode: (value) => { setModeMenuOpen(false); act(owner, () => shell.commands.mode(value)); },
        setModeMenu: (value) => { if (value) { modeFocus.current = true; setPageMenuOpen(false); } setModeMenuOpen(value); },
        openComments: () => snapshot.host !== "feedback" ? owner.commands.focus(null) : owner.commands.open(!snapshot.open),
        toggleTheme: shell.commands.theme,
      }}
      pagePicker={snapshot.pages.length > 1 && !chrome.comparisonOpen ? <ChoiceMenu id="reviewPage" label="Review page" value={chrome.pageKey ?? ""}
        options={snapshot.pages.map(({ page }) => ({ value: page.pageKey, label: page.target.kind === "file" ? page.target.path : page.target.url }))}
        triggerLabel={chrome.pageName || "Page"} disabled={chrome.loading} open={pageMenuOpen} restoreFocus={!chrome.comparisonOpen}
        onOpenChange={(open) => { if (open) { modeFocus.current = false; setModeMenuOpen(false); } setPageMenuOpen(open); }}
        onValueChange={(key) => act(owner, () => owner.commands.navigate(key))} /> : null} />
    {showRecovery && <div className="conversation-global-status" role="status" aria-label="Review recovery">
      {globalUncertain && <div><strong>{globalUncertain.operation}: acceptance unknown</strong>
        <p>{globalUncertain.message}</p><code>{globalUncertain.requestId}</code>
        <div className="conversation-actions">
          <Button size="sm" disabled={snapshot.busy} onClick={() => act(owner, () => owner.commands.reconcile(false))}>Check receipt</Button>
          <Button size="sm" disabled={snapshot.busy} onClick={() => act(owner, () => owner.commands.reconcile(true))}>Retry same request</Button>
        </div>
      </div>}
      {!snapshot.connected && <span>Disconnected; displayed state may be stale</span>}
      {globalErrors.length > 0 && <div role="alert">{globalErrors.map((error, index) => <p key={index}>{error}</p>)}</div>}
      {(globalErrors.length > 0 || !snapshot.connected) && <Button size="sm" variant="outline" onClick={() => act(owner, owner.commands.refresh)}>Refresh review</Button>}
      {chrome.themeSync.status === "failed" && <span role="alert">{chrome.themeSync.message}
        <Button size="sm" variant="outline" onClick={() => act(owner, shell.commands.retryTheme)}>Retry theme</Button></span>}
      {needsSourceRecovery && <Button size="sm" variant="outline" onClick={() => act(owner, shell.commands.reload)}>Reload source (discard local page edits)</Button>}
    </div>}
    {createPortal(<>
      <div className="drawer-backdrop conversation-backdrop review-ui" hidden={!overlayVisible} aria-hidden="true"
        onPointerDown={(event) => event.preventDefault()} onClick={() => owner.commands.open(false)} />
      {panel}
    </>, document.body)}
    <AlertDialog open={!!snapshot.confirmation} onOpenChange={(open) => { if (!open) owner.commands.cancelConfirmation(); }}>
      <AlertDialogContent onOpenAutoFocus={() => {
        confirmationTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }} onCloseAutoFocus={(event) => {
        event.preventDefault();
        setRestoreConfirmationFocus(true);
      }}><AlertDialogHeader><AlertDialogTitle>{snapshot.confirmation?.action === "end" ? "End shared review?" : snapshot.confirmation?.action === "abandon" ? "Abandon submission?" : "Confirm review action"}</AlertDialogTitle>
        <AlertDialogDescription>{snapshot.confirmation?.description}</AlertDialogDescription></AlertDialogHeader>
        {snapshot.error && <p role="alert">{snapshot.error}</p>}
        {snapshot.uncertain && <p role="status">Acceptance is unknown. Close this dialog and use Check receipt or Retry same request; do not repeat source work.</p>}
        <AlertDialogFooter><AlertDialogCancel disabled={snapshot.busy} onClick={owner.commands.cancelConfirmation}>Cancel</AlertDialogCancel>
          <Button disabled={snapshot.busy || !!snapshot.uncertain} onClick={() => act(owner, owner.commands.confirmAction)}>Confirm</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {createPortal(<div id="conversationChanges" hidden={!chrome.comparisonOpen}>
      {chrome.comparison ? <ConversationComparison shell={shell} chrome={chrome} snapshot={snapshot} /> :
        <section className="conversation-comparison review-ui" aria-label="Changes">
          <h2>Changes</h2><p>{!snapshot.review || snapshot.loading ? "Loading review history..." : snapshot.history.some((item) => item.state === "abandoned")
            ? "No handled submission is selected. Abandoned work does not have an accepted result."
            : "No handled submissions yet. Send feedback to receive a response and its available comparisons."}</p>
        </section>}
    </div>, document.body)}
  </>;
}
