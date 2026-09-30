import type { ComponentProps } from "react";
import { Button } from "./button";
import { IconButton } from "./icon-button";
import { Icon } from "../icon";

type Props = Omit<ComponentProps<typeof Button>, "aria-expanded" | "aria-controls"> & {
  expanded: boolean;
  controls: string;
  iconOnly?: boolean;
  "aria-label"?: string;
};

export function DisclosureTrigger({ expanded, controls, iconOnly, children, ...props }: Props) {
  const icon = <Icon name={expanded ? "chevronDown" : "chevronRight"} />;
  return iconOnly
    ? <IconButton {...props} aria-label={props["aria-label"] ?? (expanded ? "Collapse" : "Expand")}
      aria-expanded={expanded} aria-controls={controls}>{icon}</IconButton>
    : <Button variant="ghost" size="sm" {...props} aria-expanded={expanded} aria-controls={controls}>{icon}{children}</Button>;
}
