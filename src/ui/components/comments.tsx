import { useLayoutEffect, useSyncExternalStore, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import type { CommentsController, CommentsSnapshot } from "../../comments-controller.js";
import { commentControlId, type CommentSurface } from "../../chrome-session.js";
import { tidyMiddle } from "../../anchor-text.js";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Textarea } from "./ui/textarea";
import { Icon } from "./icon";

type Card = CommentsSnapshot["cards"][number];
type Props = { runtime: CommentsController };

export function CommentCard({ runtime, card, state, surface = "drawer" }: Props & { card: Card; state: CommentsSnapshot; surface?: CommentSurface }) {
  const edit = state.ui.edit?.commentId === card.id ? state.ui.edit : null;
  const confirmation = state.ui.confirmation?.commentId === card.id ? state.ui.confirmation : null;
  const deleting = state.ui.confirmation?.status === "deleting";
  const blocked = state.disabled || deleting || (!!state.ui.edit && !edit);
  const remember = (event: SyntheticEvent<HTMLTextAreaElement>, composing = runtime.getSnapshot().ui.edit?.composing ?? false) => {
    const input = event.currentTarget;
    runtime.commands.updateEdit(card.id, {
      draft: input.value, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd, composing,
    });
  };
  return <article className={`comment inventory-card${card.active ? " active" : ""}`}
    data-id={card.id} data-surface={surface} onClick={() => {
      if (!edit && !confirmation) runtime.commands.activate(card.id, false);
    }}>
    <div className="inventory-card-head">
      <div className="inventory-meta">
        <span>You <span aria-hidden="true">&middot;</span> {card.age}</span>
        {card.correction ? <Badge variant="outline">correction</Badge>
          : card.edited && <Badge variant="secondary">edited</Badge>}
        {card.orphaned && <Badge variant="outline">orphaned</Badge>}
      </div>
      {!edit && !confirmation && <div className="inventory-actions" onClick={(event) => event.stopPropagation()}>
        {surface === "drawer" && <Button variant="ghost" size="icon" aria-label="Jump to" title="Jump to"
          disabled={blocked} onClick={() => runtime.commands.activate(card.id, true)}><Icon name="locate" /></Button>}
        <Button id={commentControlId(card.id, surface, "edit")} variant="ghost" size="icon"
          aria-label="Edit comment" title="Edit comment" disabled={blocked}
          onClick={() => runtime.commands.edit(card.id, surface)}><Icon name="pencil" /></Button>
        <Button id={commentControlId(card.id, surface, "delete")} variant="ghost" size="icon"
          className="hover:text-destructive focus-visible:text-destructive"
          aria-label="Delete comment" title="Delete comment" disabled={blocked}
          onClick={() => runtime.commands.confirm(card.id, surface)}><Icon name="trash" /></Button>
        {surface === "aligned" && <Button variant="ghost" size="icon" aria-label="Close comment card"
          title="Close comment card" disabled={state.disabled || deleting}
          onClick={runtime.commands.dismiss}><Icon name="x" /></Button>}
      </div>}
    </div>
    <p className="quote">{tidyMiddle(card.quote, 140)}</p>
    {edit ? <div onClick={(event) => event.stopPropagation()}>
      <Textarea className="body-edit" rows={3} value={edit.draft}
        data-comment-edit={card.id} aria-label="Edit comment text"
        aria-describedby={commentControlId(card.id, surface, "edit-help")}
        aria-invalid={!!edit.validation} readOnly={edit.status === "saving" || state.disabled}
        onChange={remember} onSelect={remember}
        onCompositionStart={(event) => remember(event, true)}
        onCompositionEnd={(event) => remember(event, false)}
        onKeyDown={(event) => {
          event.stopPropagation();
          remember(event);
          if ((event.key === "Enter" || event.key === "Escape") &&
            (runtime.getSnapshot().ui.edit?.composing || event.nativeEvent.isComposing)) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void runtime.commands.save(card.id);
          } else if (event.key === "Escape") {
            event.preventDefault();
            runtime.commands.cancelEdit(card.id);
          }
        }} />
      <p id={commentControlId(card.id, surface, "edit-help")} className="inventory-help">Enter to save &middot; Shift+Enter for new line</p>
      {edit.validation && <p role="alert" className="inventory-error">{edit.validation}</p>}
      <div className="inventory-actions">
        <Button disabled={edit.status === "saving" || state.disabled} onClick={() => { void runtime.commands.save(card.id); }}>
          {edit.status === "saving" ? "Saving..." : "Save"}
        </Button>
        <Button variant="outline" disabled={edit.status === "saving" || state.disabled}
          onClick={() => runtime.commands.cancelEdit(card.id)}>Cancel</Button>
      </div>
    </div> : confirmation ? <div onClick={(event) => event.stopPropagation()}>
      <p className="inventory-delete">Delete this comment?</p>
      <div className="inventory-actions">
        <Button variant="outline" disabled={confirmation.status === "deleting" || state.disabled}
          onClick={() => runtime.commands.cancelDelete(card.id)}>Cancel</Button>
        <Button id={commentControlId(card.id, surface, "confirm-delete")} variant="destructive"
          disabled={confirmation.status === "deleting" || state.disabled} onClick={() => { void runtime.commands.remove(card.id); }}>
          {confirmation.status === "deleting" ? "Deleting..." : "Delete"}
        </Button>
      </div>
    </div> : <p className="body" title="Click to edit" onClick={(event) => {
      event.stopPropagation();
      runtime.commands.edit(card.id, surface);
    }}>{card.feedback}</p>}
  </article>;
}

