import type { ChangeKind, ComparisonMode, DiffSegment, SavedBlock, SavedChange, SavedRow } from "../../contracts/history.js";
export type { ComparisonInput, SavedBlock, SavedChange, SavedRow } from "../../contracts/history.js";
export type Side = "before" | "after";
export interface ComparisonUnit { key: string; rows: SavedRow[]; tableKey: string | null }
export interface ContextGroup { key: string; start: number; end: number; hidden: boolean }
export const containers = new Set(["table", "thead", "tbody", "tfoot", "tr", "ul", "ol", "dl"]);
export const blockFor = (row: SavedRow, side: Side) => side === "before" ? row.beforeBlock : row.afterBlock;
export const sourceLine = (block: SavedBlock | null | undefined) => block?.startLine ?? "";

export function rowParent(block: SavedBlock | null | undefined): string | null {
  if (!block || !["td", "th"].includes(block.tag || "")) return null;
  // A non-positional path cannot distinguish repeated saved table rows.
  return block.selector?.match(/^(.* > tr(?::nth-of-type\(\d+\))?(?:\[id=".*"\])?) > (?:td|th):nth-of-type\(\d+\)/)?.[1] || null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const string = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const kind = (value: unknown): ChangeKind => value === "added" || value === "removed" ? value : "modified";

function savedBlock(value: unknown): SavedBlock | null {
  const input = record(value);
  if (!input) return null;
  const attributes = Object.fromEntries(Object.entries(record(input.attributes) || {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const runs = Array.isArray(input.runs) ? input.runs.flatMap((value: unknown) => {
    const run = record(value);
    if (!run || typeof run.text !== "string") return [];
    return [{
      text: run.text,
      marks: Array.isArray(run.marks) ? run.marks.filter((mark: unknown): mark is string => typeof mark === "string") : [],
      ...(typeof run.href === "string" ? { href: run.href } : {}),
    }];
  }) : undefined;
  return {
    text: string(input.text), tag: string(input.tag, "p"), selector: string(input.selector),
    path: Array.isArray(input.path) ? input.path.filter((part: unknown): part is string => typeof part === "string") : [],
    attributes, runs,
    ...(typeof input.startLine === "number" && Number.isFinite(input.startLine) ? { startLine: input.startLine } : {}),
  };
}

function segments(value: unknown): DiffSegment[] {
  return Array.isArray(value) ? value.flatMap((value: unknown) => {
    const part = record(value);
    return part && typeof part.value === "string" ? [{
      value: part.value, ...(part.added ? { added: true as const } : {}), ...(part.removed ? { removed: true as const } : {}),
    }] : [];
  }) : [];
}

export function listPositions(rows: SavedRow[], side: Side): Map<SavedBlock, number> {
  const positions = new Map<SavedBlock, number>();
  const lists = new Map<string, { next: number; step: number }>();
  for (const row of rows) {
    const block = blockFor(row, side);
    if (!block) continue;
    if (block.tag === "ol") {
      const key = (block.selector || "").replace(/\[id=".*"\]$/, "");
      const reversed = Object.hasOwn(block.attributes || {}, "reversed");
      const children = reversed ? rows.filter((candidate) => {
        const child = blockFor(candidate, side);
        return child?.tag === "li" && child.selector?.replace(/ > li:nth-of-type\(\d+\).*$/, "") === key;
      }).length : 1;
      const start = block.attributes?.start;
      lists.set(key, { next: start !== undefined && Number.isSafeInteger(Number(start)) ? Number(start) : children, step: reversed ? -1 : 1 });
    }
    if (block.tag !== "li") continue;
    const key = block.selector?.replace(/ > li:nth-of-type\(\d+\).*$/, "") || (block.path || []).join("/");
    const list = lists.get(key) || { next: 1, step: 1 };
    lists.set(key, list);
    const explicit = block.attributes?.value;
    if (explicit !== undefined && Number.isFinite(Number(explicit))) list.next = Number(explicit);
    positions.set(block, list.next);
    list.next += list.step;
  }
  return positions;
}

export function metadata(block: SavedBlock, change: SavedChange | undefined, side: Side): string[] {
  const other = change?.[side === "before" ? "afterBlock" : "beforeBlock"];
  if (!change || !other) return [];
  const labels: string[] = [];
  if (block.tag !== other.tag) labels.push(`Element: ${block.tag}`);
  const names = new Map([["href", "Link destination"], ["src", "Image reference"], ["alt", "Alternative text"], ["id", "Element ID"]]);
  for (const key of new Set([...Object.keys(block.attributes || {}), ...Object.keys(other.attributes || {})])) {
    if (block.attributes?.[key] !== other.attributes?.[key]) labels.push(`${names.get(key) || key}: ${block.attributes?.[key] ?? "(not set)"}`);
  }
  const links = [...new Set((block.runs || []).map((run) => run.href).filter(Boolean))];
  const otherLinks = [...new Set((other.runs || []).map((run) => run.href).filter(Boolean))];
  if (JSON.stringify(links) !== JSON.stringify(otherLinks)) labels.push(`Link destination: ${links.join(", ") || "(none)"}`);
  if (change.fields?.includes("runs") && block.text === other.text && !labels.length) labels.push("Inline formatting changed");
  if (change.fields?.includes("structure") && block.tag === other.tag) labels.push(`Structure: ${(block.path || []).join(" › ") || "document root"}`);
  return labels;
}

/** Presentation projection only: the saved rows and segments remain the diff authority. */
export function projectComparison(value: unknown, mode: ComparisonMode = "content") {
  const input = record(value) || {};
  const changes: SavedChange[] = (Array.isArray(input.changes) ? input.changes : []).flatMap((value: unknown, index: number) => {
    const change = record(value);
    return change ? [{
      id: string(change.id, `legacy-change-${index}`) || `legacy-change-${index}`, kind: kind(change.kind),
      before: string(change.before), after: string(change.after),
      beforeBlock: savedBlock(change.beforeBlock), afterBlock: savedBlock(change.afterBlock),
      fields: Array.isArray(change.fields) ? change.fields.filter((field: unknown): field is string => typeof field === "string") : [],
      segments: segments(change.segments),
    }] : [];
  });
  const legacy = !Array.isArray(input.rows);
  const rows: SavedRow[] = legacy ? changes.map((change, index) => ({
    id: `legacy-row-${index}`, kind: change.kind || "modified", changeId: change.id,
    beforeBlock: change.beforeBlock || (change.kind === "added" ? null : { text: change.before || "", tag: "p" }),
    afterBlock: change.afterBlock || (change.kind === "removed" ? null : { text: change.after || "", tag: "p" }),
    segments: change.segments,
  })) : (Array.isArray(input.rows) ? input.rows : []).flatMap((value: unknown, index: number) => {
    const row = record(value);
    return row ? [{
      id: string(row.id, `row-${index}`), kind: row.kind === "unchanged" ? "unchanged" as const : kind(row.kind),
      changeId: typeof row.changeId === "string" ? row.changeId : null,
      ...(typeof row.moveId === "string" ? { moveId: row.moveId } : {}),
      beforeBlock: savedBlock(row.beforeBlock), afterBlock: savedBlock(row.afterBlock), segments: segments(row.segments),
    }] : [];
  });
  const nodes = rows.reduce((sum, row) => sum + (["before", "after"] as const).reduce((n, side) => {
    const runs = blockFor(row, side)?.runs || [];
    const depth = runs.reduce((maximum, run) => Math.max(maximum, run.marks.length), 0);
    return n + 12 + (runs.length + (row.segments?.length || 1)) * (depth + 4);
  }, 0), 0);
  const budgetExceeded = nodes > 120000;
  const units: ComparisonUnit[] = [];
  if (!budgetExceeded) for (const [index, row] of rows.entries()) {
    if (row.kind === "unchanged" && (["before", "after"] as const).every((side) => {
      const block = blockFor(row, side);
      return !block || (containers.has(block.tag || "") && !block.text);
    })) continue;
    const tableKey = mode === "content" && (rowParent(row.beforeBlock) || rowParent(row.afterBlock))
      ? `${rowParent(row.beforeBlock) || ""}|${rowParent(row.afterBlock) || ""}` : null;
    const previous = units.at(-1);
    if (tableKey && previous?.tableKey === tableKey) previous.rows.push(row);
    else units.push({ key: `${index}:${row.id}`, rows: [row], tableKey });
  }
  const visible = new Set<number>();
  for (const [index, unit] of units.entries()) if (unit.rows.some((row) => row.kind !== "unchanged")) {
    for (let nearby = Math.max(0, index - 2); nearby <= Math.min(units.length - 1, index + 2); nearby++) visible.add(nearby);
  }
  if (!changes.length) for (let index = 0; index < Math.min(3, units.length); index++) visible.add(index);
  const groups: ContextGroup[] = [];
  for (let index = 0; index < units.length;) {
    const start = index;
    const hidden = !visible.has(index++);
    if (hidden) while (index < units.length && !visible.has(index)) index++;
    groups.push({ key: `${start}:${index}`, start, end: index, hidden });
  }
  const targets = new Map<string, string>();
  for (const unit of units) for (const row of unit.rows) {
    if (row.changeId && !targets.has(row.changeId)) targets.set(row.changeId, unit.key);
  }
  return {
    rows, changes, units, groups, targets, legacy, budgetExceeded, available: input.available !== false,
    signature: JSON.stringify([input.version, input.status, input.available, input.rows, input.changes]),
    changeMap: new Map(changes.map((change, index) => [change.id || `legacy-change-${index}`, change])),
    numbers: { before: budgetExceeded ? new Map<SavedBlock, number>() : listPositions(rows, "before"), after: budgetExceeded ? new Map<SavedBlock, number>() : listPositions(rows, "after") },
  };
}
export type ComparisonProjection = ReturnType<typeof projectComparison>;
