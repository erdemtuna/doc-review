import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ToolbarController, ToolbarState } from "../../toolbar-controller.js";
import type { CanonicalPage } from "../../contracts/page-boundary";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { SegmentedControl, SegmentedControlItem } from "./ui/segmented-control";
import { ChoiceMenu } from "./ui/choice-menu";
import { ReviewOptions } from "./review-options";
import { Icon } from "./icon";
import { Brand } from "./brand";

export function Toolbar({ runtime }: { runtime: ToolbarController }) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  return <ToolbarControls state={state} commands={runtime.commands} />;
}

export function ToolbarControls({ state, commands, readOnlyNavigation = false, editDisabled = false, pagePicker, status, changesId = "conversationChanges", feedbackCount = state.feedbackCount, feedbackCountLabel = "feedback items", documentTarget, documentLoading = false, pageMenuOpen = false, onOptionsOpen }: {
  state: ToolbarState;
  commands: ToolbarController["commands"];
  readOnlyNavigation?: boolean;
  editDisabled?: boolean;
  pagePicker?: ReactNode;
  status?: ReactNode;
  changesId?: string;
  feedbackCountLabel?: string;
  feedbackCount?: number | null;
  documentTarget?: CanonicalPage["target"] | null;
  documentLoading?: boolean;
  pageMenuOpen?: boolean;
  onOptionsOpen?(): void;
}) {
  const [optionsOpen, setOptionsOpen] = useState(false);
  useEffect(() => {
    if (state.modeMenuOpen || pageMenuOpen) setOptionsOpen(false);
  }, [state.modeMenuOpen, pageMenuOpen]);
  const setOptions = (open: boolean) => {
    if (open) { commands.setModeMenu(false); onOptionsOpen?.(); }
    setOptionsOpen(open);
  };
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
      <ChoiceMenu id="modeButton" menuId="modeMenu" textId="modeLabel" label="Page mode"
        value={state.mode} triggerLabel={state.mode === "edit" ? "Edit" : "View"}
        icon={state.mode === "edit" ? "pencil" : "eye"} disabled={state.modeDisabled || state.ended}
        open={state.modeMenuOpen && !state.comparing} restoreFocus={state.restoreModeFocus && !state.comparing}
        options={[
          { value: "view", label: "View", icon: "eye", description: "Editing off, comments enabled" },
          { value: "edit", label: "Edit", icon: "pencil", description: state.editDescription, disabled: editDisabled },
        ]}
        onOpenChange={commands.setModeMenu}
        onValueChange={mode => { if (mode === "view" || mode === "edit") commands.setMode(mode); }} />
    </div>;
  const feedback = <Button id="commentsButton" variant="ghost"
        aria-controls="drawer" aria-label="Feedback" aria-describedby="feedbackCountDescription" aria-expanded={state.drawerOpen}
        hidden={state.comparing} disabled={state.ended && !readOnlyNavigation} onMouseDown={(event) => event.preventDefault()} onClick={commands.openComments}>
        <Icon name="messages" /><span className="shell-comments-label">Feedback</span>
        <Badge id="toolbarCount" variant="secondary" title={feedbackCount === null ? `Count unavailable: ${feedbackCountLabel}` : `${feedbackCount} ${feedbackCountLabel}`}
          aria-label={feedbackCount === null ? `Count unavailable: ${feedbackCountLabel}` : `${feedbackCount} ${feedbackCountLabel}`}>
          {feedbackCount === null ? "…" : feedbackCount > 99 ? "99+" : feedbackCount}
        </Badge>
        <span id="feedbackCountDescription" className="sr-only">{feedbackCount === null ? "Count unavailable:" : feedbackCount} {feedbackCountLabel}</span>
      </Button>;
  const options = <ReviewOptions open={optionsOpen} onOpenChange={setOptions} disabled={state.ended && !readOnlyNavigation}
    theme={state.theme} onThemeChange={commands.setTheme} target={documentTarget} loading={documentLoading} />;
  return <>
    {destinations}
    {status && <div className="shell-status">{status}</div>}
    <div className="shell-tools">{feedback}{modeControls}{options}</div>
  </>;
}
