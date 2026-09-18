import { useEffect, useLayoutEffect, useRef } from "react";
import { Button } from "./button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "./dropdown-menu";
import { Icon } from "../icon";

export type ChoiceOption = { readonly value: string; readonly label: string };
type Props = {
  id: string;
  label: string;
  value: string;
  options: readonly ChoiceOption[];
  triggerLabel: string;
  valueLabel?: string;
  textId?: string;
  disabled?: boolean;
  open: boolean;
  restoreFocus: boolean;
  onOpenChange(open: boolean): void;
  onValueChange(value: string): void;
};

export function ChoiceMenu(props: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const current = useRef(props);
  const returnFocus = useRef(true);
  const chosen = useRef<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const visibleTrigger = () => trigger.current?.isConnected && !trigger.current.closest("[hidden], [inert]");
  useLayoutEffect(() => {
    current.current = props;
    if (props.open || !props.restoreFocus) pendingFocus.current = null;
    if (pendingFocus.current !== null && !props.disabled) {
      const value = pendingFocus.current;
      pendingFocus.current = null;
      if (props.value === value && !props.open && props.restoreFocus && visibleTrigger() &&
        document.activeElement === document.body) trigger.current?.focus({ preventScroll: true });
    }
  });
  useEffect(() => {
    const cancel = () => { pendingFocus.current = null; chosen.current = null; returnFocus.current = false; };
    const focused = (event: FocusEvent) => { if (event.target !== document.body) cancel(); };
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("keydown", cancel, true);
    document.addEventListener("focusin", focused, true);
    return () => {
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("keydown", cancel, true);
      document.removeEventListener("focusin", focused, true);
    };
  }, []);
  const selected = props.options.find((option) => option.value === props.value);
  const menuId = `${props.id}Menu`;
  const open = props.open && !props.disabled;
  return <DropdownMenu modal={false} open={open} onOpenChange={(next) => {
    if (next) { returnFocus.current = true; chosen.current = null; pendingFocus.current = null; }
    props.onOpenChange(next);
  }}>
    <DropdownMenuTrigger asChild>
      <Button id={props.id} ref={trigger} variant="outline" className="choice-trigger min-w-0 shrink"
        data-value={props.value} disabled={props.disabled}
        aria-label={`${props.label}: ${props.valueLabel || selected?.label || props.triggerLabel}`}
        title={selected?.label || props.triggerLabel} aria-controls={open ? menuId : undefined}>
        <span id={props.textId} className="choice-label" aria-live={props.textId ? "polite" : undefined}>{props.triggerLabel}</span>
        <Icon name="chevronDown" />
      </Button>
    </DropdownMenuTrigger>
    {open && <DropdownMenuContent id={menuId} aria-labelledby={props.id}
      className="w-80 max-w-[calc(100vw-1.5rem)] max-h-[min(22rem,var(--radix-dropdown-menu-content-available-height))]" collisionPadding={12}
      onEscapeKeyDown={(event) => { returnFocus.current = true; event.stopPropagation(); }}
      onInteractOutside={(event) => {
        if (event.target instanceof Node && trigger.current?.contains(event.target)) event.preventDefault();
        else returnFocus.current = false;
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        const latest = current.current;
        if (!latest.open && latest.restoreFocus && returnFocus.current &&
          (document.activeElement === document.body || document.activeElement === trigger.current)) {
          // A selected page can temporarily lose its target list while loading.
          if (latest.disabled || !visibleTrigger()) pendingFocus.current = chosen.current;
          else trigger.current?.focus({ preventScroll: true });
        }
        chosen.current = null;
      }}>
      <DropdownMenuRadioGroup value={props.value} onValueChange={(value) => {
        const latest = current.current;
        if (!latest.open || latest.disabled || !latest.options.some((option) => option.value === value)) return;
        returnFocus.current = true;
        chosen.current = value;
        latest.onOpenChange(false);
        latest.onValueChange(value);
      }}>
        {props.options.map((option) => <DropdownMenuRadioItem key={option.value} value={option.value}
          data-choice-value={option.value} textValue={option.label} className="min-h-8 whitespace-normal p-2 pr-8 wrap-anywhere">
          {option.label}
        </DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>}
  </DropdownMenu>;
}
