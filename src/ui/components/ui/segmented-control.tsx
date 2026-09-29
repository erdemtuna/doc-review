import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export function SegmentedControl({ className, selection = "single", ...props }: ComponentProps<"div"> & { selection?: "single" | "multiple" }) {
  return <div role="group" data-selection={selection} className={cn("segmented-control", className)} {...props} />;
}

export function SegmentedControlItem({ selected, ...props }:
  Omit<ComponentProps<typeof Button>, "variant" | "aria-pressed"> & { selected: boolean }) {
  return <Button {...props} variant={selected ? "secondary" : "ghost"} aria-pressed={selected} />;
}
