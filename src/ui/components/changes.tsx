import { useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { ChangesController } from "../../changes-controller.js";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ChoiceMenu } from "./ui/choice-menu";
import { SegmentedControl, SegmentedControlItem } from "./ui/segmented-control";
import { ComparisonPortal } from "./comparison";
import { Icon } from "./icon";

type Props = { runtime: ChangesController };
type Snapshot = ReturnType<ChangesController["getSnapshot"]>;
type Menu = "round" | "page" | "jump";
function inlineStatus(state: Snapshot) {
  return state.status === "available" && !state.loading && !state.error;
}
function HistoryStatus({ state, quiet = false }: { state: Snapshot; quiet?: boolean }) {
  return <p id="historyStatus" role="status" aria-busy={state.loading} className={quiet ? "sr-only" : undefined}
    data-state={state.loading ? "loading" : state.status}>{state.message}</p>;
}
function ownEscape(event: KeyboardEvent<HTMLElement>) {
  if (event.key === "Escape") event.stopPropagation();
}
export function ChangesDetail({ runtime, root, headingSlot, header }: Props & {
  root: HTMLElement; headingSlot: HTMLElement; header: HTMLElement;
}) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const detail = runtime.getDetail();
  const consumedScroll = useRef(0);
  useLayoutEffect(() => {
    root.classList.add("comparison-surface");
    root.classList.toggle("comparison-content", state.mode === "content");
    root.classList.toggle("comparison-source", state.mode === "source");
    root.hidden = !state.hasComparison;
    headingSlot.hidden = !state.hasComparison;
  }, [root, headingSlot, state.hasComparison, state.mode]);
  useLayoutEffect(() => {
    const request = state.scrollRequest;
    if (!request || consumedScroll.current === request.sequence || state.disabled || !state.hasComparison ||
      request.key !== state.key || request.mode !== state.mode || request.index !== state.index) return;
    consumedScroll.current = request.sequence;
    root.style.setProperty("--comparison-header-height", `${header.getBoundingClientRect().height}px`);
    root.querySelector(".comparison-current")?.scrollIntoView({ block: "center", behavior: "instant" });
  }, [root, header, state.scrollRequest, state.disabled, state.hasComparison, state.key, state.mode, state.index, state.detailVersion]);
  return <ComparisonPortal root={root} headingSlot={headingSlot}
    comparison={state.hasComparison ? { ...detail.value, changes: detail.items } : null}
    mode={state.mode} comparisonKey={state.key} selectedIndex={state.index} />;
}

export function ChangesControls({ runtime }: Props) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  return <div className="changes-controls" hidden={inlineStatus(state) && !state.captureAllowed} onKeyDown={ownEscape}>
    <div className="changes-support">
      {!inlineStatus(state) && <HistoryStatus state={state} />}
      <Button id="captureResult" size="sm" hidden={!state.captureAllowed} disabled={state.captureDisabled}
        aria-busy={state.captureBusy} onClick={() => { void runtime.commands.capture(state.key); }}>
        {state.captureBusy ? "Capturing result…" : "Capture result"}
      </Button>
    </div>
    <div className="changes-error-line" hidden={!state.error}>
      <p id="historyError" className="changes-error" role="alert">{state.error}</p>
      {state.canRetry && <Button id="historyRetry" size="sm" variant="outline" disabled={state.disabled}
        onClick={() => { void runtime.commands.retry(); }}>Retry history</Button>}
    </div>
  </div>;
}

