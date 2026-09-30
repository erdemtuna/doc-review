import { useLayoutEffect, useRef, useState } from "react";
import { ControlHint, IconButton } from "./ui/icon-button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "./ui/dropdown-menu";
import { Icon, type IconName } from "./icon";
import type { ConversationTarget } from "../../contracts/feedback";
import { cn } from "@/lib/utils";

type ConversationAction = { label: string; disabled?: boolean; destructive?: boolean; run(): void };

export function ConversationAuthor({ role }: { role: "You" | "Agent" }) {
  return <span className="conversation-author"><span className="conversation-avatar" aria-hidden="true">{role === "You" ? "Y" : "A"}</span><strong>{role}</strong></span>;
}

const statuses = {
  "not-sent": { icon: "circleDashed", label: "Not sent", hint: "Saved. Choose Send to agent when you're ready.", modified: false },
  sent: { icon: "send", label: "Sent", hint: "Your message was sent to the agent.", modified: false },
  received: { icon: "checkCheck", label: "Received", hint: "The agent has your message.", modified: false },
  "request-change": { icon: "messageSquareDiff", label: "Change requested", hint: "You asked the agent to change the document.", modified: true },
  resolved: { icon: "circleCheck", label: "Resolved", hint: "This conversation is resolved.", modified: false },
  answered: { icon: "messageSquareCheck", label: "Answered", hint: "The agent replied to your message.", modified: false },
  applied: { icon: "filePenLine", label: "Change reported", hint: "The agent says the requested change is complete.", modified: true },
  "clarification-needed": { icon: "messageCircleQuestion", label: "Needs clarification", hint: "The agent needs your input before continuing.", modified: true },
  deferred: { icon: "circlePause", label: "Deferred", hint: "The agent left this request for later.", modified: false },
} satisfies Record<string, { icon: IconName; label: string; hint: string; modified: boolean }>;

export function ConversationStatus({ kind, ended = false, className }: { kind: keyof typeof statuses; ended?: boolean; className?: string }) {
  const status = statuses[kind];
  const hint = kind === "not-sent" && ended ? "Not sent; this review has ended and this saved message is read-only." : status.hint;
  return <ControlHint hint={<>{status.label}. {hint}</>}><span className={cn("conversation-status-icon", className)} data-status-icon={kind}
    data-modified={status.modified} role="img" aria-label={status.label} tabIndex={0}>
    <Icon name={status.icon} size={14} />
  </span></ControlHint>;
}

export function ConversationIntent() {
  return <ConversationStatus kind="request-change" />;
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
      <IconButton ref={trigger} className="conversation-icon" data-thread-actions
        aria-label="Conversation actions"><Icon name="moreHorizontal" /></IconButton>
    </DropdownMenuTrigger>
    {open && <DropdownMenuContent ref={content} align="end" collisionPadding={12}
      onEscapeKeyDown={(event) => { if (current.current) event.stopPropagation(); }}
      onInteractOutside={(event) => {
        if (event.target instanceof Node && trigger.current?.contains(event.target)) event.preventDefault();
        else outside.current = true;
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        const active = document.activeElement;
        const handedOff = active && active !== document.body && active !== trigger.current && !content.current?.contains(active);
        if (!current.current && !outside.current && !handedOff && trigger.current?.isConnected &&
          !trigger.current.closest("[hidden], [inert]")) trigger.current.focus({ preventScroll: true });
      }}>
      {actions.map((action) => <DropdownMenuItem key={action.label} disabled={action.disabled}
        variant={action.destructive ? "destructive" : "default"} onSelect={() => {
          trigger.current?.focus({ preventScroll: true });
          action.run();
        }}>{action.label}</DropdownMenuItem>)}
    </DropdownMenuContent>}
  </DropdownMenu>;
}

export function ConversationTime({ value }: { value: number }) {
  const date = new Date(value), full = date.toLocaleString();
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60000));
  const age = minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440
    ? `${Math.floor(minutes / 60)}h ago` : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return <ControlHint hint={full}><time className="conversation-time" tabIndex={0}
    dateTime={date.toISOString()} aria-label={full}>{age}</time></ControlHint>;
}
