import { Toast } from "radix-ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ConversationController } from "../../conversation-controller";
import { IconButton } from "./ui/icon-button";
import { Icon } from "./icon";

type Notification = NonNullable<ReturnType<ConversationController["getSnapshot"]>["notification"]>;
type Dismiss = (id: string) => void;

function LifecycleToast({ notification, onDismiss }: { notification: Notification; onDismiss: Dismiss }) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const remaining = useRef(5000);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const paused = hovered || focused || hidden;
  useEffect(() => {
    if (paused) return;
    const start = Date.now();
    const timer = window.setTimeout(() => onDismiss(notification.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - start));
    };
  }, [paused, notification.id, onDismiss]);
  // Radix's window-blur timer also pauses when the user focuses the document iframe.
  // Own the deadline, pausing only for notification interaction or a hidden page.
  return <Toast.Root className="conversation-toast" open type="background" duration={Infinity}
    onOpenChange={open => { if (!open) onDismiss(notification.id); }}
    onPointerMove={event => { if (event.pointerType !== "touch") setHovered(true); }}
    onPointerLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
    <Toast.Description>{notification.message}</Toast.Description>
    <Toast.Close asChild><IconButton aria-label="Dismiss notification"><Icon name="x" /></IconButton></Toast.Close>
  </Toast.Root>;
}

export function ConversationNotification({ notification, onDismiss }: {
  notification: Notification | null;
  onDismiss: Dismiss;
}) {
  const viewport = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const node = viewport.current, toolbar = document.querySelector(".shell-toolbar");
    if (!node || !toolbar) return;
    const position = () => { node.style.top = `${Math.max(0, toolbar.getBoundingClientRect().bottom) + 8}px`; };
    const observer = new ResizeObserver(position);
    observer.observe(toolbar);
    position();
    return () => observer.disconnect();
  }, []);
  return <Toast.Provider duration={Infinity} label="Review notification">
    {notification && <LifecycleToast key={notification.id} notification={notification} onDismiss={onDismiss} />}
    <Toast.Viewport ref={viewport} className="conversation-toast-viewport review-ui" label="Review notifications ({hotkey})" />
  </Toast.Provider>;
}
