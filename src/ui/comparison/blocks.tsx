import { createElement, Fragment, type ReactNode } from "react";
import type { ComparisonMode, DiffSegment } from "../../contracts/history.js";
import { blockFor, containers, metadata, rowParent, type SavedBlock, type SavedChange, type SavedRow, type Side } from "./projection";

const marks = new Map([
  ["strong", "strong"], ["em", "em"], ["underline", "u"], ["strike", "s"], ["delete", "s"],
  ["insert", "u"], ["code", "code"], ["kbd", "kbd"], ["samp", "samp"], ["sub", "sub"], ["sup", "sup"], ["mark", "mark"],
]);
const readable = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "pre", "blockquote", "address"]);

/** Never spread saved properties or replay authored tags, attributes, HTML, or URLs. */
export function SavedRuns({ block, segments, side }: { block: SavedBlock; segments?: DiffSegment[]; side: Side }) {
  const parts = segments?.length ? segments.filter((part) => side === "before" ? !part.added : !part.removed) : [{ value: block.text }];
  const runs = block.runs || [{ text: block.text, marks: [] }];
  const leaves: ReactNode[] = [];
  let runIndex = 0;
  let runOffset = 0;
  for (const [partIndex, part] of parts.entries()) {
    let offset = 0;
    while (offset < part.value.length) {
      while (runIndex < runs.length && runOffset >= runs[runIndex].text.length) {
        runIndex++;
        runOffset = 0;
      }
      const run = runs[runIndex];
      const length = Math.min(part.value.length - offset, run ? run.text.length - runOffset : Infinity);
      let leaf: ReactNode = part.value.slice(offset, offset + length);
      for (const mark of run?.marks || []) {
        const tag = marks.get(mark);
        if (tag) leaf = createElement(tag, null, leaf);
      }
      if (run?.href) leaf = <span className="saved-link" title={`Saved link: ${run.href} (not opened from history)`}>{leaf}</span>;
      if (side === "before" ? part.removed : part.added) leaf = side === "before" ? <del>{leaf}</del> : <ins>{leaf}</ins>;
      leaves.push(<Fragment key={`${partIndex}:${offset}`}>{leaf}</Fragment>);
      offset += length;
      runOffset += length;
    }
  }
  return <>{leaves}</>;
}

function BlockContent({ row, side, mode, change, listNumbers }: {
  row: SavedRow; side: Side; mode: ComparisonMode; change?: SavedChange; listNumbers: Map<SavedBlock, number>;
}) {
  const block = blockFor(row, side);
  if (!block) return null;
  const runs = <SavedRuns block={block} segments={row.segments} side={side} />;
  if (mode === "source") {
    const other = blockFor(row, side === "before" ? "after" : "before");
    const ending = (text: string) => text.endsWith("\r\n") ? "CRLF" : text.endsWith("\n") ? "LF" : "none";
    return <>
      <pre>{runs}</pre>
      {!block.text.endsWith("\n") && <small className="newline-note">↵ No newline at end of file</small>}
      {other && ending(block.text) !== ending(other.text) && <small className="newline-note">Line ending: {ending(block.text)}</small>}
    </>;
  }
  const tag = block.tag || "p";
  let content: ReactNode;
  if (tag === "img") content = <figure className="saved-image">
    <figcaption>Image: {block.attributes?.alt || "No saved alternative text"}</figcaption>
    <small>Saved reference: {block.attributes?.src || "unavailable"} · Image not loaded</small>
  </figure>;
  else if (tag === "hr") content = <hr />;
  else if (containers.has(tag) && !block.text) content = change ? <small className="structure-note">{tag} structure {row.kind}</small> : null;
  else if (tag === "li") {
    const listTag = [...(block.path || [])].reverse().find((item) => /^(ul|ol)(#|$)/.test(item))?.split("#")[0];
    const depth = (block.path || []).filter((item) => /^(ul|ol)(#|$)/.test(item)).length;
    const style = { marginInlineStart: `${Math.min(6, Math.max(0, depth - 1)) * 14}px` };
    content = <>
      {listTag === "ol" ? <ol className="saved-list" start={listNumbers.get(block) ?? 1} style={style}><li>{runs}</li></ol>
        : <ul className="saved-list" style={style}><li>{runs}</li></ul>}
      {!listTag && <small className="structure-note">List item · parent structure unavailable</small>}
    </>;
  } else content = <>
    {createElement(readable.has(tag) ? tag : "p", null, runs)}
    {["td", "th"].includes(tag) && !rowParent(block)
      ? <small className="structure-note">Table cell · row structure unavailable</small>
      : ["button", "summary", "dt", "dd", "caption", "figcaption"].includes(tag)
        ? <small className="structure-note">{tag === "button" ? "Saved button · inactive" : tag}</small> : null}
  </>;
  return <>{content}{metadata(block, change, side).map((label, index) => <small key={index} className="metadata-note">{label}</small>)}</>;
}

export function ComparisonBlock(props: Parameters<typeof BlockContent>[0] & { table: boolean }) {
  const { row, side, table } = props;
  const block = blockFor(row, side);
  return <div className="comparison-block" data-change-id={row.changeId || undefined}
    title={row.kind === "removed" && side === "before" && !row.moveId ? "Removed content has no target on the latest page." : undefined}>
    <BlockContent {...props} />
    {row.moveId && block && <small className="metadata-note">↔ Relocated content · {side === "before" ? "original" : "result"} position (identity not certain)</small>}
    {table && block?.attributes?.rowspan && block.attributes.rowspan !== "1" &&
      <small className="structure-note">Saved row span: {block.attributes.rowspan} · shown in row order</small>}
  </div>;
}
