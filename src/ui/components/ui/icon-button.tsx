import { forwardRef, useCallback, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "./button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

export function ControlHint({ children, hint }: { children: ReactNode; hint: ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null), focusedScroll = useRef<Event | null>(null);
  const setTrigger = useCallback((node: HTMLElement | null) => { trigger.current = node; }, []);
  useLayoutEffect(() => {
    if (!open) return;
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
  }, [open]);
  return <TooltipProvider delayDuration={300}><Tooltip open={open} onOpenChange={value => {
    // Native focus scrolling must not immediately dismiss its keyboard hint.
    // Event phase confines this exception to the scroll dispatch, not later Escape/clicks.
    if (!value && focusedScroll.current?.eventPhase && document.activeElement === trigger.current) return;
    setOpen(value);
  }}>
    <TooltipTrigger asChild ref={setTrigger}>{children}</TooltipTrigger>
    <TooltipContent onEscapeKeyDown={event => event.stopPropagation()}>{hint}</TooltipContent>
  </Tooltip></TooltipProvider>;
}

export const IconButton = forwardRef<HTMLButtonElement,
  Omit<ComponentProps<typeof Button>, "title" | "aria-label"> & { "aria-label": string; hint?: ReactNode }
>(function IconButton({ hint, size = "icon-xs", variant = "ghost", ...props }, ref) {
  return <ControlHint hint={hint ?? props["aria-label"]}>
    <Button {...props} ref={ref} size={size} variant={variant} />
  </ControlHint>;
});
