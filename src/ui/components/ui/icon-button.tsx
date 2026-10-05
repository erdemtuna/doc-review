import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { Button } from "./button";
import { ControlHint } from "./control-hint";

export const IconButton = forwardRef<HTMLButtonElement,
  Omit<ComponentProps<typeof Button>, "title" | "aria-label"> & { "aria-label": string; hint?: ReactNode }
>(function IconButton({ hint, size = "icon-xs", variant = "ghost", ...props }, ref) {
  return <ControlHint hint={hint ?? props["aria-label"]}>
    <Button {...props} ref={ref} size={size} variant={variant} />
  </ControlHint>;
});
