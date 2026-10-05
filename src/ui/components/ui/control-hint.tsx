import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

export function ControlHint({ children, hint, disabled = false, dismissOnActivation = false }: {
  children: ReactNode; hint: ReactNode; disabled?: boolean; dismissOnActivation?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null), focusedScroll = useRef<Event | null>(null);
  const activated = useRef(false);
  const setTrigger = useCallback((node: HTMLElement | null) => { trigger.current = node; }, []);
  useLayoutEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!open || disabled) return;
    const scroll = (event: Event) => {
      if (document.activeElement === trigger.current && event.target instanceof Node && event.target.contains(trigger.current)) focusedScroll.current = event;
    };
    const enterFrame = (event: PointerEvent) => {
      if (event.target instanceof HTMLIFrameElement && document.activeElement !== trigger.current) setOpen(false);
    };
    window.addEventListener("scroll", scroll, true);
    document.addEventListener("pointerover", enterFrame, true);
    return () => {
      window.removeEventListener("scroll", scroll, true);
      document.removeEventListener("pointerover", enterFrame, true);
      focusedScroll.current = null;
    };
  }, [open, disabled]);
  return <TooltipProvider delayDuration={300}><Tooltip open={open && !disabled} onOpenChange={value => {
    if (disabled || value && activated.current) return;
    // Native focus scrolling must not immediately dismiss its keyboard hint.
    if (!value && focusedScroll.current?.eventPhase && document.activeElement === trigger.current) return;
    setOpen(value);
  }}>
    <TooltipTrigger asChild ref={setTrigger}
      onClick={() => { if (dismissOnActivation) { activated.current = true; setOpen(false); } }}
      onPointerLeave={() => { activated.current = false; }}
      onFocus={() => { activated.current = false; }}>{children}</TooltipTrigger>
    <TooltipContent onEscapeKeyDown={event => event.stopPropagation()}>{hint}</TooltipContent>
  </Tooltip></TooltipProvider>;
}
