import { createControllerStore } from "./controller-store.js";
import { historyPresentation } from "./history-coordinator.js";
import { changeKind, comparisonFreshness, excerpt } from "./history-client.js";
import { tidyMiddle } from "./anchor-text.js";
import type { ComparisonMode, RevisionComparison, ComparisonInput, SavedChange } from "./contracts/history.js";

export interface ChangeItem extends SavedChange {
  type?: string;
  label?: string;
}
export interface ChangesComparison extends ComparisonInput {
  reason?: string;
  changes?: readonly ChangeItem[];
  items?: readonly ChangeItem[];
  counts?: { added: number; modified: number; removed: number; total?: number } | null;
  limitations?: readonly string[];
  beforeCapturedAt?: number | string;
  afterCapturedAt?: number | string;
  sourceHash?: string | null;
  capturedSessionId?: string | null;
  capturedGeneration?: number | null;
  viewComparison?: { status: string; message: string };
}
export interface ChangesTarget {
  key: string;
  filename?: string;
  label?: string;
  resultRevisionId?: string | null;
  baselineUnavailable?: string;
  resultUnavailable?: string;
  capture?: { status?: string; error?: string | null } | null;
  captureStatus?: string;
  comparison?: {
    content?: ChangesComparison | RevisionComparison;
    source?: ChangesComparison | RevisionComparison;
    changes?: readonly ChangeItem[];
    items?: readonly ChangeItem[];
  };
}
export interface ChangesRound {
  id?: string;
  roundId?: string;
  ordinal?: number;
  number?: number;
  captureStatus?: string;
  status?: string;
  feedbackStatus?: string;
  acknowledgedAt?: number | string;
  targets?: readonly ChangesTarget[];
}
export interface ChangesHistory {
  rounds: readonly ChangesRound[];
  selectedId: string | null;
  round: ChangesRound | null;
  targetKey: string | null;
  preferredMode: string | null;
  index: number;
  loading: boolean;
  error: { message: string } | null;
  captureBusy: boolean;
  finalizing: boolean;
  failures: ReadonlyMap<string, string>;
}
export interface ChangesContext {
  history: ChangesHistory;
  ended: boolean;
  comparing: boolean;
  sending: boolean;
  current: {
    key: string | null;
    kind: string | undefined;
    ready: boolean;
    pendingReload: boolean;
    dirty: boolean;
    sourceHash: string | null;
    sessionId: string;
    generation: number;
  };
}
interface Options {
  read(): ChangesContext;
  selectRound(id: string): Promise<unknown>;
  selectTarget(key: string): Promise<unknown>;
  selectMode(mode: ComparisonMode): void;
  selectIndex(index: number): void;
  capture(): Promise<unknown>;
  finish(): Promise<unknown>;
  refresh(): Promise<unknown>;
  failed(message: string): void;
}
const roundId = (round: ChangesRound | null) => round?.id || round?.roundId || "";
const timestamp = (value: number | string | undefined) => value == null ? NaN : new Date(value).getTime();
const formatTime = (value: number | string | undefined) => {
  const time = timestamp(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : "Not available";
};

/** Pure normalization: reading or rendering never edits the authoritative history. */
export function changesSelection(history: ChangesHistory) {
  const round = history.round && roundId(history.round) === history.selectedId ? history.round : null;
  const targets = round?.targets || [];
  const target = targets.find((item) => item.key === history.targetKey) || targets[0] || null;
  const comparison = target?.comparison || {};
  const modes = (["content", "source"] as const).filter((mode) => comparison[mode]?.available === true);
  const mode: ComparisonMode = modes.find((item) => item === history.preferredMode) || modes[0] || "content";
  const value: ChangesComparison = comparison[mode] || {};
  const items = value.changes || value.items || (mode === "content" ? comparison.changes || comparison.items : null) || [];
  const index = Number.isSafeInteger(history.index) ? Math.max(0, Math.min(history.index, items.length - 1)) : 0;
  return { round, target, targets, comparison, modes, mode, value, items, index, key: `${roundId(round)}:${target?.key || ""}` };
}

export function createChangesController(options: Options) {
  let disposed = false;
  let diagnosticsOpen = false;
  let limitationsOpen = false;
  let pending: "capture" | "finish" | null = null;
  let actionError: { key: string; message: string } | null = null;
  let scrollSequence = 0;
  let scrollRequest: { sequence: number; key: string; mode: ComparisonMode; index: number } | null = null;
  const getDetail = () => changesSelection(options.read().history);
  let detailValue = getDetail().comparison[getDetail().mode] || null;
  let detailVersion = 0;
  function read() {
    const context = options.read();
    const history = context.history;
    const selection = changesSelection(history);
    const { round, target, comparison, modes, mode, value, items, index, key } = selection;
    const failure = history.failures.get(key);
    const presentation = historyPresentation({ ...history, round, target, comparison, failure });
    const captureBusy = history.captureBusy || pending === "capture";
    const finalizing = history.finalizing || pending === "finish";
    const disabled = context.ended || !context.comparing;
    const captureAllowed = !!target && !target.resultRevisionId && target.capture?.status !== "unavailable" &&
      round?.feedbackStatus === "acknowledged";
    const finishAllowed = !!target && !target.resultRevisionId && round?.feedbackStatus === "acknowledged" &&
      ["pending", "failed"].includes(target.capture?.status || target.captureStatus || "pending");
    const delay = timestamp(value.afterCapturedAt) - timestamp(round?.acknowledgedAt);
    const view = mode === "content" ? value.viewComparison : null;
    return {
      disabled, loading: history.loading, key, mode, index, modes, detailVersion, scrollRequest, hasComparison: modes.length > 0,
      rounds: history.rounds.map((item, position) => ({
        value: roundId(item),
        shortLabel: `Round ${item.ordinal || item.number || history.rounds.length - position}`,
        label: `Round ${item.ordinal || item.number || history.rounds.length - position} · ${item.captureStatus === "ready" ? "completed" : item.captureStatus || item.status || item.feedbackStatus || "pending"}`,
      })),
      selectedId: history.selectedId || "",
      targets: selection.targets.map((item) => ({ value: item.key, label: item.filename || item.label || item.key })),
      targetKey: target?.key || "",
      status: presentation.state,
      message: history.loading ? round ? "Refreshing comparison…" : "Loading comparison…" : presentation.message,
      error: actionError?.key === key ? actionError.message : history.error?.message || failure || target?.capture?.error || "",
      canRetry: !!history.error && !history.loading,
      counts: modes.length ? value.counts || null : null,
      changes: items.map((item, position) => ({
        value: String(position),
        label: `${position + 1}. ${changeKind(item)} · ${tidyMiddle(item.label || excerpt(item.after) || excerpt(item.before) || "Structure", 65)}`,
      })),
      position: `${items.length ? index + 1 : 0} of ${items.length}`,
      previousDisabled: disabled || history.loading || index === 0,
      nextDisabled: disabled || history.loading || index >= items.length - 1,
      captureAllowed, captureBusy,
      captureDisabled: disabled || history.loading || context.sending || captureBusy || finalizing ||
        target?.key !== context.current.key || !context.current.ready || context.current.pendingReload,
      finishAllowed, finalizing,
      finishDisabled: disabled || history.loading || context.sending || finalizing || captureBusy,
      diagnosticsOpen, limitationsOpen,
      unavailable: (["content", "source"] as const).flatMap((item) => comparison[item]?.available === false
        ? [`${item === "content" ? "Content" : "Source"} comparison unavailable: ${comparison[item]?.reason || "This representation could not be compared."}`] : []),
      timing: round ? [
        { label: "Before captured", value: formatTime(value.beforeCapturedAt) },
        { label: "Agent acknowledged", value: formatTime(round.acknowledgedAt) },
        { label: "After captured", value: formatTime(value.afterCapturedAt) },
      ] : [],
      delay: !Number.isFinite(delay) ? "" : delay >= 0
        ? `Result captured ${Math.round(delay / 1000)} seconds after acknowledgment—not at the acknowledgment instant. A delayed capture can include later changes.`
        : "This result snapshot predates acknowledgment. It is not proof of the page state at acknowledgment.",
      freshness: target?.resultRevisionId || value.afterCapturedAt
        ? comparisonFreshness(value, target?.key, context.current) : "",
      view: view?.message ? view : null,
      limitations: [...new Set([...(comparison.content?.limitations || []), ...(comparison.source?.limitations || [])])]
        .map((item) => String(item).replaceAll("-", " ").replaceAll("_", " ")),
    };
  }
  const store = createControllerStore(read);
  const publish = () => {
    if (disposed) return;
    const selection = getDetail();
    const next = selection.comparison[selection.mode] || null;
    if (detailValue !== next) { detailValue = next; detailVersion++; }
    store.publish();
  };
  const available = () => !disposed && !options.read().ended && options.read().comparing;
  async function run(action: "capture" | "finish", key: string) {
    const current = read();
    if (!available() || key !== current.key || pending ||
      (action === "capture" ? !current.captureAllowed || current.captureDisabled : !current.finishAllowed || current.finishDisabled)) return;
    pending = action;
    actionError = null;
    publish();
    try {
      await (action === "capture" ? options.capture() : options.finish());
    } catch (error) {
      if (!disposed) {
        const message = error instanceof Error ? error.message : String(error);
        actionError = { key, message };
        options.failed(message);
      }
    } finally {
      pending = null;
      publish();
    }
  }
  return {
    getSnapshot: store.getSnapshot, subscribe: store.subscribe, publish, getDetail,
    commands: {
      selectRound(id: string) {
        const history = options.read().history;
        if (available() && history.selectedId !== id && history.rounds.some((round) => roundId(round) === id)) {
          actionError = null;
          scrollRequest = null;
          return options.selectRound(id);
        }
      },
      selectTarget(key: string) {
        const selection = getDetail();
        if (available() && !options.read().history.loading && key !== selection.target?.key && selection.targets.some((target) => target.key === key)) {
          actionError = null;
          scrollRequest = null;
          return options.selectTarget(key);
        }
      },
      selectMode(mode: string) {
        const selection = getDetail();
        if (available() && !options.read().history.loading && (mode === "content" || mode === "source") &&
          mode !== selection.mode && selection.modes.includes(mode)) {
          scrollRequest = null;
          options.selectMode(mode);
        }
      },
      jump(index: number, key: string) {
        const selection = getDetail();
        if (!available() || options.read().history.loading || key !== selection.key ||
          !Number.isSafeInteger(index) || index < 0 || index >= selection.items.length) return;
        scrollRequest = { sequence: ++scrollSequence, key, mode: selection.mode, index };
        options.selectIndex(index);
        publish();
      },
      capture: (key: string) => run("capture", key),
      finish: (key: string) => run("finish", key),
      retry() { if (available() && !options.read().history.loading) return options.refresh(); },
      disclose(name: "diagnostics" | "limitations", open: boolean) {
        if (!available()) return;
        if (name === "diagnostics") diagnosticsOpen = open;
        else limitationsOpen = open;
        publish();
      },
    },
    dispose() { disposed = true; store.dispose(); },
  };
}
export type ChangesController = ReturnType<typeof createChangesController>;
