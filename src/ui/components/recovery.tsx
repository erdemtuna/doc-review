import { useRef, useSyncExternalStore } from "react";
import type { RecoveryController } from "../../recovery-controller.js";
import { Button } from "./ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Icon } from "./icon";

export function RecoveryMenu({ runtime }: { runtime: RecoveryController }) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const trigger = useRef<HTMLButtonElement>(null);
  return <div className="shell-recovery" hidden={!state.menuVisible}>
    <DropdownMenu modal={false} open={state.menuOpen} onOpenChange={runtime.commands.setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button id="reviewDetails" ref={trigger} variant="ghost" aria-busy={state.busy}
          aria-controls={state.menuOpen ? "recoveryMenu" : undefined}>
          More <Icon name="chevronDown" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent id="recoveryMenu" aria-labelledby="reviewDetails" align="end"
        className="w-72" collisionPadding={12}
        onEscapeKeyDown={(event) => event.stopPropagation()}
        onInteractOutside={(event) => {
          if (event.target instanceof Node && trigger.current?.contains(event.target)) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          const latest = runtime.getSnapshot();
          if (latest.menuOpen || !latest.restoreMenuFocus) event.preventDefault();
        }}>
        <DropdownMenuLabel>Page recovery</DropdownMenuLabel>
        {state.eligible && <DropdownMenuItem
          id={state.preference === "static" ? "executionAuto" : "executionStatic"}
          disabled={!state.canRecover}
          className="min-h-8 whitespace-normal px-2 py-2"
          onSelect={() => { void runtime.commands.recover(state.preference === "static" ? "auto" : "static"); }}>
          {state.preference === "static" ? "Use page interactions" : "Reload without scripts"}
        </DropdownMenuItem>}
        {state.detail && <><DropdownMenuSeparator />
          <p id="executionDetails" className="m-0 px-2 py-2 text-xs text-muted-foreground wrap-anywhere">{state.detail}</p>
        </>}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

export function RecoveryNotices({ runtime }: { runtime: RecoveryController }) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  if (!state.reloadVisible && !state.status) return null;
  return <div className="review-ui recovery-notices">
    {state.reloadVisible
      ? <section id="reloadNotice" className="recovery-notice" data-error={state.reloadError}
          aria-label="Source update">
          <div role={state.reloadError ? "alert" : "status"}>
            <strong className="block font-medium">{state.reloadError ? "Review needs attention" : "Source updated"}</strong>
            <p id="reloadMessage" className="mt-1">{state.reloadMessage}</p>
          </div>
          <div className="recovery-notice-actions">
            <Button id="safeReload" disabled={!state.canReload}
              className="h-auto min-h-8 max-w-full whitespace-normal py-1.5"
              onClick={() => { void runtime.commands.reload(); }}>
              {state.reloadBusy ? "Reloading…" : "Reload latest; keep comment drafts"}
            </Button>
            <Button id="keepCurrent" variant="outline" disabled={state.reloadBusy} onClick={runtime.commands.keepCurrent}>
              Keep this page
            </Button>
          </div>
        </section>
      : <p id="executionStatus" className="recovery-notice" data-error={state.statusError}
          role={state.statusError ? "alert" : "status"}>{state.status}</p>}
  </div>;
}