export function CommentsInventory({ runtime }: Props) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  return <>
    <section aria-labelledby="inventoryHeading">
      <div className="inventory-heading"><h3 id="inventoryHeading">Comments</h3><Badge id="count" variant="secondary">{state.cards.length}</Badge></div>
      {state.loading && <p role="status" className="inventory-empty">Loading comments...</p>}
      {state.error && <p role="alert" className="inventory-error">{state.error}</p>}
      <div id="cards" className="inventory-cards">
        {state.cards.map((card) => <CommentCard key={card.id} runtime={runtime} card={card} state={state} />)}
      </div>
      <p id="empty" className="inventory-empty" hidden={!state.showEmpty}>Select text or focus an element, then use the comment button</p>
    </section>
    <section id="othersBox" hidden={state.others.length === 0} aria-labelledby="otherPagesHeading">
      <div className="inventory-heading"><h3 id="otherPagesHeading">Other pages</h3><Badge id="othersCount" variant="secondary">{state.others.length}</Badge></div>
      <div id="othersList" className="inventory-other-pages">
        {state.others.map((page) => <Button key={page.key} variant="ghost" className="inventory-other-page"
          disabled={state.disabled} onClick={() => { void runtime.commands.navigate(page.key); }}>
          <span title={page.filename}>{page.filename}</span><Badge variant="secondary">{page.count}</Badge>
        </Button>)}
      </div>
    </section>
  </>;
}

export function CommentsDrawer({ runtime, drawer, header, inventory, backdrop }: Props & {
  drawer: HTMLElement; header: HTMLElement; inventory: HTMLElement; backdrop: HTMLElement;
}) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  useLayoutEffect(() => {
    // Stable portal hosts keep inventory, edits and the note mounted when closed.
    drawer.classList.toggle("open", state.open);
    drawer.setAttribute("aria-hidden", String(!state.open));
    drawer.inert = !state.open;
  }, [drawer, state.open]);
  return <>
    {createPortal(<div className="inventory-drawer-head">
      <div><span className="inventory-help">Review</span><h2 id="drawerTitle">Comments</h2></div>
      <Button id="drawerClose" variant="ghost" size="icon" aria-label="Close review drawer"
        title="Close review drawer" onClick={runtime.commands.close}><Icon name="x" /></Button>
    </div>, header)}
    {createPortal(<CommentsInventory runtime={runtime} />, inventory)}
    {createPortal(<div className="drawer-backdrop" id="drawerBackdrop" hidden={!state.open}
      onClick={runtime.commands.close} />, backdrop)}
  </>;
}
