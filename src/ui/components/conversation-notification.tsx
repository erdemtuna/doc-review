import { Toast } from "radix-ui";
import { useLayoutEffect, useRef } from "react";
import type { ConversationController } from "../../conversation-controller";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { Icon } from "./icon";

export function ConversationNotification({ notification, onDismiss, onUndo, busy }: {
  notification: ReturnType<ConversationController["getSnapshot"]>["notification"];
  onDismiss(id: string): void;
  onUndo?: () => void;
  busy: boolean;
}) {
  const viewport = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!notification || !node) return;
    const controls = [...document.querySelectorAll<HTMLElement>(
      ".conversation-panel .conversation-footer, .conversation-thread .conversation-reply, .conversation-thread .conversation-composer",
    )];
    const position = () => {
      const bounds = node.getBoundingClientRect();
      let bottom = 16;
      const boxes = controls.map(control => control.getBoundingClientRect()).sort((a, b) => b.top - a.top);
      for (const box of boxes) {
        if (box.width && box.height && box.top >= 0 && box.bottom <= window.innerHeight &&
          box.left < bounds.right && box.right > bounds.left &&
          box.top < window.innerHeight - bottom && box.bottom > window.innerHeight - bottom - bounds.height) {
          bottom = window.innerHeight - box.top + 8;
        }
      }
      node.style.bottom = `${Math.max(16, Math.min(bottom, window.innerHeight - bounds.height - 16))}px`;
    };
    const observer = new ResizeObserver(position);
    observer.observe(node);
    for (const control of controls) observer.observe(control);
    const panel = document.querySelector(".conversation-panel");
    if (panel) observer.observe(panel);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    position();
    return () => {
      observer.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true);
    };
  });
  return <Toast.Provider duration={5000} label="Review notification">
    {notification && <Toast.Root key={notification.id} className="conversation-toast" open type="background"
      duration={busy ? Infinity : 5000} onOpenChange={open => { if (!open && !busy) onDismiss(notification.id); }}
      onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
      <Toast.Description>{notification.message}</Toast.Description>
      {onUndo && <Toast.Action asChild altText="You can also reopen this conversation from the Resolved filter.">
        <Button variant="outline" size="xs" disabled={busy} aria-busy={busy}
          onClick={event => { event.preventDefault(); onUndo(); }}>Undo resolve</Button>
      </Toast.Action>}
      <Toast.Close asChild><IconButton aria-label="Dismiss notification" disabled={busy}><Icon name="x" /></IconButton></Toast.Close>
    </Toast.Root>}
    <Toast.Viewport ref={viewport} className="conversation-toast-viewport review-ui" label="Review notifications ({hotkey})" />
  </Toast.Provider>;
}
