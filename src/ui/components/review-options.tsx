import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanonicalPage } from "../../contracts/page-boundary";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { IconButton } from "./ui/icon-button";
import { Icon } from "./icon";

export function ReviewOptions({ open, onOpenChange, theme, onThemeChange, target, loading = false, disabled = false }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  theme: "light" | "dark";
  onThemeChange(theme: "light" | "dark"): void;
  target?: CanonicalPage["target"] | null;
  loading?: boolean;
  disabled?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null), content = useRef<HTMLDivElement>(null);
  const outside = useRef(false), request = useRef(0);
  const pending = useRef<number | null>(null);
  const restoringFocus = useRef(false);
  const current = useRef({ open, target, loading });
  current.current = { open, target, loading };
  const [copy, setCopy] = useState<{ state: "idle" | "copying" | "copied" | "failed"; message: string }>({ state: "idle", message: "" });
  const location = target?.kind === "file" ? target.path : target?.url;
  const name = target?.kind === "file" ? target.path.split(/[\\/]/).at(-1) : target?.url;
  useEffect(() => {
    request.current++;
    pending.current = null;
    setCopy({ state: "idle", message: "" });
  }, [location, loading, open]);
  useEffect(() => {
    const close = () => { outside.current = true; onOpenChange(false); };
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [onOpenChange]);
  useLayoutEffect(() => { if (open) content.current?.focus({ preventScroll: true }); }, [open]);
  async function copyPath() {
    const latest = current.current;
    if (!latest.open || latest.loading || latest.target?.kind !== "file" || pending.current !== null) return;
    const path = latest.target.path, id = ++request.current;
    pending.current = id;
    const isCurrent = () => request.current === id && current.current.open && !current.current.loading &&
      current.current.target?.kind === "file" && current.current.target.path === path;
    setCopy({ state: "copying", message: "Copying file path..." });
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(path);
      if (isCurrent()) setCopy({ state: "copied", message: "Original file path copied." });
    } catch (cause) {
      if (isCurrent()) setCopy({ state: "failed", message: `Could not copy the file path. ${cause instanceof Error ? cause.message : String(cause)} Select and copy the path below.` });
    } finally {
      if (pending.current === id) pending.current = null;
    }
  }
  return <DropdownMenu modal={false} open={open && !disabled} onOpenChange={value => {
    if (value) outside.current = false;
    onOpenChange(value);
  }}>
    <DropdownMenuTrigger asChild><IconButton id="reviewOptions" ref={trigger} size="icon"
      onFocus={event => { if (restoringFocus.current) event.preventDefault(); }}
      aria-label="Review options" disabled={disabled}><Icon name="moreHorizontal" /></IconButton></DropdownMenuTrigger>
    {open && !disabled && <DropdownMenuContent ref={content} align="end" collisionPadding={12}
      className="review-options-menu" aria-labelledby="reviewOptions"
      onEscapeKeyDown={event => event.stopPropagation()}
      onInteractOutside={event => {
        if (event.target instanceof Node && trigger.current?.contains(event.target)) event.preventDefault();
        else outside.current = true;
      }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        const active = document.activeElement;
        const handedOff = active && active !== document.body && active !== trigger.current && !content.current?.contains(active);
        if (!current.current.open && !outside.current && !handedOff && trigger.current?.isConnected &&
          !trigger.current.closest("[hidden], [inert]")) {
          // Returning from a command is not a new request for its trigger hint.
          restoringFocus.current = true;
          trigger.current.focus({ preventScroll: true });
          restoringFocus.current = false;
        }
      }}>
      <DropdownMenuLabel className="review-options-document">
        <span>Document</span>
        <span className="review-options-name" aria-label={loading ? "Loading document" : location}>
          {loading ? "Loading document..." : name || "Document unavailable"}
        </span>
      </DropdownMenuLabel>
      {target?.kind === "file" && <DropdownMenuItem disabled={loading || copy.state === "copying"}
        onSelect={event => { event.preventDefault(); void copyPath(); }}>
        <Icon name="copy" />Copy full path
      </DropdownMenuItem>}
      {!loading && target?.kind === "url" && <p className="review-options-notice">This URL review has no original local file path.</p>}
      {copy.message && <div className="review-options-notice" role={copy.state === "failed" ? "alert" : "status"}>
        <p>{copy.message}</p>
        {copy.state === "failed" && <code tabIndex={0} className="review-options-path">{location}</code>}
      </div>}
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Review tools theme</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={theme} aria-label="Review tools theme" onValueChange={value => {
        if (value === "light" || value === "dark") onThemeChange(value);
      }}>
        <DropdownMenuRadioItem value="light"><Icon name="sun" />Light</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="dark"><Icon name="moon" />Dark</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>}
  </DropdownMenu>;
}
