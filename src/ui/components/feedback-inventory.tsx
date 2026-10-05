import { Badge } from "./ui/badge";
import { Icon } from "./icon";

export type InventoryHint = "all" | "open" | "edits";
export function inventoryDescriptions(inventory: { openThreads: number; edits: number } | null) {
  const open = inventory ? `${inventory.openThreads} open conversations` : "Open conversation count unavailable";
  const edits = inventory ? `${inventory.edits} manual edits awaiting handling` : "Manual edit count unavailable";
  return { all: `${open}; ${edits}`, open: `${open}. Not the number ready to send.`, openLabel: open, edits };
}

export function FeedbackInventory({ inventory, onHint }: {
  inventory: { openThreads: number; edits: number } | null; onHint(hint: InventoryHint): void;
}) {
  const descriptions = inventoryDescriptions(inventory);
  return <Badge className="feedback-inventory-badge" variant="secondary">
    <span className="feedback-inventory-value" data-inventory="open" role="img" aria-label={descriptions.openLabel}
      onPointerEnter={() => onHint("open")} onPointerLeave={() => onHint("all")}>
      <Icon name="messages" size={12} className="size-3" /><span id="toolbarCount">{inventory?.openThreads ?? "…"}</span>
    </span>
    <span className="feedback-inventory-divider" aria-hidden="true" />
    <span className="feedback-inventory-value" data-inventory="edits" role="img" aria-label={descriptions.edits}
      onPointerEnter={() => onHint("edits")} onPointerLeave={() => onHint("all")}>
      <Icon name="pencil" size={12} className="size-3" /><span>{inventory?.edits ?? "…"}</span>
    </span>
  </Badge>;
}
