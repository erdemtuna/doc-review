import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { ConversationShell } from "../../conversation-shell.js";
import type { ConversationController, ConversationDraft } from "../../conversation-controller.js";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { confirmationPresentation } from "./conversation-confirmation";
import { ReceiptRecovery, RecoveryNotice } from "./recovery-notice";
import { Badge } from "./ui/badge";
import { Textarea } from "./ui/textarea";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from "./ui/alert-dialog";
import { ConversationComparison } from "./conversation-comparison";
import { ToolbarControls } from "./toolbar";
import { ChoiceMenu } from "./ui/choice-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { Checkbox } from "./ui/checkbox";
import { Icon } from "./icon";
import { ConversationAuthor, ConversationIntent, ConversationMenu, ConversationTime, ConversationSource } from "./conversation-controls";
import { EditEvidence, ResultActions, ResultPreview, type ResultDetail, type RevealReply, editOutcomeSummary, responseOutcomeLabels, resultAvailability, resultHeading } from "./conversation-results";
import { SegmentedControl, SegmentedControlItem } from "./ui/segmented-control";
import { Timeline, TimelineItem } from "./ui/timeline";

type Snapshot = ReturnType<ConversationController["getSnapshot"]>;
type Thread = Snapshot["threads"][number];
type ReplyOrigin = { history: boolean; top: number; trigger: HTMLButtonElement };
type ReplyNavigation = { detail: ResultDetail; index: number; origin: ReplyOrigin };
function act(owner: ConversationController, action: () => unknown) {
  try { Promise.resolve(action()).catch(owner.report); } catch (cause) { owner.report(cause); }
}
function time(value: number) { return new Date(value).toLocaleString(); }
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
    if (id === "note" || id === "new" || !state.open || (state.host !== "feedback" && !draft.messageId)) return;
    const field = input.current, inventory = field?.closest<HTMLElement>(
      state.host !== "feedback" && draft.messageId ? ".conversation-transcript" : ".conversation-inventory");
    if (!field || !inventory) return;
    const preserveReading = !draft.messageId && !!owner.readingAnchor(id);
    let width = preserveReading ? inventory.clientWidth : -1, height = preserveReading ? inventory.clientHeight : -1;
    let hidden = false;
    const observer = new ResizeObserver(() => {
      if (!inventory.clientHeight || !inventory.clientWidth) { hidden = true; return; }
      const resumed = hidden; hidden = false;
      if (width === inventory.clientWidth && height === inventory.clientHeight) return;
      width = inventory.clientWidth; height = inventory.clientHeight;
      if (resumed) return;
      const bounds = inventory.getBoundingClientRect(), editor = field.getBoundingClientRect();
      if (!editor.height || (!draft.messageId && editor.top < bounds.top)) return;
      const firstLine = Math.min(36, editor.height);
      const bottom = bounds.top + inventory.clientTop + inventory.clientHeight;
      if (editor.top < bounds.top) inventory.scrollTop += editor.top - bounds.top;
      else if (editor.top + firstLine > bottom) inventory.scrollTop += Math.ceil(editor.top + firstLine - bottom);
    });
    observer.observe(inventory);
    return () => observer.disconnect();
  }, [id, state.host, state.open]);
  const label = id === "note" ? "Note to agent" : id === "new" ? "New message" : draft.messageId ? "Edit message" : "Reply";
  const actionLabel = id === "new" ? "Add comment" : draft.messageId ? "Update comment" : "Add reply";
  return <div className="conversation-composer" data-composer={id} onKeyDown={(event) => {
    if (id === "note" || event.key !== "Escape" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || draft.composing) return;
    event.stopPropagation(); event.preventDefault();
    owner.commands.cancelDraft(id);
  }}>
    {id === "note" ? <label className="sr-only" htmlFor={`draft-${id}`}>{label}</label> : <div className={id === "new" || draft.messageId ? "sr-only" : "conversation-composer-heading"}>
      <label htmlFor={`draft-${id}`}>{label}</label>
      {id !== "new" && !draft.messageId && !disabled && <IconButton
        aria-label={`Close ${draft.messageId ? "edit" : "reply"}`} disabled={saving || draft.composing}
        onClick={() => owner.commands.cancelDraft(id)}><Icon name="x" /></IconButton>}
    </div>}
    <Textarea ref={input} className="min-h-9" id={`draft-${id}`} rows={id === "note" ? 2 : undefined}
      placeholder={id === "note" ? "Optional context for the agent" : undefined} value={draft.text} readOnly={disabled}
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
          onClick={() => act(owner, () => owner.commands.saveDraft(id))}>{actionLabel}</Button>
      </TooltipTrigger><TooltipContent>Enter to {actionLabel.toLowerCase()} · Shift+Enter for a new line. Not sent until you choose Send to agent.</TooltipContent></Tooltip></TooltipProvider>}
      {id !== "note" && <span className="sr-only" id={`save-help-${id}`}>Enter to {actionLabel.toLowerCase()}. Shift+Enter for a new line. Not sent until you choose Send to agent in Feedback.</span>}
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
  const initialFocus = useRef(true);
  const contextual = snapshot.host === "compose";
  useLayoutEffect(() => {
    if (contextual && snapshot.open) initialFocus.current = true;
  }, [contextual, snapshot.open]);
  useLayoutEffect(() => {
    if (initialFocus.current && snapshot.open && (!contextual || chrome.composer) && snapshot.review?.state === "open") {
      element.current?.querySelector("textarea")?.focus({ preventScroll: true });
      initialFocus.current = false;
    }
  }, [contextual, snapshot.open, !!chrome.composer]);
  useLayoutEffect(() => {
    if (!contextual || !element.current) return;
    const node = element.current;
    const measure = () => {
      const height = node.getBoundingClientRect().height;
      if (height) shell.commands.measureComposer(Math.ceil(height + 2));
    };
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
      <IconButton size="icon" aria-label="Close comment"
        disabled={snapshot.busy || !!snapshot.uncertain || snapshot.savingDraftIds.includes("new") || item.draft.composing || snapshot.review?.state !== "open"}
        onClick={() => shell.owner.commands.cancelDraft("new")}><Icon name="x" /></IconButton>
    </header>
    {chrome.composerNotice && <p className="conversation-notice" role="status">{chrome.composerNotice}</p>}
    <div className="contextual-direction" hidden={!edge}>
      {edge && <span>{item.target.kind === "selection" ? "Selection" : "Element"} is {chrome.composerRelation}</span>}
      {edge && <Button size="xs" variant="ghost" onClick={shell.commands.revealSelection}>Back to selection</Button>}
    </div>
    <div className="conversation-new-target quote" data-new-target-kind={item.target.kind}><ConversationSource target={item.target} /></div>
    <Draft owner={shell.owner} id="new" draft={item.draft} disabled={snapshot.review?.state !== "open"}
      saving={snapshot.busy || !!snapshot.uncertain || snapshot.savingDraftIds.includes("new")} />
  </div>;
}
function ThreadCard({ owner, item, snapshot, shell, chrome, navigatingReplies }: {
  owner: ConversationController; item: Thread; snapshot: Snapshot; shell: ConversationShell; navigatingReplies: boolean;
  chrome: ReturnType<ConversationShell["getSnapshot"]>;
}) {
  const id = item.thread.threadId, focus = snapshot.focusId === id;
  const adjacent = focus && snapshot.host === "adjacent";
  const target = chrome.anchorViews[id] ?? { canJump: false, offscreen: false, reason: "Checking the target." };
  const peers = chrome.anchorPeers[id] ?? [id];
  const [peerMenuOpen, setPeerMenuOpen] = useState(false);
  useEffect(() => {
    const close = () => setPeerMenuOpen(false);
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, []);
  useEffect(() => { setPeerMenuOpen(false); }, [snapshot.focusId, snapshot.open, snapshot.host]);
  const disabled = snapshot.review?.state !== "open" || !!snapshot.uncertain || snapshot.busy;
  const transcript = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null), previousDraft = useRef(item.draft);
  useLayoutEffect(() => {
    const node = article.current, content = transcript.current;
    if (!adjacent || !node || !content) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const panel = node.closest<HTMLElement>(".conversation-panel")!;
        const inventory = node.closest<HTMLElement>(".conversation-inventory")!;
        const padding = (element: HTMLElement) => {
          const style = getComputedStyle(element);
          return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
        };
        const header = node.querySelector<HTMLElement>(":scope > header")!;
        const controls = node.querySelector<HTMLElement>(".conversation-thread-content > .conversation-composer, .conversation-thread-content > .conversation-reply");
        const overview = panel.querySelector<HTMLElement>(".conversation-overview")!;
        const fixed = padding(panel) + padding(inventory) + padding(node) + header.getBoundingClientRect().height +
          parseFloat(getComputedStyle(header).marginBottom) + (controls?.getBoundingClientRect().height ?? 0) + overview.getBoundingClientRect().height;
        const text = item.expanded ? [...content.children].reduce((height, child) => {
          const style = getComputedStyle(child);
          return height + child.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
        }, 0) : 0;
        shell.commands.measureThread(id, Math.ceil(fixed + text), Math.ceil(fixed + Math.min(text, 48)));
      });
    };
    const observer = new ResizeObserver(measure);
    [node, content, ...node.querySelectorAll<HTMLElement>("header, .conversation-composer, .conversation-reply")].forEach(element => observer.observe(element));
    measure();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [adjacent, item.exchanges, item.draft, item.expanded, chrome.viewport.width, chrome.viewport.height, shell]);
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
  useLayoutEffect(() => {
    if (snapshot.revealedMessage?.threadId !== id || !focus) return;
    const element = transcript.current;
    const message = element && [...element.querySelectorAll<HTMLElement>("[data-message]")].find(node => node.dataset.message === snapshot.revealedMessage?.messageId);
    if (message && element) {
      element.scrollTop += message.getBoundingClientRect().top - element.getBoundingClientRect().top;
      message.focus({ preventScroll: true });
    }
  }, [snapshot.revealedMessage]);
  const trailingTargetNotice = !!item.draft && !focus && chrome.viewport.width <= 480 && chrome.viewport.height <= 550;
  const replyControl = !item.draft && !disabled && item.thread.status === "open" &&
    <Button variant="ghost" size="sm" data-reply onClick={() => owner.commands.reply(id)}>Reply</Button>;
  const resolutionControl = !item.draft && snapshot.review?.state === "open" &&
    <Button variant="ghost" size="sm" disabled={disabled}
      aria-label={item.thread.status === "resolved" ? "Reopen conversation" : "Resolve conversation"}
      onClick={event => {
        const trigger = event.currentTarget;
        act(owner, async () => {
          await owner.commands.resolve(id);
          if (owner.getSnapshot().threads.find(thread => thread.thread.threadId === id)?.expanded === false) {
            requestAnimationFrame(() => {
              if (document.activeElement === trigger || document.activeElement === document.body) {
                article.current?.querySelector<HTMLButtonElement>(".conversation-thread-title")?.focus({ preventScroll: true });
              }
            });
          }
        });
      }}>
      <Icon name={item.thread.status === "resolved" ? "rotateCcw" : "circleCheck"} />
      {item.thread.status === "resolved" ? "Reopen" : "Resolve"}
    </Button>;
  const draftView = item.draft && <Draft owner={owner} id={id} draft={item.draft} disabled={snapshot.review?.state !== "open"}
    saving={snapshot.busy || !!snapshot.uncertain || snapshot.savingDraftIds.includes(id)} />;
  const messageControls = (reviewer: Thread["exchanges"][number]["reviewer"]) => <>
    <IconButton className="conversation-icon" aria-label="Edit message"
      data-edit-message={reviewer.messageId} onClick={() => act(owner, () => owner.commands.edit(reviewer))}><Icon name="pencil" /></IconButton>
  </>;
  const lastPending = item.exchanges.at(-1)?.reviewer;
  const pinnedMessageControls = focus && replyControl && lastPending?.submissionId === null;
  const peerOptions = peers.map((peer, index) => {
      const thread = snapshot.threads.find((item) => item.thread.threadId === peer);
      return { value: peer, label: `${index + 1}: ${thread?.latestExchange?.reviewer.body.slice(0, 60) || "Conversation"}`,
        description: thread?.thread.status === "resolved" ? "Resolved" : "Open" };
  });
  const peersControl = peers.length > 1 && <div className="conversation-peers"><span>{peers.length} conversations at this target</span>
    <ChoiceMenu id={`peer-${id}`} label="Conversation at this target" value={id} size="sm"
      options={peerOptions} triggerLabel={peerOptions.find(option => option.value === id)?.label ?? "Conversation"}
      open={peerMenuOpen} onOpenChange={setPeerMenuOpen} restoreFocus={!snapshot.focusId || focus}
      onValueChange={peer => act(owner, async () => {
        if (adjacent) await shell.commands.adjacent(peer); else owner.commands.focus(peer);
        requestAnimationFrame(() => {
          const next = document.getElementById(`peer-${peer}`);
          if (document.activeElement === document.body && next && !next.closest("[hidden], [inert]")) next.focus({ preventScroll: true });
        });
      })} />
  </div>;
  return <article ref={article} className={`conversation-thread inventory-card${focus ? " focused" : ""}`} data-thread={id}
    data-status={item.thread.status} data-expanded={item.expanded}
    hidden={snapshot.host === "compose" || (snapshot.focusId ? !focus : !snapshot.filters[item.thread.status])}>
    <header>
      {focus && !navigatingReplies && <div className="conversation-thread-navigation">
        <Button size="xs" variant="ghost" onClick={() => owner.commands.focus(null)}>Back to Feedback</Button>
        <IconButton className="conversation-icon" aria-label="Close conversation"
          onMouseDown={(event) => event.preventDefault()} onClick={() => owner.commands.open(false)}><Icon name="x" /></IconButton>
      </div>}
      <div className="conversation-thread-toolbar">
      <div className="conversation-thread-identity">
      <ConversationSource target={item.thread.target} />
      {item.thread.status === "resolved" && <Badge variant="secondary" className="conversation-resolved-status text-muted-foreground">
        <Icon name="circleCheck" size={12} />Resolved
      </Badge>}
      {item.attention && <IconButton className="conversation-activity" aria-label="Mark conversation as read" hint="New activity: mark conversation as read"
        onClick={() => owner.commands.markRead(id)}><span aria-hidden="true" /></IconButton>}
      </div>
      <div className="conversation-thread-actions">
      <IconButton className="conversation-jump conversation-icon" disabled={!target.canJump}
          aria-label="Show in document" aria-describedby={target.reason ? `target-status-${id}` : undefined} hint="Show the exact passage"
          onMouseDown={(event) => event.preventDefault()} onClick={() => act(owner, () => owner.commands.jump(id))}>
          <Icon name="locate" /></IconButton>
        <IconButton className="conversation-icon" disabled={disabled}
          aria-label={item.thread.status === "resolved" ? "Reopen" : "Resolve"}
          hint={item.thread.status === "resolved" ? "Reopen conversation" : "Resolve conversation"}
          onClick={() => act(owner, () => owner.commands.resolve(id))}>
          <Icon name={item.thread.status === "resolved" ? "rotateCcw" : "circleCheck"} />
        </IconButton>
      <ConversationMenu actions={[
        ...(!focus || adjacent ? [{ label: "Focus", run: () => owner.commands.focus(id) }] : []),
        ...(!adjacent ? [{
          label: "Beside target", disabled: !target.canJump || target.offscreen || item.thread.pageKey !== chrome.pageKey,
          run: () => act(owner, () => shell.commands.adjacent(id)),
        }] : []),
        ...(item.messageCount === item.pendingMessageCount ? [{ label: "Delete thread", disabled, destructive: true,
          run: () => act(owner, () => owner.commands.confirm("delete", id)) }] : []),
      ]} />
      <DisclosureTrigger iconOnly className="conversation-thread-title conversation-icon"
        aria-label={item.expanded ? "Collapse conversation" : "Expand conversation"} expanded={item.expanded} controls={`thread-${id}`}
        onMouseDown={(event) => event.preventDefault()} onClick={() => owner.commands.collapse(id)} />
      </div>
      </div>
      {adjacent && peersControl}
    </header>
    {snapshot.resolutionGuard?.threadId === id && <div className="conversation-resolution-guard" role="status">
      <p>{snapshot.resolutionGuard.message}</p><Button size="xs" variant="outline" onClick={owner.commands.dismissResolutionGuard}>Keep reviewing</Button>
    </div>}
    <div id={`thread-${id}`} className="conversation-thread-content" hidden={!item.expanded}>
      <div className="conversation-transcript" ref={transcript} onScroll={() => {
        if (focus && transcript.current) {
          owner.rememberReadingPosition(id, "focus", transcript.current.scrollTop);
          rememberExchange(owner, id, transcript.current, transcript.current);
        }
      }}>
        {item.messageCount > item.exchanges.length && <Button className="conversation-earlier" size="xs" variant="ghost"
          disabled={item.contextLoading} aria-busy={item.contextLoading} onClick={() => {
          const element = focus ? transcript.current : transcript.current?.closest<HTMLElement>(".conversation-inventory");
          const previousHeight = element?.scrollHeight ?? 0, previousTop = element?.scrollTop ?? 0;
          act(owner, async () => {
            await owner.commands.earlier(id);
            requestAnimationFrame(() => {
              if (element && element.scrollTop === previousTop) element.scrollTop = previousTop + element.scrollHeight - previousHeight;
            });
          });
        }}>{item.contextLoading ? "Loading earlier replies..." : "Show earlier replies"}</Button>}
        {item.contextError && <p className="conversation-context-error" role="alert">{item.contextError}</p>}
        {item.exchanges.map(({ reviewer, response }, index) => <section className="conversation-exchange" key={reviewer.messageId} data-message={reviewer.messageId} tabIndex={-1}>
          <div className="conversation-meta inventory-meta"><ConversationAuthor role="You" /><ConversationTime value={reviewer.createdAt} />
            {reviewer.intent === "request-change" && item.draft?.messageId !== reviewer.messageId && <ConversationIntent />}
            {reviewer.submissionId === null && <Badge variant="secondary" className="conversation-pending"
              title={snapshot.review?.state === "ended" ? "Not sent; this review has ended and is read-only" : "Saved feedback waiting to be sent"}>
              Pending{snapshot.review?.state === "ended" && <span className="sr-only"> (read-only)</span>}
            </Badge>}
            {item.draft?.messageId === reviewer.messageId && snapshot.review?.state === "open" && <IconButton className="conversation-close-edit"
              aria-label="Close edit" disabled={disabled || snapshot.savingDraftIds.includes(id) || item.draft.composing}
              onClick={() => owner.commands.cancelDraft(id)}><Icon name="x" /></IconButton>}
          </div>
          {item.draft?.messageId === reviewer.messageId ? draftView : <>
          <p className="conversation-body">{reviewer.body}</p>
          {reviewer.submissionId === null && !disabled && !(pinnedMessageControls && index === item.exchanges.length - 1) && <div className="conversation-actions">
            {index === item.exchanges.length - 1 && !focus && resolutionControl}
            {messageControls(reviewer)}
            {index === item.exchanges.length - 1 && !focus && replyControl}
          </div>}
          </>}
          {response && <div className="conversation-response"><div className="conversation-meta inventory-meta"><ConversationAuthor role="Agent" /><ConversationTime value={response.createdAt} />
            {response.outcome !== "answered" && <Badge variant="outline">{responseOutcomeLabels[response.outcome]}</Badge>}</div><p className="conversation-body">{response.body}</p></div>}
        </section>)}
        {item.exchanges.at(-1)?.reviewer.submissionId !== null && !focus && resolutionControl &&
          <div className="conversation-reply conversation-actions">{resolutionControl}{replyControl}</div>}
        {target.reason && !trailingTargetNotice && <p id={`target-status-${id}`} className="conversation-target-status">{target.reason}</p>}
        {!adjacent && peersControl && <details className="conversation-target-details"><summary>Conversations at this target ({peers.length})</summary>{peersControl}</details>}
      </div>
      {focus && resolutionControl && <div className="conversation-reply conversation-actions">
        {resolutionControl}{pinnedMessageControls && messageControls(lastPending!)}{replyControl}</div>}
      {!item.draft?.messageId && draftView}
      {target.reason && trailingTargetNotice && <p id={`target-status-${id}`} className="conversation-target-status">{target.reason}</p>}
    </div>
  </article>;
}
function pageLabel(snapshot: Snapshot, key: string) {
  const target = snapshot.pages.find(({ page }) => page.pageKey === key)?.page.target;
  return target?.kind === "file" ? target.path.split(/[\\/]/).at(-1) : target?.url ?? "Review page";
}
function CaptureNotices({ snapshot, shell, submissionId }: { snapshot: Snapshot; shell: ConversationShell; submissionId: string }) {
  return <>{shell.getSnapshot().captureFailures.filter(({ scope }) => scope.submissionId === submissionId).map(({ scope, message }) =>
    <p key={scope.pageKey} className="conversation-capture-warning" role="status">
      Result capture unavailable: {message} <span>({pageLabel(snapshot, scope.pageKey)})</span>
    </p>)}</>;
}
function History({ snapshot, shell, visible, onReveal }: { snapshot: Snapshot; shell: ConversationShell; visible: boolean; onReveal: RevealReply }) {
  const owner = shell.owner;
  return <section className="conversation-history" aria-label="Submission history">
    {!snapshot.history.length && <p>No submissions yet. Send saved feedback when you are ready.</p>}
    {[...new Set(snapshot.status?.blockers.map(blocker => blocker.reviewId))].filter(id => id !== snapshot.review?.reviewId)
      .map(id => <p key={id}><a href={`/r/${encodeURIComponent(id)}`} target="_blank" rel="noreferrer">Open related review</a></p>)}
    <Timeline aria-label="Review timeline">
    {snapshot.history.map((item) => {
      const detail = snapshot.submissions.find((entry) => entry.id === item.submissionId)?.value;
      const waiting = item.state === "queued" || item.state === "delivered";
      const followUp = detail?.result && [
        detail.result.overallOutcome, ...detail.result.responses.map(response => response.outcome),
        ...detail.result.editOutcomes.map(outcome => outcome.outcome),
      ].some(outcome => outcome === "clarification-needed" || outcome === "deferred");
      const changed = item.result?.effect === "changes-reported";
      const heading = item.result ? followUp ? "Response needs follow-up" : (detail ? resultHeading(detail) : "Agent response")
        : item.state === "queued" ? "Waiting for delivery" : item.state === "delivered" ? "Waiting for a response" : "Abandoned";
      return <TimelineItem key={item.submissionId} data-state={item.state}
        tone={waiting || followUp ? "waiting" : item.state === "abandoned" ? "neutral" : changed ? "changed" : "response"}
        icon={<Icon size={14} name={item.state === "queued" ? "clock" : item.state === "delivered" ? "inbox"
          : item.state === "abandoned" ? "circleX" : followUp ? "circleHelp" : changed ? "filePenLine" : "messages"} />}>
      <details open={item.result ? undefined : true} className="conversation-submission">
        <summary><span className="conversation-submission-heading"><span>{heading}</span>
          <ConversationTime value={item.createdAt} /></span><Icon className="conversation-submission-chevron" name="chevronRight" size={14} /></summary>
        <div className="conversation-submission-content">
        {detail?.submission.overallNote && <section><h4>Note to agent {detail.submission.overallNote.intent === "request-change" && <ConversationIntent />}</h4>
          <p>{detail.submission.overallNote.body}</p></section>}
        {item.result && <section className="conversation-result"><h4>{item.result.title}</h4><p>{item.result.body}</p></section>}
        {detail?.result && <ResultActions detail={detail} shell={shell} onReveal={onReveal} />}
        {detail?.result?.editOutcomes.map((outcome) => <p key={outcome.editId}>{editOutcomeSummary(outcome.outcome)} {outcome.reason}</p>)}
        {item.state === "abandoned" && <p role="status">Abandoned. External source work may still have happened; check the source. No undo or cancellation is guaranteed.</p>}
        {item.result && <p>{resultAvailability(item)}</p>}
        {visible && <CaptureNotices snapshot={snapshot} shell={shell} submissionId={item.submissionId} />}
        {detail?.submission.pageKeys.map((key) => item.result?.effect === "changes-reported" && <section aria-label={pageLabel(snapshot, key)} key={key}>
          <h4>{pageLabel(snapshot, key)}</h4><div className="conversation-actions">
          <Button variant="ghost" size="sm" onClick={() => act(owner, () => shell.commands.comparison(item.submissionId, key, "content"))}>Content changes</Button>
          <Button variant="ghost" size="sm" onClick={() => act(owner, () => shell.commands.comparison(item.submissionId, key, "source"))}>Source changes</Button>
          {item.result.effect === "changes-reported" && ["pending", "partial", "failed", "unavailable"].includes(item.comparisonStatus) &&
            <Button variant="ghost" size="sm" disabled={key !== shell.getSnapshot().pageKey}
              title={key !== shell.getSnapshot().pageKey ? "Open this page in Review before capturing current content." : undefined}
              onClick={() => act(owner, () => shell.commands.recapture(item.submissionId, key))}>Capture current content</Button>}
          </div></section>)}
        </div>
      </details>
      {waiting && <Button className="conversation-abandon" variant="destructive-ghost" size="xs" disabled={snapshot.busy || !!snapshot.uncertain}
        onClick={() => owner.commands.confirm("abandon", item.submissionId)}><Icon name="circleX" size={14} />Abandon</Button>}
      </TimelineItem>;
    })}
    </Timeline>
    {snapshot.historyCursor && <Button variant="outline" onClick={() => act(owner, owner.commands.historyEarlier)}>Load earlier submissions</Button>}
  </section>;
}
function LatestResult({ snapshot, shell, visible, onReveal }: { snapshot: Snapshot; shell: ConversationShell; visible: boolean; onReveal: RevealReply }) {
  const latest = snapshot.history.find((item) => item.result);
  if (!latest?.result) return null;
  const detail = snapshot.submissions.find((item) => item.id === latest.submissionId)?.value;
  return <section className="conversation-result-peek inventory-card" aria-label="Latest submission result">
    <div className="conversation-result-peek-heading"><h3>{detail ? resultHeading(detail) : "Agent response"}</h3>
      <ConversationTime value={latest.result.createdAt} /></div>
    <ResultPreview key={latest.submissionId} body={latest.result.body} actions={expandControl =>
      detail?.result ? <ResultActions detail={detail} shell={shell} onReveal={onReveal} leadingAction={expandControl} /> : expandControl} />
    {visible && <CaptureNotices snapshot={snapshot} shell={shell} submissionId={latest.submissionId} />}
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [replyNavigation, setReplyNavigation] = useState<ReplyNavigation | null>(null);
  const [replyNavigationBusy, setReplyNavigationBusy] = useState(false);
  const returningToReplies = useRef<ReplyOrigin | null>(null);
  const [noteExpanded, setNoteExpanded] = useState(false);
  const noteOpen = noteExpanded || snapshot.note.composing;
  const contextual = snapshot.host === "compose" && !!snapshot.newMessage;
  const historyVisible = historyOpen && !snapshot.focusId && !contextual;
  const navigatingReplies = !!replyNavigation && snapshot.host === "focus" &&
    replyNavigation.detail.result?.responses[replyNavigation.index]?.threadId === snapshot.focusId;
  useLayoutEffect(() => {
    if (inventory.current) inventory.current.scrollTop = owner.readingPosition(historyVisible ? "history" : "inventory", "feedback");
  }, [historyVisible]);
  const selectHistory = (value: boolean) => {
    if (!snapshot.focusId && value === historyVisible) return;
    if (!snapshot.focusId && inventory.current) owner.rememberReadingPosition(historyVisible ? "history" : "inventory", "feedback", inventory.current.scrollTop);
    setReplyNavigation(null);
    if (snapshot.focusId) owner.commands.focus(null);
    setHistoryOpen(value);
  };
  const navigateReply = async (detail: ResultDetail, index: number, origin: ReplyOrigin) => {
    const reply = detail.result?.responses[index];
    if (!reply) throw new Error("The requested reply is no longer available.");
    setReplyNavigationBusy(true);
    try {
      await owner.commands.revealMessage(reply.threadId, reply.replyToMessageId);
      const current = owner.getSnapshot();
      if (current.focusId === reply.threadId && current.revealedMessage?.messageId === reply.replyToMessageId) {
        setReplyNavigation({ detail, index, origin });
      }
    } finally { setReplyNavigationBusy(false); }
  };
  const revealReply: RevealReply = (detail, index, trigger) => {
    const origin = { history: historyVisible, top: inventory.current?.scrollTop ?? 0, trigger };
    owner.rememberReadingPosition(historyVisible ? "history" : "inventory", "feedback", origin.top);
    return navigateReply(detail, index, origin);
  };
  const backToReplies = () => {
    if (!replyNavigation) return;
    returningToReplies.current = replyNavigation.origin;
    setHistoryOpen(replyNavigation.origin.history);
    setReplyNavigation(null);
    owner.commands.focus(null);
  };
  const composerBounds = chrome.composer && {
    left: chrome.composer.left, top: chrome.composer.top, width: chrome.composer.width, height: chrome.composer.height,
  };
  const sidebarVisible = snapshot.open && snapshot.host !== "adjacent" && !contextual;
  const docked = sidebarVisible && chrome.viewport.width >= 1020;
  useLayoutEffect(() => {
    document.body.dataset.conversationDocked = String(docked);
    return () => { delete document.body.dataset.conversationDocked; };
  }, [docked]);
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
    if (chrome.comparisonOpen) document.querySelector<HTMLButtonElement>("#conversationChanges .conversation-comparison-title button")?.focus({ preventScroll: true });
    return () => document.body.classList.remove("comparing");
  }, [chrome.comparisonOpen]);
  useLayoutEffect(() => {
    if (wasOpen.current && !snapshot.open) document.getElementById("commentsButton")?.focus({ preventScroll: true });
    if (!wasOpen.current && snapshot.open && !snapshot.focusId && inventory.current) {
      inventory.current.scrollTop = owner.readingPosition(historyVisible ? "history" : "inventory", "feedback");
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
  useLayoutEffect(() => {
    const origin = returningToReplies.current;
    if (!origin || snapshot.focusId) return;
    returningToReplies.current = null;
    if (inventory.current) inventory.current.scrollTop = origin.top;
    if (origin.trigger.isConnected) origin.trigger.focus({ preventScroll: true });
    else document.querySelector<HTMLButtonElement>(".conversation-panel-header [aria-pressed='true']")?.focus({ preventScroll: true });
  }, [snapshot.focusId, historyVisible]);
  useEffect(() => {
    if (!replyNavigationBusy && !navigatingReplies) setReplyNavigation(null);
  }, [navigatingReplies, replyNavigationBusy]);
  const readonly = snapshot.review?.state !== "open";
  const confirmation = snapshot.confirmation && confirmationPresentation(snapshot.confirmation.action,
    snapshot.threads.some(item => item.thread.threadId === snapshot.confirmation?.id && item.thread.status === "resolved"));
  const disabled = readonly || snapshot.busy || !!snapshot.uncertain;
  const work = snapshot.status?.work;
  const status = !snapshot.review ? "Loading review" : readonly ? "Review ended" : work ? "Waiting for agent" : "Reviewing";
  const workDetails = work ? work.state === "queued" ? "Waiting to be picked up" : "Feedback received; no response yet. This does not confirm an agent is currently working" : "";
  const statusDetails = [
    !snapshot.review ? "Loading the shared review." : readonly
      ? `This shared review has ended. Saved-unsent messages and edits remain read-only here.${work ? " Accepted work can still finish; ending the review does not cancel it." : ""}`
      : work ? "Feedback has been submitted and is waiting for an agent response."
      : "Review the page, add feedback, or switch to Edit. Saved feedback is not sent until you choose Send.",
    workDetails && `${workDetails}.`,
    chrome.save.status === "saved" ? "Source saved." : chrome.save.status === "saving" ? "Saving source." : null,
  ].filter(Boolean).join(" ");
  const outsideFeedback = !snapshot.open || chrome.comparisonOpen || contextual;
  const feedbackErrors = [
    snapshot.connected && !snapshot.uncertain ? snapshot.error : "",
    chrome.sourceError && `Source: ${chrome.sourceError}`,
    snapshot.connected ? chrome.connectionError : "",
  ].filter((value): value is string => !!value);
  const globalErrors = outsideFeedback ? feedbackErrors : [];
  const globalUncertain = outsideFeedback && snapshot.uncertain;
  const needsSourceRecovery = chrome.reloadPending || !!chrome.sourceError || (chrome.loading && !!snapshot.error);
  const showRecovery = globalErrors.length > 0 || globalUncertain || !snapshot.connected ||
    chrome.themeSync.status === "failed" || needsSourceRecovery;
  const paneTop = Math.max(chrome.viewport.top, chrome.contentTop);
  const paneWidth = Math.min(380, chrome.viewport.width);
  const fallbackBounds = {
    left: chrome.viewport.left + chrome.viewport.width - paneWidth, top: paneTop,
    width: paneWidth, height: Math.max(0, chrome.viewport.top + chrome.viewport.height - paneTop),
  };
  const selection = snapshot.selection;
  const selectionDescription = selection
    ? selection.total ? `Ready to send: ${[
      selection.messages ? `${selection.messages} comment${selection.messages === 1 ? "" : "s"}` : "",
      selection.edits ? `${selection.edits} edit${selection.edits === 1 ? "" : "s"}` : "",
      selection.note ? "1 note" : "",
    ].filter(Boolean).join(" · ")}` : "Nothing to send."
    : !snapshot.connected ? "" : snapshot.loading ? "Checking pending feedback…" : "Couldn't check what's ready to send. Refresh the review.";
  // Keep a focused editor mounted and focusable while waiting for current-frame geometry.
  const measuring = { ...fallbackBounds, width: Math.min(contextual ? 340 : 360, chrome.viewport.width - 24), height: "auto", opacity: 0, pointerEvents: "none" as const };
  const panel = <aside aria-label={contextual ? "Add comment" : "Feedback"} data-host={snapshot.host}
    className={`conversation-panel review-ui${historyVisible ? " has-history" : ""}${snapshot.focusId ? " has-focus" : ""}${navigatingReplies ? " has-reply-navigation" : ""}${contextual ? ` is-composing contextual-compose ${chrome.composer?.kind ?? ""}` : ""}${snapshot.host === "adjacent" ? " is-adjacent" : ""}`}
    style={{ ...(contextual ? composerBounds ?? measuring : snapshot.host === "adjacent" ? chrome.adjacent ?? measuring : fallbackBounds), right: "auto", bottom: "auto" }}
    hidden={!snapshot.open || chrome.comparisonOpen} inert={!snapshot.open || chrome.comparisonOpen} onKeyDown={(event) => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing && !snapshot.newMessage?.draft.composing && !snapshot.threads.some((item) => item.draft?.composing) &&
          !(event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        if (contextual) owner.commands.cancelDraft("new"); else owner.commands.open(false);
      }
    }}>
    <header className="conversation-panel-header" hidden={snapshot.host === "adjacent" || contextual}>
      <SegmentedControl aria-label="Feedback destination">
        <SegmentedControlItem selected={!historyOpen} aria-controls="conversationInventory" onClick={() => selectHistory(false)}>Feedback</SegmentedControlItem>
        <SegmentedControlItem selected={historyOpen} aria-label="History"
          aria-description={chrome.captureFailures.length ? `${chrome.captureFailures.length} capture issues in History` : undefined}
          aria-controls="conversationHistory" onClick={() => selectHistory(true)}>History
          {chrome.captureFailures.length > 0 && <Badge variant="outline" aria-label={`${chrome.captureFailures.length} capture issues`}>{chrome.captureFailures.length}</Badge>}
        </SegmentedControlItem>
      </SegmentedControl>
      <IconButton size="icon" aria-label="Close feedback" onClick={() => owner.commands.open(false)}><Icon name="x" /></IconButton></header>
    <div className="conversation-overview" hidden={contextual}>
    {chrome.anchorNotice && snapshot.host !== "adjacent" &&
      !(snapshot.host === "feedback" && !historyVisible && snapshot.threads.some(item =>
        item.thread.threadId === chrome.anchorThread && item.expanded && snapshot.filters[item.thread.status] &&
        chrome.anchorViews[item.thread.threadId]?.reason === chrome.anchorNotice)) &&
      <p className="conversation-notice" role="status">{chrome.anchorNotice}</p>}
    <div className="conversation-status" role="status" aria-label="Submission details"
      hidden={!readonly && !snapshot.resolutionUndo && (work || !snapshot.notice || snapshot.host === "adjacent") ? true : undefined}>
      {readonly && <span>{snapshot.status?.pendingMessageCount ?? 0} saved-unsent messages and {snapshot.status?.pendingEditCount ?? 0} edits remain read-only here.</span>}
      {!work && snapshot.notice && <span>{snapshot.notice}</span>}
      {snapshot.resolutionUndo && <Button size="xs" variant="outline" disabled={snapshot.busy || !!snapshot.uncertain}
        onClick={() => act(owner, owner.commands.undoResolve)}>Undo resolve</Button>}
    </div>
    {feedbackErrors.length > 0 && <RecoveryNotice messages={feedbackErrors}
      actions={<Button size="sm" variant="outline" onClick={() => act(owner, owner.commands.refresh)}>Refresh review</Button>} />}
    {snapshot.uncertain && <ReceiptRecovery uncertain={snapshot.uncertain} error={snapshot.error} busy={snapshot.busy}
      onRefresh={snapshot.connected && !feedbackErrors.length ? () => act(owner, () => owner.commands.refresh()) : undefined}
      onCheck={() => act(owner, () => owner.commands.reconcile(false))}
      onRetry={() => act(owner, () => owner.commands.reconcile(true))} />}
    <div className="conversation-filters" hidden={!!snapshot.focusId || historyVisible}>
      <SegmentedControl selection="multiple" aria-label="Conversation filters" hidden={!snapshot.threads.length}>{(["open", "resolved"] as const).map((kind) => <SegmentedControlItem key={kind} size="sm" selected={snapshot.filters[kind]}
        onClick={() => owner.commands.filter(kind)}>{kind === "open" ? "Open" : "Resolved"} ({snapshot.threads.filter((item) => item.thread.status === kind).length})</SegmentedControlItem>)}</SegmentedControl>
    </div>
    {(snapshot.captureNotice || chrome.captureError) && <p className="conversation-notice" role="status">{snapshot.captureNotice || chrome.captureError}</p>}
    </div>
    {navigatingReplies && <nav className="conversation-reply-navigation" aria-label="Reply navigation">
      <Button size="xs" variant="ghost" onClick={backToReplies}><Icon name="chevronLeft" size={14} />Back to replies</Button>
      <div>
        <IconButton aria-label="Previous reply"
          disabled={replyNavigationBusy || replyNavigation.index === 0}
          onClick={() => act(owner, () => navigateReply(replyNavigation.detail, replyNavigation.index - 1, replyNavigation.origin))}>
          <Icon name="chevronLeft" size={14} />
        </IconButton>
        <span role="status">{replyNavigation.index + 1} of {replyNavigation.detail.result!.responses.length}</span>
        <IconButton aria-label="Next reply"
          disabled={replyNavigationBusy || replyNavigation.index === replyNavigation.detail.result!.responses.length - 1}
          onClick={() => act(owner, () => navigateReply(replyNavigation.detail, replyNavigation.index + 1, replyNavigation.origin))}>
          <Icon name="chevronRight" size={14} />
        </IconButton>
      </div>
    </nav>}
    <div id="conversationInventory" className="conversation-inventory" ref={inventory} onScroll={() => {
      if (snapshot.open && !snapshot.focusId && inventory.current) {
        owner.rememberReadingPosition(historyVisible ? "history" : "inventory", "feedback", inventory.current.scrollTop);
        if (historyVisible) return;
        for (const article of inventory.current.querySelectorAll<HTMLElement>("[data-thread]")) {
          if (!article.hidden && article.dataset.thread) rememberExchange(owner, article.dataset.thread, article, inventory.current);
        }
      }
    }}>
      {snapshot.newMessage && <NewMessage shell={shell} snapshot={snapshot} chrome={chrome} />}
      <div hidden={!!snapshot.focusId || contextual || historyVisible}><LatestResult snapshot={snapshot} shell={shell} visible={!historyVisible} onReveal={revealReply} /></div>
      <DisclosureTrigger className="conversation-section-toggle" hidden={!snapshot.threads.length || !!snapshot.focusId || contextual || historyVisible}
        expanded={commentsExpanded} controls="conversationComments" onClick={() => setCommentsExpanded(value => !value)}>
        Comments ({snapshot.threads.length})
      </DisclosureTrigger>
      <div className="conversation-comments" id="conversationComments" hidden={historyVisible || (!commentsExpanded && !snapshot.focusId)}>
      {snapshot.threads.map((item) => <ThreadCard key={item.thread.threadId} owner={owner} item={item} snapshot={snapshot} shell={shell} chrome={chrome} navigatingReplies={navigatingReplies} />)}
      {!snapshot.threads.length && !snapshot.newMessage && <p className={snapshot.edits.length ? "conversation-empty-with-edits" : undefined}>Select text or a passage in the document to add a comment.</p>}
      </div>
      {(!!snapshot.edits.length || chrome.canRevert) && <section className="conversation-edits" aria-label="Your edits"
        hidden={!!snapshot.focusId || contextual || historyVisible}>
        <div className="feedback-edit-status">
          <DisclosureTrigger className="conversation-section-toggle" expanded={editsExpanded}
            controls="conversationEdits" onClick={() => setEditsExpanded(value => !value)}>
            Your edits ({snapshot.edits.length})
          </DisclosureTrigger>
          <Button className="feedback-revert" variant="destructive-ghost" size="sm" disabled={chrome.blocked || chrome.loading || !chrome.canRevert}
            onClick={() => owner.commands.confirm("revert")}>Revert</Button>
        </div>
        <ul id="conversationEdits" hidden={!editsExpanded} className="feedback-edit-list conversation-edit-list">{snapshot.edits.map(edit => <li key={edit.editId}>
          <div className="conversation-edit-heading"><span className="feedback-edit-label">{edit.content.label}</span>
            <Badge variant="outline">{edit.source.state === "saved" ? "Already saved" : "Source pending"}</Badge>
            <Badge variant="outline">{edit.content.kind}</Badge></div>
          <EditEvidence edit={edit} />
        </li>)}</ul>
      </section>}
      <div id="conversationHistory" hidden={!historyVisible}><History snapshot={snapshot} shell={shell} visible={historyVisible} onReveal={revealReply} /></div>
    </div>
    <footer className="conversation-footer" hidden={!!snapshot.focusId || contextual || historyVisible}>
      <div className="conversation-footer-controls">
      <DisclosureTrigger className="conversation-note-toggle" disabled={snapshot.note.composing}
        expanded={noteOpen} controls="conversationNoteDetails" onClick={() => setNoteExpanded(value => !value)}>
        Note to agent
        {snapshot.note.text.trim() && <span className="conversation-pending">Draft</span>}
      </DisclosureTrigger>
      </div>
      <div className="conversation-footer-details" hidden={!noteOpen}>
      <div className="conversation-note-content" id="conversationNoteDetails" hidden={!noteOpen}>
        <Draft owner={owner} id="note" draft={snapshot.note} disabled={readonly} saving={snapshot.busy || !!snapshot.uncertain} />
      </div>
      </div>
      <div className="conversation-footer-support" hidden={!snapshot.unsavedMessageDraftCount && (selection !== null || !snapshot.connected)}>
        <p id="sendSelectionDescription" className={selection ? "sr-only" : "feedback-help"} role="status">{selectionDescription}</p>
        {!!snapshot.unsavedMessageDraftCount && <p id="sendDraftExclusion" className="feedback-help" role="status">{snapshot.unsavedMessageDraftCount} unfinished {snapshot.unsavedMessageDraftCount === 1 ? "draft" : "drafts"} excluded from Send.</p>}
      </div>
      <div className="feedback-actions">
        <Button id="endReview" variant="ghost" className="feedback-end" disabled={disabled || chrome.loading} onClick={() => owner.commands.confirm("end")}>End review</Button>
        <Button id="send" className="feedback-send" aria-label="Send" aria-describedby={[snapshot.connected ? "sendSelectionDescription" : "conversationConnectionStatus", snapshot.unsavedMessageDraftCount ? "sendDraftExclusion" : ""].filter(Boolean).join(" ")} aria-busy={snapshot.busy}
          disabled={disabled || chrome.loading || snapshot.sendBlocked || !selection?.total || snapshot.note.composing}
          onClick={() => act(owner, owner.commands.send)}>{selection ? `Send to agent (${selection.total})` : "Send to agent"}</Button>
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
      {globalUncertain && <ReceiptRecovery uncertain={globalUncertain} error={snapshot.error} busy={snapshot.busy}
        onRefresh={snapshot.connected && !feedbackErrors.length ? () => act(owner, () => owner.commands.refresh()) : undefined}
        onCheck={() => act(owner, () => owner.commands.reconcile(false))}
        onRetry={() => act(owner, () => owner.commands.reconcile(true))} />}
      {!snapshot.connected && <span id="conversationConnectionStatus">Connection lost. Showing previously loaded information.</span>}
      {snapshot.connected && globalErrors.length > 0 && <RecoveryNotice messages={globalErrors.filter((value): value is string => !!value)}
        actions={<Button size="sm" variant="outline" onClick={() => act(owner, owner.commands.refresh)}>Refresh review</Button>} />}
      {!snapshot.connected && (snapshot.error || chrome.connectionError) && <details><summary>Connection details</summary>{snapshot.error}<br />{chrome.connectionError}</details>}
      {!snapshot.connected && outsideFeedback && chrome.sourceError && <RecoveryNotice messages={[`Source: ${chrome.sourceError}`]} />}
      {!snapshot.connected && <div className="review-recovery-actions"><Button size="sm" variant="outline"
        onClick={() => act(owner, shell.commands.reconnect)}>Reconnect</Button></div>}
      {chrome.themeSync.status === "failed" && <RecoveryNotice messages={[chrome.themeSync.message ?? "Review tools could not confirm the selected annotation theme."]}
        actions={<Button size="sm" variant="outline" onClick={() => act(owner, shell.commands.retryTheme)}>Retry theme</Button>} />}
      {needsSourceRecovery && <div className="review-recovery-actions"><Button size="sm" variant="destructive"
        onClick={() => act(owner, shell.commands.reload)}>Reload source (discard local page edits)</Button></div>}
    </div>}
    {createPortal(<>
      {panel}
    </>, document.body)}
    <AlertDialog open={!!snapshot.confirmation} onOpenChange={(open) => { if (!open) owner.commands.cancelConfirmation(); }}>
      <AlertDialogContent onOpenAutoFocus={() => {
        confirmationTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }} onCloseAutoFocus={(event) => {
        event.preventDefault();
        setRestoreConfirmationFocus(true);
      }}><AlertDialogHeader><AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
        <AlertDialogDescription>{snapshot.confirmation?.description}</AlertDialogDescription></AlertDialogHeader>
        {snapshot.error && <p role="alert">{snapshot.error}</p>}
        {snapshot.uncertain && <p role="status">Acceptance is unknown. Close this dialog and use Check receipt or Retry same request; do not repeat source work.</p>}
        <AlertDialogFooter><AlertDialogCancel disabled={snapshot.busy} onClick={owner.commands.cancelConfirmation}>Cancel</AlertDialogCancel>
          <Button variant={confirmation?.variant} aria-busy={snapshot.busy} disabled={snapshot.busy || !!snapshot.uncertain} onClick={() => act(owner, owner.commands.confirmAction)}>{confirmation?.verb}</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {createPortal(<div id="conversationChanges" hidden={!chrome.comparisonOpen}>
      {chrome.comparison ? <ConversationComparison shell={shell} chrome={chrome} snapshot={snapshot} /> :
        <section className="conversation-comparison review-ui" aria-label="Changes"
          onKeyDown={event => { if (event.key === "Escape") shell.commands.closeComparison(); }}>
          <div className="conversation-comparison-title"><Button variant="outline" size="sm" onClick={shell.commands.closeComparison}>Back to review</Button><h2>Changes</h2></div>
          <div className="conversation-empty-result">
          <p>{!snapshot.review || snapshot.loading ? "Loading review history..." : snapshot.history.some((item) => item.result)
            ? "No document changes reported. Read the agent replies in Feedback or the batch summaries in History."
            : snapshot.history.some((item) => item.state === "abandoned")
            ? "No handled submission is selected. Abandoned work does not have an accepted result."
            : "No handled submissions yet. Send feedback to receive a response and its available comparisons."}</p>
          <Button variant="outline" onClick={() => {
            shell.commands.closeComparison(); owner.commands.focus(null); setHistoryOpen(false);
          }}>Open Feedback</Button>
          </div>
        </section>}
    </div>, document.body)}
  </>;
}
