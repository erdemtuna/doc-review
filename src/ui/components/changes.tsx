import { useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent } from "react";
import type { ChangesController } from "../../changes-controller.js";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import { ComparisonPortal } from "./comparison";

type Props = { runtime: ChangesController };
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
    header.hidden = !state.hasComparison;
  }, [root, header, state.hasComparison, state.mode]);
  useLayoutEffect(() => {
    const request = state.scrollRequest;
    if (!request || consumedScroll.current === request.sequence || state.disabled || !state.hasComparison ||
      request.key !== state.key || request.mode !== state.mode || request.index !== state.index) return;
    consumedScroll.current = request.sequence;
    root.querySelector(".comparison-current")?.scrollIntoView({ block: "center", behavior: "instant" });
  }, [root, state.scrollRequest, state.disabled, state.hasComparison, state.key, state.mode, state.index, state.detailVersion]);
  return <ComparisonPortal root={root} headingSlot={headingSlot}
    comparison={state.hasComparison ? { ...detail.value, changes: detail.items } : null}
    mode={state.mode} comparisonKey={state.key} selectedIndex={state.index} />;
}

export function ChangesControls({ runtime }: Props) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  return <div className="changes-controls" onKeyDown={ownEscape}>
    <div className="changes-selectors">
      <div className="changes-field">
        <Label htmlFor="roundPicker">Round</Label>
        <NativeSelect id="roundPicker" aria-label="Review round" value={state.selectedId}
          disabled={state.disabled || !state.rounds.length}
          onChange={(event) => { void runtime.commands.selectRound(event.currentTarget.value); }}>
          {!state.rounds.length && <NativeSelectOption value="">No review rounds</NativeSelectOption>}
          {state.rounds.map((round) => <NativeSelectOption key={round.value} value={round.value}>{round.label}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      <div id="historyTargetLabel" className="changes-field changes-target" hidden={state.targets.length < 2}>
        <Label htmlFor="historyTarget">Page</Label>
        <NativeSelect id="historyTarget" aria-label="Comparison page" value={state.targetKey}
          disabled={state.disabled || state.loading}
          onChange={(event) => { void runtime.commands.selectTarget(event.currentTarget.value); }}>
          {state.targets.map((target) => <NativeSelectOption key={target.value} value={target.value}>{target.label}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      <div id="comparisonModes" className="changes-formats" role="group" aria-label="Comparison format" hidden={!state.modes.length}>
        {state.modes.map((mode) => <Button key={mode} size="sm" variant={mode === state.mode ? "secondary" : "ghost"}
          data-comparison-mode={mode} aria-pressed={mode === state.mode} disabled={state.disabled || state.loading}
          onClick={() => runtime.commands.selectMode(mode)}>{mode === "content" ? "Content" : "Source"}</Button>)}
      </div>
      <Button id="captureResult" size="sm" hidden={!state.captureAllowed} disabled={state.captureDisabled}
        aria-busy={state.captureBusy} onClick={() => { void runtime.commands.capture(state.key); }}>
        {state.captureBusy ? "Capturing result…" : "Capture result"}
      </Button>
    </div>
    <div className="changes-summary" aria-busy={state.loading}>
      <p id="historyStatus" role="status" data-state={state.loading ? "loading" : state.status}>{state.message}</p>
      <div id="historyCounts" className="changes-counts" hidden={!state.counts}>
        {state.counts && <>
          <Badge variant="outline" className="changes-added">{state.counts.added} Added</Badge>{" · "}
          <Badge variant="outline" className="changes-modified">{state.counts.modified} Modified</Badge>{" · "}
          <Badge variant="outline" className="changes-removed">{state.counts.removed} Removed</Badge>
        </>}
      </div>
    </div>
    <div className="changes-error-line" hidden={!state.error}>
      <p id="historyError" className="changes-error" role="alert">{state.error}</p>
      {state.canRetry && <Button id="historyRetry" size="sm" variant="outline" disabled={state.disabled}
        onClick={() => { void runtime.commands.retry(); }}>Retry history</Button>}
    </div>
  </div>;
}

export function ChangesNavigation({ runtime }: Props) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  return <nav id="changeNavigation" className="changes-navigation" aria-label="Change navigation" hidden={state.changes.length < 2} onKeyDown={ownEscape}>
    <Button id="previousChange" size="sm" variant="outline" aria-label="Previous change" disabled={state.previousDisabled}
      onClick={() => runtime.commands.jump(state.index - 1, state.key)}>Previous</Button>
    <span id="changePosition" aria-live="polite">{state.position}</span>
    <Button id="nextChange" size="sm" variant="outline" aria-label="Next change" disabled={state.nextDisabled}
      onClick={() => runtime.commands.jump(state.index + 1, state.key)}>Next</Button>
    <div className="changes-field changes-jump">
      <Label htmlFor="changeJump">Jump to</Label>
      <NativeSelect id="changeJump" aria-label="Jump to change" value={String(state.index)}
        disabled={state.disabled || state.loading}
        onChange={(event) => runtime.commands.jump(Number(event.currentTarget.value), state.key)}>
        {state.changes.map((change) => <NativeSelectOption key={change.value} value={change.value}>{change.label}</NativeSelectOption>)}
      </NativeSelect>
    </div>
  </nav>;
}

export function ChangesDiagnostics({ runtime }: Props) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  return <details id="historyDiagnostics" className="changes-diagnostics" open={state.diagnosticsOpen} onKeyDown={ownEscape}
    onToggle={(event) => runtime.commands.disclose("diagnostics", event.currentTarget.open)}>
    <summary>Comparison details</summary>
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
