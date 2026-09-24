import type { ComponentProps } from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({ className, sideOffset = 8, collisionPadding = 12, ...props }: ComponentProps<typeof TooltipPrimitive.Content>) {
  return <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content data-slot="tooltip-content" sideOffset={sideOffset} collisionPadding={collisionPadding}
      className={cn("review-ui z-(--review-layer-menu) max-w-[min(20rem,calc(100vw-1.5rem))] max-h-(--radix-tooltip-content-available-height) overflow-auto rounded-lg border border-border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-md wrap-anywhere", className)}
      {...props} />
  </TooltipPrimitive.Portal>;
}
