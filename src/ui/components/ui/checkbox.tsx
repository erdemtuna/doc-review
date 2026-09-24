import type { ComponentProps } from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";

export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return <CheckboxPrimitive.Root data-slot="checkbox"
    className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded border border-input bg-background text-primary-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=checked]:border-primary data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50", className)}
    {...props}>
    <CheckboxPrimitive.Indicator><Icon name="check" className="size-3" /></CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>;
}
