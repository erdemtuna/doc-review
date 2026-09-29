import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "./ui/dropdown-menu";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { Icon } from "./icon";
import type { ConversationTarget } from "../../contracts/feedback";

type ConversationAction = { label: string; disabled?: boolean; destructive?: boolean; run(): void };

export function ConversationAuthor({ role }: { role: "You" | "Agent" }) {
  return <span className="conversation-author"><span className="conversation-avatar" aria-hidden="true">{role === "You" ? "Y" : "A"}</span><strong>{role}</strong></span>;
}

export function ConversationIntent() {
  return <span className="conversation-intent-icon" role="img" aria-label="Change requested" title="Change requested" tabIndex={0}>
    <Icon name="filePenLine" size={14} />
  </span>;
}

export function ConversationSource({ target }: { target: ConversationTarget }) {
  if (target.kind === "selection") return <div className="conversation-source">
    <span className="conversation-target-quote" title={`Selected text: "${target.anchor.quote}"`}>"{target.anchor.quote}"</span>
  </div>;
  const label = target.anchor.label ?? "";
  const generated = /^(.*?) \u00b7 (p|li|h[1-6]|div|section|article|blockquote|table|pre)(?: (\d+))?$/.exec(label);
  const names: Record<string, string> = { p: "Paragraph", li: "List item", div: "Block", section: "Section", article: "Article", blockquote: "Quotation", table: "Table", pre: "Code block" };
  const description = generated ? `${names[generated[2]] ?? "Heading"}${generated[3] ? ` ${generated[3]}` : ""} near "${generated[1]}"` : label || "Document element";
  return <div className="conversation-source">
    <span className="conversation-target-quote" title={description}>{generated?.[1] || label || "Document"}</span>
  </div>;
}

export function ConversationMenu({ actions }: { actions: ConversationAction[] }) {
  const [open, setOpen] = useState(false);
  const current = useRef(open), outside = useRef(false);
  current.current = open;
  const trigger = useRef<HTMLButtonElement>(null), content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (open) content.current?.focus({ preventScroll: true }); }, [open]);
  return <DropdownMenu modal={false} open={open} onOpenChange={(value) => {
    if (value) outside.current = false;
    setOpen(value);
  }}>
    <DropdownMenuTrigger asChild>
      <Button ref={trigger} variant="ghost" size="icon-xs" className="conversation-icon" data-thread-actions
        aria-label="Conversation actions" title="Conversation actions"><Icon name="moreHorizontal" /></Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent ref={content} align="end" collisionPadding={12}
      onEscapeKeyDown={(event) => { if (current.current) event.stopPropagation(); }}
      onInteractOutside={(event) => {
        if (event.target instanceof Node && trigger.current?.contains(event.target)) event.preventDefault();
        else outside.current = true;
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        const active = document.activeElement;
        const handedOff = active && active !== document.body && active !== trigger.current && !content.current?.contains(active);
        if (!current.current && !outside.current && !handedOff) trigger.current?.focus({ preventScroll: true });
      }}>
      {actions.map((action) => <DropdownMenuItem key={action.label} disabled={action.disabled}
        variant={action.destructive ? "destructive" : "default"} onSelect={() => {
          trigger.current?.focus({ preventScroll: true });
          action.run();
        }}>{action.label}</DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

export function ConversationTime({ value }: { value: number }) {
  const date = new Date(value), full = date.toLocaleString();
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60000));
  const age = minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440
    ? `${Math.floor(minutes / 60)}h ago` : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLTimeElement>(null);
  useEffect(() => {
    if (!open) return;
    const leaveFrame = (event: PointerEvent) => {
      if (event.target instanceof HTMLIFrameElement && document.activeElement !== trigger.current) setOpen(false);
    };
    document.addEventListener("pointerover", leaveFrame, true);
    return () => document.removeEventListener("pointerover", leaveFrame, true);
  }, [open]);
  return <TooltipProvider delayDuration={300}><Tooltip open={open} onOpenChange={setOpen}>
    <TooltipTrigger asChild><time ref={trigger} className="conversation-time" tabIndex={0}
      dateTime={date.toISOString()} aria-label={full}>{age}</time></TooltipTrigger>
    <TooltipContent onEscapeKeyDown={(event) => event.stopPropagation()}>{full}</TooltipContent>
  </Tooltip></TooltipProvider>;
}
