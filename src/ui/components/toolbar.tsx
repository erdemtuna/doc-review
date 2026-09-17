import { useRef, useSyncExternalStore } from "react";
import type { ToolbarController } from "../../toolbar-controller.js";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Icon } from "./icon";

export function Toolbar({ runtime }: { runtime: ToolbarController }) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const commands = runtime.commands;
  const modeTrigger = useRef<HTMLButtonElement>(null);
  return <>
    <div className="shell-destinations" role="group" aria-label="Review destination">
      <Button id="latestVersion" variant={!state.comparing ? "secondary" : "ghost"}
        aria-pressed={!state.comparing} aria-controls="frame" disabled={state.ended}
        onClick={() => commands.setComparing(false)}>Review</Button>
      <Button id="seeChanges" variant={state.comparing ? "secondary" : "ghost"}
        aria-pressed={state.comparing} aria-controls="historyPanel" disabled={state.ended}
        onClick={() => commands.setComparing(true)}>Changes</Button>
    </div>
    <div className="shell-mode" role="group" aria-label="Page controls" hidden={state.comparing}>
      <DropdownMenu modal={false} open={state.modeMenuOpen} onOpenChange={commands.setModeMenu}>
        <DropdownMenuTrigger asChild>
          <Button id="modeButton" ref={modeTrigger} variant="outline"
            aria-controls={state.modeMenuOpen ? "modeMenu" : undefined}
            disabled={state.modeDisabled || state.ended}>
            <Icon name={state.mode === "edit" ? "pencil" : "eye"} />
            <span id="modeLabel">{state.mode === "edit" ? "Edit" : "View"}</span>
            <Icon name="chevronDown" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent id="modeMenu" aria-labelledby="modeButton" className="w-64" collisionPadding={12}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onInteractOutside={(event) => {
            // The trigger owns toggling, including while the old menu is animating out.
            if (event.target instanceof Node && modeTrigger.current?.contains(event.target)) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            const latest = runtime.getSnapshot();
            // A previous exit animation must not steal focus from a reopened menu.
            if (latest.modeMenuOpen || !latest.restoreModeFocus) event.preventDefault();
          }}>
          <DropdownMenuRadioGroup value={state.mode} onValueChange={(mode) => {
            if (mode === "view" || mode === "edit") commands.setMode(mode);
          }}>
            <DropdownMenuRadioItem value="view" data-mode="view" textValue="View" className="gap-2 p-2 pr-8">
              <Icon name="eye" /><span><strong className="block font-medium">View</strong>
                <small className="block text-xs text-muted-foreground">Editing off, comments enabled</small></span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="edit" data-mode="edit" textValue="Edit" className="gap-2 p-2 pr-8">
              <Icon name="pencil" /><span><strong className="block font-medium">Edit</strong>
                <small className="block text-xs text-muted-foreground">{state.editDescription}</small></span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <div className="shell-actions">
      <Button id="commentsButton" variant={state.drawerOpen ? "secondary" : "ghost"}
        aria-controls="drawer" aria-label="Comments" aria-expanded={state.drawerOpen}
        hidden={state.comparing} disabled={state.ended} onClick={commands.openComments}>
        <Icon name="messages" /><span className="shell-comments-label">Comments</span>
        <Badge id="toolbarCount" variant="secondary" title={`${state.commentCount} comments`}>
          {state.commentCount > 99 ? "99+" : state.commentCount}
        </Badge>
      </Button>
      <Button id="theme" variant="ghost" size="icon" disabled={state.ended}
        title={`Switch chrome to ${state.theme === "dark" ? "light" : "dark"}`}
        aria-label={`Switch chrome to ${state.theme === "dark" ? "light" : "dark"}`}
        onClick={commands.toggleTheme}>
        <Icon name={state.theme === "dark" ? "sun" : "moon"} />
      </Button>
    </div>
  </>;
}