export function ChangesToolbar({ runtime }: Props) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const counts = state.counts;
  const [menu, setMenu] = useState<{ name: Menu; context: string } | null>(null);
  const context = JSON.stringify([state.selectedId, state.targetKey, state.mode]);
  const eligible = (name: Menu) => !state.disabled && (name === "round"
    ? state.rounds.length > 0 : !state.loading && (name === "page" ? state.targets.length > 1 : state.changes.length > 1));
  const active = menu?.context === context && eligible(menu.name) ? menu.name : null;
  useLayoutEffect(() => {
    if (menu && !active) setMenu(null);
  }, [menu, active]);
  const disclosure = (name: Menu) => ({
    open: active === name,
    restoreFocus: active === null,
    onOpenChange: (open: boolean) => setMenu((current) =>
      open ? { name, context } : current?.name === name ? null : current),
  });
  const round = state.rounds.find((option) => option.value === state.selectedId);
  const target = state.targets.find((option) => option.value === state.targetKey);
  return <div className="changes-toolbar" role="group" aria-label="Comparison tools" onKeyDown={ownEscape}>
    <div className="changes-context">
      <ChoiceMenu id="roundPicker" label="Review round" value={state.selectedId} options={state.rounds}
        triggerLabel={round?.shortLabel || (state.rounds.length ? "Choose round" : "No review rounds")}
        disabled={!eligible("round")} {...disclosure("round")}
        onValueChange={(value) => { void runtime.commands.selectRound(value); }} />
      <div id="historyTargetLabel" hidden={state.targets.length < 2}>
        <ChoiceMenu id="historyTarget" label="Comparison page" value={state.targetKey} options={state.targets}
          triggerLabel={target?.label || "Choose page"} disabled={!eligible("page")} {...disclosure("page")}
          onValueChange={(value) => { void runtime.commands.selectTarget(value); }} />
      </div>
    </div>
    <nav id="changeNavigation" className="changes-navigation" aria-label="Change navigation" hidden={state.changes.length < 2}>
      <Button id="previousChange" variant="outline" aria-label="Previous change" disabled={state.previousDisabled}
        onClick={() => runtime.commands.jump(state.index - 1, state.key)}>Previous</Button>
      <ChoiceMenu id="changeJump" textId="changePosition" label="Jump to change"
        value={String(state.index)} options={state.changes} triggerLabel={state.position} valueLabel={state.position}
        disabled={!eligible("jump")} {...disclosure("jump")}
        onValueChange={(value) => runtime.commands.jump(Number(value), state.key)} />
      <Button id="nextChange" variant="outline" aria-label="Next change" disabled={state.nextDisabled}
        onClick={() => runtime.commands.jump(state.index + 1, state.key)}>Next</Button>
    </nav>
    <div className="changes-view-tools" hidden={!state.hasComparison}>
      <SegmentedControl id="comparisonModes" className="changes-formats" aria-label="Comparison format">
        {state.modes.map((mode) => <SegmentedControlItem key={mode} selected={mode === state.mode}
          data-comparison-mode={mode} disabled={state.disabled || state.loading}
          onClick={() => runtime.commands.selectMode(mode)}>{mode === "content" ? "Content" : "Source"}</SegmentedControlItem>)}
      </SegmentedControl>
      <div id="historyCounts" className="changes-counts" hidden={!counts}>
        {counts && (["added", "modified", "removed"] as const).map((kind) =>
          <Badge key={kind} variant="outline" className={`changes-${kind}`} role="img"
            aria-label={`${counts[kind]} ${kind} changes`} title={`${kind[0].toUpperCase()}${kind.slice(1)} changes`}>
            <Icon name={kind === "added" ? "plus" : kind === "modified" ? "pencil" : "minus"} size={14} />
            {counts[kind]}
          </Badge>)}
      </div>
    </div>
    {inlineStatus(state) && <HistoryStatus state={state} quiet />}
  </div>;
}

export function ChangesDiagnostics({ runtime }: Props) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  return <details id="historyDiagnostics" className="changes-diagnostics" open={state.diagnosticsOpen} onKeyDown={ownEscape}
    onToggle={(event) => runtime.commands.disclose("diagnostics", event.currentTarget.open)}>
    <summary>Comparison details</summary>
    <p className="changes-legend">
      <span className="changes-added"><Icon name="plus" size={14} /> Added</span>
      <span className="changes-modified"><Icon name="pencil" size={14} /> Modified</span>
      <span className="changes-removed"><Icon name="minus" size={14} /> Removed</span>
    </p>
    <p id="historyCurrentStatus" hidden={!state.freshness}>{state.freshness}</p>
    <p id="historyViewCoverage" hidden={!state.view} data-status={state.view?.status || ""}>{state.view?.message}</p>
    <div id="historyUnavailable" hidden={!state.unavailable.length}>
      {state.unavailable.map((reason) => <p key={reason}>{reason}</p>)}
    </div>
    <p>Content is a readable reconstruction of saved blocks, not the original page layout. Historical scripts, authored styles and image URLs are never replayed. Table rows use saved cell selectors; complex spanning structure is shown in row order. Source shows saved file text.</p>
    <dl id="historyTiming" className="changes-timing" hidden={!state.timing.length}>
      {state.timing.map((time) => <div key={time.label}><dt>{time.label}</dt><dd>{time.value}</dd></div>)}
    </dl>
    <p id="historyCaptureDelay" hidden={!state.delay}>{state.delay}</p>
    <details id="historyLimitations" hidden={!state.limitations.length} open={state.limitationsOpen}
      onToggle={(event) => runtime.commands.disclose("limitations", event.currentTarget.open)}>
      <summary>Comparison coverage and limits</summary>
      <ul id="historyLimitationsList">{state.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
    </details>
    <Button id="finishCapture" size="sm" variant="outline" hidden={!state.finishAllowed}
      disabled={state.finishDisabled} aria-busy={state.finalizing} aria-describedby="finishCaptureHelp"
      onClick={() => { void runtime.commands.finish(state.key); }}>
      {state.finalizing ? "Finishing…" : "Finish with available snapshots"}
    </Button>
    <p id="finishCaptureHelp" hidden={!state.finishAllowed}>Finishing marks missing Content as unavailable; it does not invent a result. Existing Source comparisons remain available, and this target will no longer retry capture.</p>
  </details>;
}
