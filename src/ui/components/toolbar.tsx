import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { ToolbarController, ToolbarState } from "../../toolbar-controller.js";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { SegmentedControl, SegmentedControlItem } from "./ui/segmented-control";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Icon } from "./icon";
import { Brand } from "./brand";

export function Toolbar({ runtime }: { runtime: ToolbarController }) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  return <ToolbarControls state={state} commands={runtime.commands} />;
}

export function ToolbarControls({ state, commands, readOnlyNavigation = false, editDisabled = false, pagePicker, status, changesId = "historyPanel", feedbackCount = state.feedbackCount, feedbackCountLabel = "feedback items" }: {
  state: ToolbarState;
  commands: ToolbarController["commands"];
  readOnlyNavigation?: boolean;
  editDisabled?: boolean;
  pagePicker?: ReactNode;
  status?: ReactNode;
  changesId?: string;
  feedbackCountLabel?: string;
  feedbackCount?: number | null;
}) {
  const current = useRef(state);
  current.current = state;
  const modeTrigger = useRef<HTMLButtonElement>(null);
  const modeContent = useRef<HTMLDivElement>(null);
  const interactedOutside = useRef(false);
  useLayoutEffect(() => {
    // Reopening during exit reuses the content, so Radix does not run mount autofocus again.
    if (state.modeMenuOpen) modeContent.current?.focus({ preventScroll: true });
  }, [state.modeMenuOpen]);
  const destinations = <div className="shell-destinations">
      <Brand />
      <SegmentedControl aria-label="Review destination">
        <SegmentedControlItem id="latestVersion" selected={!state.comparing}
          aria-controls="frame" disabled={state.ended && !readOnlyNavigation}
          onClick={() => commands.setComparing(false)}>Review</SegmentedControlItem>
        <SegmentedControlItem id="seeChanges" selected={state.comparing}
          aria-controls={changesId} disabled={state.ended && !readOnlyNavigation}
          onClick={() => commands.setComparing(true)}>Changes</SegmentedControlItem>
      </SegmentedControl>
      {pagePicker}
    </div>;
  const modeControls = <div className="shell-mode" role="group" aria-label="Page controls" hidden={state.comparing}>
      <DropdownMenu modal={false} open={state.modeMenuOpen} onOpenChange={(open) => {
        if (open) interactedOutside.current = false;
        commands.setModeMenu(open);
      }}>
        <DropdownMenuTrigger asChild>
          <Button id="modeButton" ref={modeTrigger} variant="outline"
            hidden={state.comparing}
            aria-controls={state.modeMenuOpen ? "modeMenu" : undefined}
            disabled={state.modeDisabled || state.ended}>
            <Icon name={state.mode === "edit" ? "pencil" : "eye"} />
            <span id="modeLabel">{state.mode === "edit" ? "Edit" : "View"}</span>
            <Icon name="chevronDown" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent ref={modeContent} id="modeMenu" aria-labelledby="modeButton" className="w-64" collisionPadding={12}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onInteractOutside={(event) => {
            // The trigger owns toggling, including while the old menu is animating out.
            if (event.target instanceof Node && modeTrigger.current?.contains(event.target)) event.preventDefault();
            else interactedOutside.current = true;
          }}
          onCloseAutoFocus={(event) => {
            const latest = current.current;
            const active = document.activeElement;
            // Focus may have moved after closing, while the exit animation was still running.
            const handedOff = active && active !== document.body && active !== modeTrigger.current &&
              !modeContent.current?.contains(active);
            event.preventDefault();
            if (!latest.modeMenuOpen && latest.restoreModeFocus && !handedOff && !interactedOutside.current) {
              modeTrigger.current?.focus({ preventScroll: true });
            }
          }}>
          <DropdownMenuRadioGroup value={state.mode} onValueChange={(mode) => {
            if (mode === "view" || mode === "edit") commands.setMode(mode);
          }}>
            <DropdownMenuRadioItem value="view" data-mode="view" textValue="View" className="gap-2 p-2 pr-8">
              <Icon name="eye" /><span><strong className="block font-medium">View</strong>
                <small className="block text-xs text-muted-foreground">Editing off, comments enabled</small></span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="edit" data-mode="edit" textValue="Edit" disabled={editDisabled} className="gap-2 p-2 pr-8">
              <Icon name="pencil" /><span><strong className="block font-medium">Edit</strong>
                <small className="block text-xs text-muted-foreground">{state.editDescription}</small></span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>;
  const actions = <div className="shell-actions">
      <Button id="commentsButton" variant={state.drawerOpen ? "secondary" : "ghost"}
        aria-controls="drawer" aria-label="Feedback" aria-describedby="feedbackCountDescription" aria-expanded={state.drawerOpen}
        hidden={state.comparing} disabled={state.ended && !readOnlyNavigation} onMouseDown={(event) => event.preventDefault()} onClick={commands.openComments}>
        <Icon name="messages" /><span className="shell-comments-label">Feedback</span>
        <Badge id="toolbarCount" variant="secondary" title={feedbackCount === null ? `Count unavailable: ${feedbackCountLabel}` : `${feedbackCount} ${feedbackCountLabel}`}
          aria-label={feedbackCount === null ? `Count unavailable: ${feedbackCountLabel}` : `${feedbackCount} ${feedbackCountLabel}`}>
          {feedbackCount === null ? "…" : feedbackCount > 99 ? "99+" : feedbackCount}
        </Badge>
        <span id="feedbackCountDescription" className="sr-only">{feedbackCount === null ? "Count unavailable:" : feedbackCount} {feedbackCountLabel}</span>
      </Button>
      <Button id="theme" variant="ghost" size="icon" disabled={state.ended && !readOnlyNavigation}
        title={`Switch review tools to ${state.theme === "dark" ? "light" : "dark"}`}
        aria-label={`Switch review tools to ${state.theme === "dark" ? "light" : "dark"}`}
        onClick={commands.toggleTheme}>
        <Icon name={state.theme === "dark" ? "sun" : "moon"} />
      </Button>
    </div>;
  return <>
    {destinations}
    {status ? <>
      <div className="shell-status">{status}</div>
      <div className="shell-tools">{actions}{modeControls}</div>
    </> : <>{modeControls}{actions}</>}
  </>;
}
