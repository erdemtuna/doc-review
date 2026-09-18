import type { ReactNode } from "react";
import { Button } from "./button";
import { Badge } from "./badge";
import { Icon } from "../icon";

export function DisclosureSection({ label, headingId, countId, contentId, count, open,
  onOpenChange, disabled = false, lockReason = "", status, children }: {
  label: string; headingId: string; countId: string; contentId: string; count: number;
  open: boolean; onOpenChange(open: boolean): void; disabled?: boolean;
  lockReason?: string; status?: ReactNode; children: ReactNode;
}) {
  const helpId = `${contentId}Help`;
  return <section className="feedback-disclosure" aria-labelledby={headingId} data-open={open}>
    <h3 id={headingId} aria-label={label}>
      <Button id={`${contentId}Toggle`} variant="ghost"
        className="feedback-disclosure-trigger h-auto justify-start gap-2 rounded-sm px-0 py-2.5 text-[13px] font-semibold aria-expanded:bg-transparent"
        aria-label={label} aria-expanded={open} aria-controls={contentId}
        aria-describedby={[countId, lockReason ? helpId : ""].filter(Boolean).join(" ")}
        aria-disabled={disabled || !!lockReason} disabled={disabled}
        onClick={() => { if (!lockReason) onOpenChange(!open); }}>
        <Icon name="chevronDown" size={14} className="disclosure-chevron size-3.5" />
        <span>{label}</span><Badge id={countId} variant="secondary">{count}</Badge>
      </Button>
    </h3>
    {lockReason && <p id={helpId} className="inventory-help disclosure-help">{lockReason}</p>}
    {status}
    <div id={contentId} className="feedback-disclosure-content" hidden={!open}>{children}</div>
  </section>;
}
