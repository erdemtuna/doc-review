import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ComparisonMode } from "../../contracts/history.js";
import { ComparisonBlock } from "../comparison/blocks";
import { blockFor, projectComparison, sourceLine, type ComparisonInput, type ComparisonProjection, type ComparisonUnit, type ContextGroup, type Side } from "../comparison/projection";

export type { ComparisonInput } from "../comparison/projection";
export interface ComparisonViewProps {
  comparison: ComparisonInput;
  mode?: ComparisonMode;
  /** Round/target identity. Changing this, mode, or saved content resets expansion. */
  comparisonKey?: string;
  /** Selection is owned by the history controller; null means no active change. */
  selectedIndex?: number | null;
  headingSlot?: Element | null;
}

function Unit({ unit, projection, mode, selectedId, register }: {
  unit: ComparisonUnit; projection: ComparisonProjection; mode: ComparisonMode; selectedId: string | null;
  register?: (element: HTMLDivElement | null) => void;
}) {
  const unchanged = unit.rows.every((row) => row.kind === "unchanged");
  const kinds = [...new Set(unit.rows.map((row) => row.kind).filter((kind) => kind !== "unchanged"))];
  const changeLabel = kinds.map((kind) => ({ added: "Added", removed: "Removed", modified: "Modified" })[kind] || "Changed").join(" · ");
  // The legacy target map selects the first unit containing a change ID.
  const current = !!selectedId && projection.targets.get(selectedId) === unit.key;
  return <div ref={register} className={`comparison-row${unchanged ? " comparison-unchanged" : ""}${current ? " comparison-current" : ""}`} data-row-id={unit.rows[0].id}>
    {(["before", "after"] as const).map((side: Side) => {
      const changed = unit.rows.some((row) => row.kind !== "unchanged" && blockFor(row, side));
      const gap = unit.rows.every((row) => !blockFor(row, side));
      const sideLabel = side === "before" ? "Before" : "After";
      const renderBlocks = unit.rows.map((row, index) => {
        const block = blockFor(row, side);
        const content = <ComparisonBlock row={row} side={side} mode={mode} change={projection.changeMap.get(row.changeId || "")}
          listNumbers={projection.numbers[side]} table={!!unit.tableKey} />;
        if (!unit.tableKey) return <Fragment key={`${index}:${row.id}`}>{content}</Fragment>;
        const colspan = Number(block?.attributes?.colspan);
        const colSpan = Number.isInteger(colspan) && colspan > 0 && colspan <= 100 ? colspan : undefined;
        return block?.tag === "th" ? <th key={`${index}:${row.id}`} colSpan={colSpan}>{content}</th>
          : <td key={`${index}:${row.id}`} colSpan={colSpan}>{content}</td>;
      });
      return <section key={side} className={`comparison-cell comparison-${side}${gap ? " comparison-gap" : ""}${changed ? side === "before" ? " comparison-removed" : " comparison-added" : ""}`}
        aria-label={`${sideLabel} · ${unchanged ? "unchanged" : changeLabel.toLowerCase()}`}>
        <span className="comparison-gutter" aria-hidden="true">{mode === "source"
          ? `${sourceLine(blockFor(unit.rows[0], side))} ${changed ? side === "before" ? "−" : "+" : ""}`
          : changed ? side === "before" ? "−" : "+" : ""}</span>
        <div className="comparison-cell-body">
          <span className="comparison-mobile-label">{unchanged
            ? mode === "source" ? `Unchanged · Before ${sourceLine(unit.rows[0].beforeBlock)} / After ${sourceLine(unit.rows[0].afterBlock)}` : "Unchanged · both versions"
            : `${sideLabel} · ${changeLabel.toLowerCase()}`}</span>
          {changed && <span className="comparison-change-label">{changeLabel}</span>}
          {unit.tableKey ? <table className="saved-table" aria-label="Saved table row"><tbody><tr>{renderBlocks}</tr></tbody></table> : renderBlocks}
        </div>
      </section>;
    })}
  </div>;
}

function Context({ group, projection, mode, selectedId }: {
  group: ContextGroup; projection: ComparisonProjection; mode: ComparisonMode; selectedId: string | null;
}) {
  const [count, setCount] = useState(group.hidden ? 0 : group.end - group.start);
  const lastRow = useRef<HTMLDivElement | null>(null);
  const focusAfterExpansion = useRef(false);
  const remaining = group.end - group.start - count;
  useLayoutEffect(() => {
    if (focusAfterExpansion.current && remaining === 0 && lastRow.current) {
      lastRow.current.tabIndex = -1;
      lastRow.current.focus({ preventScroll: true });
      focusAfterExpansion.current = false;
    }
  }, [remaining]);
  const label = `↕ Show ${Math.min(20, remaining)} of ${remaining} unchanged ${mode === "source" ? "lines" : "blocks"}`;
  return <>
    {projection.units.slice(group.start, group.start + count).map((unit) =>
      <Unit key={unit.key} unit={unit} projection={projection} mode={mode} selectedId={selectedId}
        register={(element) => { if (element) lastRow.current = element; }} />)}
    {remaining > 0 && <button type="button" className="comparison-expand" aria-label={label} onClick={() => {
      focusAfterExpansion.current = true;
      setCount((count) => Math.min(group.end - group.start, count + 20));
    }}>{label}</button>}
  </>;
}

/** Owns children only: portal this into #changeDetail; the caller owns host classes. */
export function ComparisonView({ comparison, mode = "content", comparisonKey = "", selectedIndex = null, headingSlot }: ComparisonViewProps) {
  const projection = useMemo(() => projectComparison(comparison, mode),
    [mode, comparison.version, comparison.status, comparison.available, comparison.rows, comparison.changes]);
  const selectedId = selectedIndex === null ? null : projection.changes[selectedIndex]?.id || `legacy-change-${selectedIndex}`;
  if (!projection.rows.length) return projection.available ? <>No changes detected in this comparison format.</> : null;
  if (projection.budgetExceeded) return <p className="comparison-budget">Comparison rendering limit exceeded. The saved comparison is intact; use Source or a smaller review round.</p>;
  const headings = <div className="comparison-headings"><div>Before · feedback sent</div><div>After · captured result</div></div>;
  return <>
    {projection.legacy && <p className="comparison-notice">Saved excerpts only · unchanged context was not recorded in this comparison.</p>}
    {headingSlot ? createPortal(headings, headingSlot) : headings}
    {!projection.changes.length && <p className="comparison-notice">No changes detected in this comparison format.</p>}
    <Fragment key={JSON.stringify([comparisonKey, mode, projection.signature])}>
      {projection.groups.map((group) => <Context key={group.key} group={group} projection={projection} mode={mode} selectedId={selectedId} />)}
    </Fragment>
  </>;
}

/** Optional stable two-slot portal, with empty/pending content supplied by the caller. */
export function ComparisonPortal({ root, fallback = null, comparison, ...props }: Omit<ComparisonViewProps, "comparison"> & {
  root: Element; comparison: ComparisonInput | null; fallback?: ReactNode;
}) {
  return createPortal(comparison ? <ComparisonView comparison={comparison} {...props} /> : fallback, root);
}
