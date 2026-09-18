import { createElement } from "react";
import { ICON_NODES } from "../../icons.js";
import { cn } from "@/lib/utils";

export type IconName = keyof typeof ICON_NODES;
type IconNode = readonly [string, Record<string, string>];
const shapes = new Set(["path", "circle", "ellipse", "line", "polyline", "polygon", "rect"]);
const attributes = new Set(["d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "x2", "y1", "y2", "width", "height", "points"]);

function isIconNode(value: unknown): value is IconNode {
  return Array.isArray(value) && value.length === 2 && shapes.has(value[0]) &&
    typeof value[1] === "object" && value[1] !== null &&
    Object.entries(value[1]).every(([key, entry]) => attributes.has(key) && typeof entry === "string");
}

export function Icon({ name, className, size = 16, label }: {
  name: IconName;
  className?: string;
  size?: number;
  label?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={cn("shrink-0", className)} role={label ? "img" : undefined}
      aria-label={label} aria-hidden={label ? undefined : true}>
      {ICON_NODES[name].map((node, index) => {
        if (!isIconNode(node)) throw new Error(`Invalid icon geometry: ${name}`);
        return createElement(node[0], { ...node[1], key: index });
      })}
    </svg>
  );
}
