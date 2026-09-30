import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export function FilterButton({ selected, children, className, ...props }:
  Omit<ComponentProps<typeof Button>, "variant" | "aria-pressed"> & { selected: boolean }) {
  return <Button size="sm" {...props} variant="outline" aria-pressed={selected}
    className={cn("filter-button", className)}>
    {children}
  </Button>;
}
