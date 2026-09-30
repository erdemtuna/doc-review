import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

const tones = {
  neutral: "bg-muted text-muted-foreground",
  waiting: "bg-[var(--annotation-background)] text-[var(--annotation-foreground)]",
  response: "bg-accent text-accent-foreground",
  changed: "bg-review-added text-review-added-foreground",
};

export function Timeline({ className, ...props }: ComponentProps<"ol">) {
  return <ol data-slot="timeline" role="list" className={cn("m-0 list-none p-0", className)} {...props} />;
}

export function TimelineItem({ icon, tone = "neutral", className, children, ...props }: ComponentProps<"li"> & {
  icon: ReactNode; tone?: keyof typeof tones;
}) {
  return <li data-slot="timeline-item" data-tone={tone}
    className={cn("relative min-h-6 pb-6 pl-9 before:absolute before:top-3 before:-bottom-3 before:left-3 before:border-l before:border-border last:pb-0 last:before:hidden", className)} {...props}>
    <span aria-hidden="true" data-slot="timeline-marker"
      className={cn("absolute top-0 left-0 z-10 flex size-6 items-center justify-center rounded-full", tones[tone])}>{icon}</span>
    {children}
  </li>;
}
