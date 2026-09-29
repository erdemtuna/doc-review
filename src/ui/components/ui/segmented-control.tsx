import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export function SegmentedControl({ className, variant, ...props }: ComponentProps<"div"> & { variant?: "navigation" }) {
  return <div role="group" className={cn("segmented-control", variant === "navigation" && "segmented-control-navigation", className)} {...props} />;
}

export function SegmentedControlItem({ selected, ...props }:
  Omit<ComponentProps<typeof Button>, "variant" | "aria-pressed"> & { selected: boolean }) {
  return <Button {...props} variant={selected ? "secondary" : "ghost"} aria-pressed={selected} />;
}
