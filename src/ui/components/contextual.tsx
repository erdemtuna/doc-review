import { useLayoutEffect, useRef, useSyncExternalStore, type SyntheticEvent } from "react";
import type { ContextualController } from "../../contextual-controller.js";
import type { CommentsController } from "../../comments-controller.js";
import { tidyMiddle } from "../../anchor-text.js";
import { CommentCard } from "./comments";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Textarea } from "./ui/textarea";
import { Icon } from "./icon";

export function Composer({ runtime }: { runtime: ContextualController }) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!state.open) return;
    const draft = runtime.getSnapshot().draft;
    input.current?.setSelectionRange(draft.selectionStart, draft.selectionEnd);
    runtime.commands.measure();
  }, [runtime, state.open]);
  useLayoutEffect(() => { runtime.commands.measure(); }, [runtime, state.draft.error, state.quote, state.placement]);
  const remember = (event: SyntheticEvent<HTMLTextAreaElement>, composing = runtime.getSnapshot().draft.composing) => {
    const field = event.currentTarget;
    runtime.commands.update({ text: field.value, selectionStart: field.selectionStart, selectionEnd: field.selectionEnd, composing });
  };
  const busy = state.submitting || state.disabled;
  const edge = state.placement === "edge-top" || state.placement === "edge-bottom";
  return <div onFocus={runtime.commands.focus} onMouseDown={(event) => {
    if (event.target instanceof Element && !event.target.closest("button") && event.target !== input.current) input.current?.focus();
  }}>
    <div className="compose-head">
      <div><Badge id="composeKind" variant="secondary">{state.kind === "element" ? "Element" : "Selection"}</Badge><strong id="composeTitle">Add comment</strong></div>
      <Button id="composeClose" variant="ghost" size="icon" title="Cancel comment" aria-label="Cancel comment"
        disabled={busy} onClick={runtime.commands.cancel}><Icon name="x" /></Button>
    </div>
    <div id="composeDirection" className="contextual-direction" hidden={!edge}>
      <span id="composeDirectionText">{state.placement === "edge-top" ? "Selection is above" : "Selection is below"}</span>
      <Button id="composeReveal" variant="ghost" className="text-xs" onClick={runtime.commands.reveal}>Back to selection</Button>
    </div>
    <p className="quote" id="composeQuote">{tidyMiddle(state.quote, 260)}</p>
    <Textarea ref={input} id="composeText" rows={3} placeholder="What should change?" aria-label="Comment"
      aria-describedby={`composeHelp${state.draft.error ? " composeError" : ""}`} readOnly={busy}
      value={state.draft.text} onChange={remember} onSelect={remember}
      onCompositionStart={(event) => remember(event, true)} onCompositionEnd={(event) => remember(event, false)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== "Escape") return;
        event.stopPropagation();
        remember(event);
        if (event.nativeEvent.isComposing || runtime.getSnapshot().draft.composing) return;
        if (event.key === "Enter" && event.shiftKey) return;
        event.preventDefault();
        if (event.key === "Escape") runtime.commands.cancel();
        else void runtime.commands.submit();
      }} />
    <p id="composeHelp" className="compose-help"><span>Enter to comment</span><span>Shift+Enter for new line</span></p>
    <p id="composeError" className="inventory-error" role="alert" hidden={!state.draft.error}>{state.draft.error}</p>
    <div className="compose-actions">
      <Button id="composeAdd" disabled={busy} onClick={() => { void runtime.commands.submit(); }}><Icon name="messageSquarePlus" />
        <span id="composeAddLabel">{state.submitting ? "Saving..." : state.draft.retry ? "Retry" : "Comment"}</span>
      </Button>
      <Button id="composeCancel" variant="outline" disabled={busy} onClick={runtime.commands.cancel}>Cancel</Button>
    </div>
  </div>;
}

export function AlignedComment({ runtime, measure }: { runtime: CommentsController; measure(): void }) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const card = state.cards.find((item) => item.id === state.activeId);
  useLayoutEffect(measure, [measure, card, state.ui, state.open]);
  return card && !state.open ? <CommentCard runtime={runtime} card={card} state={state} surface="aligned" /> : null;
}
