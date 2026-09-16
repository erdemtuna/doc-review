import { diffArrays, diffLines, diffWordsWithSpace } from "diff";

export const DIFF_VERSION = 2;
export const DIFF_LIMITS = Object.freeze({
  maxBlocks: 2000,
  maxCharacters: 1000000,
  maxBlockCharacters: 100000,
  maxRuns: 1000,
  maxTokens: 50000,
  maxChanges: 4000,
  maxEditLength: 2000,
  maxRows: 50000,
  maxResponseCharacters: 16000000,
  timeoutMs: 250,
});

class ComparisonLimit extends Error {}
const emptyCounts = () => ({ added: 0, modified: 0, removed: 0, total: 0 });
const attributes = new Set([
  "id", "href", "src", "alt", "title", "start", "reversed", "value",
  "rowspan", "colspan", "scope", "headers", "type",
]);
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const content = (block) => stable({
  tag: block.tag, text: block.text, attributes: block.attributes,
  runs: block.runs, path: block.path,
});
const hash = (value) => {
  let n = 2166136261;
  for (let i = 0; i < value.length; i++) n = Math.imul(n ^ value.charCodeAt(i), 16777619);
  return (n >>> 0).toString(36);
};

function context(options) {
  const limits = { ...DIFF_LIMITS };
  for (const key of Object.keys(limits)) {
    if (options?.[key] !== undefined) {
      if (!Number.isSafeInteger(options[key]) || options[key] < 1) throw new TypeError(`Invalid ${key}`);
      limits[key] = Math.min(limits[key], options[key]);
    }
  }
  const deadline = Date.now() + limits.timeoutMs;
  return {
    limits,
    check() {
      if (Date.now() > deadline) throw new ComparisonLimit("time");
    },
    primitives() {
      this.check();
      return { timeout: Math.max(1, deadline - Date.now()), maxEditLength: limits.maxEditLength };
    },
    words(before, after) {
      if ((before.match(/\s+|[^\s]+/g)?.length || 0) +
          (after.match(/\s+|[^\s]+/g)?.length || 0) > limits.maxTokens) {
        throw new ComparisonLimit("tokens");
      }
      const parts = diffWordsWithSpace(before, after, this.primitives());
      if (!parts) throw new ComparisonLimit("word-diff");
      this.check();
      return parts.map(({ value, added, removed }) => ({
        value, ...(added ? { added: true } : {}), ...(removed ? { removed: true } : {}),
      }));
    },
  };
}

function validateSnapshot(snapshot, ctx) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.blocks) ||
      !Array.isArray(snapshot.limitations) || snapshot.limitations.length > 64 ||
      snapshot.limitations.some((item) => typeof item !== "string" || item.length > 256)) {
    throw new TypeError("Invalid semantic snapshot");
  }
  if (snapshot.blocks.length > ctx.limits.maxBlocks) throw new ComparisonLimit("blocks");
  let characters = 0;
  const ids = new Set();
  for (const block of snapshot.blocks) {
    ctx.check();
    if (!block || typeof block.id !== "string" || !block.id || block.id.length > 4096 ||
        ids.has(block.id) || typeof block.tag !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(block.tag) ||
        typeof block.selector !== "string" || block.selector.length > 4096 ||
        typeof block.text !== "string" || !Array.isArray(block.runs) ||
        !Array.isArray(block.path) || block.path.length > 64 ||
        block.path.some((item) => typeof item !== "string" || item.length > 4096) ||
        !block.attributes || typeof block.attributes !== "object" || Array.isArray(block.attributes)) {
      throw new TypeError("Invalid semantic block");
    }
    ids.add(block.id);
    if (block.text.length > ctx.limits.maxBlockCharacters) throw new ComparisonLimit("block-text");
    if (block.runs.length > ctx.limits.maxRuns) throw new ComparisonLimit("runs");
    characters += block.text.length + block.id.length + block.selector.length +
      block.path.reduce((sum, item) => sum + item.length, 0);
    for (const [key, value] of Object.entries(block.attributes)) {
      if (!attributes.has(key) || typeof value !== "string" || value.length > 4096 ||
          (key === "value" && block.tag !== "li") ||
          (key === "type" && block.tag !== "button")) throw new TypeError("Invalid semantic attributes");
      characters += value.length;
    }
    for (const run of block.runs) {
      if (!run || typeof run.text !== "string" || !Array.isArray(run.marks) ||
          run.marks.length > 16 || run.marks.some((mark) => typeof mark !== "string" || mark.length > 64) ||
          (run.href !== undefined && (typeof run.href !== "string" || run.href.length > 4096))) {
        throw new TypeError("Invalid semantic run");
      }
      characters += run.text.length + (run.href?.length || 0) +
        run.marks.reduce((sum, mark) => sum + mark.length, 0);
    }
    if (characters > ctx.limits.maxCharacters * 2) throw new ComparisonLimit("characters");
    if (block.runs.map((run) => run.text).join("") !== block.text) {
      throw new TypeError("Semantic text does not match runs");
    }
  }
}

function result(mode, ctx, limitations) {
  return {
    version: DIFF_VERSION, mode, status: "complete", changes: [], rows: [], hunks: [],
    counts: emptyCounts(), limits: { ...ctx.limits }, limitations: [...new Set(limitations)].sort(),
  };
}

function failed(mode, ctx, error) {
  if (!(error instanceof ComparisonLimit) && !(error instanceof TypeError)) throw error;
  return {
    version: DIFF_VERSION, mode,
    status: error instanceof ComparisonLimit ? "limited" : "unavailable",
    changes: [], rows: [], hunks: [], counts: null, limits: { ...(ctx?.limits || DIFF_LIMITS) },
    limitations: [error instanceof ComparisonLimit ? `comparison-limit:${error.message}` : "invalid-input"],
  };
}

function append(output, ctx, change, beforeIndex, afterIndex) {
  ctx.check();
  if (output.changes.length >= ctx.limits.maxChanges) throw new ComparisonLimit("changes");
  change.id = `change-${beforeIndex ?? "none"}-${afterIndex ?? "none"}-${hash(stable(change))}`;
  output.changes.push(change);
  output.counts[change.kind]++;
  output.counts.total++;
  return change;
}

function appendRow(output, ctx, row) {
  ctx.check();
  if (output.rows.length >= ctx.limits.maxRows) throw new ComparisonLimit("rows");
  output.rows.push({
    id: `row-${row.beforeIndex ?? "none"}-${row.afterIndex ?? "none"}`,
    ...row,
  });
}

function finish(output, ctx) {
  const order = new Map();
  for (const [index, row] of output.rows.entries()) {
    if (row.changeId && !order.has(row.changeId)) order.set(row.changeId, index);
    const kind = row.kind === "unchanged" ? "context" : "changes";
    const previous = output.hunks.at(-1);
    if (previous?.kind === kind) previous.count++;
    else output.hunks.push({ id: `hunk-${row.id}`, kind, start: index, count: 1 });
  }
  output.changes.sort((a, b) => order.get(a.id) - order.get(b.id));
  if (JSON.stringify(output).length > ctx.limits.maxResponseCharacters) {
    throw new ComparisonLimit("response");
  }
  ctx.check();
  return output;
}

function groups(blocks, key) {
  const map = new Map();
  blocks.forEach((block, index) => {
    const value = key(block);
    if (!value) return;
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(index);
  });
  return map;
}

/**
 * Compare equivalent semantic representations. Local block IDs are never
 * matching evidence. Repeated, moved and contextual matches cannot navigate.
 * Optional third-argument budgets can only lower the documented hard ceilings.
 *
 * Version 2 adds monotonic rows covering each endpoint exactly once. Row
 * indices are zero-based; null denotes a gap. changeId refers to changes,
 * while moveId links two positional rows to a single counted relocation.
 * Context/changes hunks partition all rows with zero-based start and count.
 * Neither context collapsing nor row grouping can change the actual counts.
 */
export function compareSemanticSnapshots(before, after, options = {}) {
  let ctx;
  try {
    ctx = context(options);
    validateSnapshot(before, ctx);
    validateSnapshot(after, ctx);
    const output = result("semantic", ctx, [...before.limitations, ...after.limitations]);
    const oldBlocks = before.blocks;
    const newBlocks = after.blocks;
    const oldKeys = oldBlocks.map(content);
    const newKeys = newBlocks.map(content);
    const oldContent = groups(oldBlocks, (block) => block.text);
    const newContent = groups(newBlocks, (block) => block.text);
    const oldIds = groups(oldBlocks, (block) => block.attributes.id);
    const newIds = groups(newBlocks, (block) => block.attributes.id);
    const oldSignatures = groups(oldBlocks, content);
    const newSignatures = groups(newBlocks, content);
    const pairs = new Map();
    const used = new Set();
    const pair = (i, j, confidence, evidence) => {
      if (pairs.has(i) || used.has(j)) return;
      pairs.set(i, {
        i, j, confidence, evidence,
        moved: stable(oldBlocks[i].path) !== stable(newBlocks[j].path),
      });
      used.add(j);
    };
    for (const [id, indices] of oldIds) {
      const candidates = newIds.get(id);
      if (indices.length === 1 && candidates?.length === 1) {
        pair(indices[0], candidates[0], "exact", "authored-id");
      }
    }
    for (const [text, indices] of oldContent) {
      const candidates = newContent.get(text);
      if (indices.length === 1 && candidates?.length === 1) {
        const oldId = oldBlocks[indices[0]].attributes.id;
        const newId = newBlocks[candidates[0]].attributes.id;
        if (!oldId || !newId || oldId === newId) pair(indices[0], candidates[0], "exact", "unique-text");
      }
    }
    const oldRest = oldKeys.flatMap((key, i) => pairs.has(i) ? [] : [{ key, i }]);
    const newRest = newKeys.flatMap((key, j) => used.has(j) ? [] : [{ key, j }]);
    const sequence = diffArrays(oldRest, newRest, {
      ...ctx.primitives(), comparator: (a, b) => a.key === b.key,
    });
    if (!sequence) throw new ComparisonLimit("sequence-diff");
    let oldAt = 0;
    let newAt = 0;
    for (const part of sequence) {
      if (!part.added && !part.removed) {
        for (let k = 0; k < part.count; k++) {
          const { i, key } = oldRest[oldAt + k];
          const { j } = newRest[newAt + k];
          const repeated = oldSignatures.get(key)?.length > 1 || newSignatures.get(key)?.length > 1;
          pair(i, j, repeated ? "ambiguous" : "context", repeated ? "repeated-content" : "sequence");
        }
      }
      if (!part.added) oldAt += part.count;
      if (!part.removed) newAt += part.count;
    }
    // Crossing matches identify relocation without treating inserted siblings as moves.
    const ordered = [...pairs.values()].sort((a, b) => a.i - b.i);
    let maximum = -1;
    for (const item of ordered) {
      if (item.j < maximum) item.moved = true;
      maximum = Math.max(maximum, item.j);
    }
    let minimum = Infinity;
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (ordered[i].j > minimum) ordered[i].moved = true;
      minimum = Math.min(minimum, ordered[i].j);
    }
    const anchors = [
      { i: -1, j: -1 },
      ...ordered.filter((item) => !item.moved),
      { i: oldBlocks.length, j: newBlocks.length },
    ];
    for (let a = 1; a < anchors.length; a++) {
      ctx.check();
      const left = anchors[a - 1];
      const right = anchors[a];
      const oldGap = [];
      const newGap = [];
      for (let i = left.i + 1; i < right.i; i++) if (!pairs.has(i)) oldGap.push(i);
      for (let j = left.j + 1; j < right.j; j++) if (!used.has(j)) newGap.push(j);
      if (oldGap.length !== newGap.length) continue;
      for (let k = 0; k < oldGap.length; k++) {
        const i = oldGap[k];
        const j = newGap[k];
        const oldBlock = oldBlocks[i];
        const newBlock = newBlocks[j];
        const oldId = oldBlock.attributes.id;
        const newId = newBlock.attributes.id;
        if (oldBlock.tag !== newBlock.tag || (oldId && newId && oldId !== newId) ||
            oldContent.get(oldBlock.text)?.length > 1 ||
            newContent.get(newBlock.text)?.length > 1) continue;
        pair(i, j, "context", "neighbor-context");
      }
    }
    const makeChange = (i, j, matched) => {
      const oldBlock = i === null ? null : oldBlocks[i];
      const newBlock = j === null ? null : newBlocks[j];
      const kind = !oldBlock ? "added" : !newBlock ? "removed" : "modified";
      const fields = [];
      if (!oldBlock || !newBlock) fields.push("block");
      else {
        if (oldBlock.text !== newBlock.text) fields.push("text");
        if (oldBlock.tag !== newBlock.tag || stable(oldBlock.path) !== stable(newBlock.path)) fields.push("structure");
        if (stable(oldBlock.attributes) !== stable(newBlock.attributes)) fields.push("attributes");
        if (stable(oldBlock.runs) !== stable(newBlock.runs)) fields.push("runs");
        if (matched.moved) fields.push("order");
      }
      const confidence = matched?.moved ? "ambiguous" : (matched?.confidence || "context");
      return append(output, ctx, {
        kind, before: oldBlock?.text || "", after: newBlock?.text || "",
        beforeBlock: oldBlock, afterBlock: newBlock, confidence,
        evidence: matched?.evidence || "unmatched",
        navigation: confidence === "exact" && newBlock?.selector
          ? { selector: newBlock.selector, blockId: newBlock.id } : null,
        fields, segments: ctx.words(oldBlock?.text || "", newBlock?.text || ""),
      }, i, j);
    };
    const oldChanges = new Map();
    const newChanges = new Map();
    for (let i = 0; i < oldBlocks.length; i++) {
      const matched = pairs.get(i);
      let change;
      if (!matched) change = makeChange(i, null, null);
      else if (oldKeys[i] !== newKeys[matched.j] || matched.moved) change = makeChange(i, matched.j, matched);
      if (change) {
        oldChanges.set(i, change);
        if (matched) newChanges.set(matched.j, change);
      }
    }
    for (let j = 0; j < newBlocks.length; j++) {
      if (!used.has(j)) newChanges.set(j, makeChange(null, j, null));
    }
    const add = (i, j) => {
      const match = i === null ? null : pairs.get(i);
      const change = oldChanges.get(i) || newChanges.get(j);
      appendRow(output, ctx, {
        kind: i === null ? "added" : j === null ? "removed" : change ? "modified" : "unchanged",
        beforeIndex: i, afterIndex: j,
        beforeBlock: i === null ? null : oldBlocks[i],
        afterBlock: j === null ? null : newBlocks[j],
        changeId: change?.id || null,
        confidence: change?.confidence || match?.confidence || "context",
        evidence: change?.evidence || match?.evidence || "unmatched",
        segments: change?.segments || [],
        ...(change?.fields.includes("order") ? { moveId: change.id } : {}),
      });
    };
    // Only monotonic matches share a row. Relocations occupy both original
    // positions, linked to the same counted change, never crossing columns.
    let i = 0;
    let j = 0;
    for (const match of [...pairs.values()].filter((item) => !item.moved).sort((a, b) => a.i - b.i)) {
      while (i < match.i) add(i++, null);
      while (j < match.j) add(null, j++);
      add(i++, j++);
    }
    while (i < oldBlocks.length) add(i++, null);
    while (j < newBlocks.length) add(null, j++);
    return finish(output, ctx);
  } catch (error) {
    return failed("semantic", ctx, error);
  }
}

/** Raw-source hunks are inert text. They are not DOM navigation targets. */
export function compareSources(before, after, options = {}) {
  let ctx;
  try {
    ctx = context(options);
    if (typeof before !== "string" || typeof after !== "string") throw new TypeError("Sources must be strings");
    if (before.length > ctx.limits.maxCharacters || after.length > ctx.limits.maxCharacters) {
      throw new ComparisonLimit("characters");
    }
    if ((before.match(/\n/g)?.length || 0) + (after.match(/\n/g)?.length || 0) > ctx.limits.maxTokens) {
      throw new ComparisonLimit("lines");
    }
    const output = result("source", ctx, ["source-is-not-rendered-dom"]);
    output.endOfFile = {
      before: { empty: !before.length, newline: before.endsWith("\n") },
      after: { empty: !after.length, newline: after.endsWith("\n") },
    };
    const lines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) || [];
    const addLine = (oldText, newText, i, j, change = null) => {
      appendRow(output, ctx, {
        kind: oldText === null ? "added" : newText === null ? "removed" : change ? "modified" : "unchanged",
        beforeIndex: i === null ? null : i - 1, afterIndex: j === null ? null : j - 1,
        beforeBlock: oldText === null ? null : { text: oldText, startLine: i, endLine: i },
        afterBlock: newText === null ? null : { text: newText, startLine: j, endLine: j },
        changeId: change?.id || null, confidence: "exact", evidence: "source-lines",
        segments: change ? ctx.words(oldText || "", newText || "") : [],
      });
    };
    const parts = diffLines(before, after, ctx.primitives());
    if (!parts) throw new ComparisonLimit("line-diff");
    let oldLine = 1;
    let newLine = 1;
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      if (!part.added && !part.removed) {
        for (const [offset, text] of lines(part.value).entries()) {
          addLine(text, text, oldLine + offset, newLine + offset);
        }
        oldLine += part.count;
        newLine += part.count;
        continue;
      }
      let oldValue = "";
      let newValue = "";
      let oldCount = 0;
      let newCount = 0;
      do {
        const current = parts[p];
        if (current.removed) { oldValue += current.value; oldCount += current.count; }
        if (current.added) { newValue += current.value; newCount += current.count; }
        p++;
      } while (p < parts.length && (parts[p].added || parts[p].removed));
      p--;
      const kind = oldCount && newCount ? "modified" : oldCount ? "removed" : "added";
      const change = append(output, ctx, {
        kind, before: oldValue, after: newValue,
        beforeBlock: oldCount ? { startLine: oldLine, endLine: oldLine + oldCount - 1, text: oldValue } : null,
        afterBlock: newCount ? { startLine: newLine, endLine: newLine + newCount - 1, text: newValue } : null,
        confidence: "exact", evidence: "source-lines", navigation: null,
        fields: ["source"], segments: ctx.words(oldValue, newValue),
      }, oldLine, newLine);
      const oldLines = lines(oldValue);
      const newLines = lines(newValue);
      for (let offset = 0; offset < Math.max(oldLines.length, newLines.length); offset++) {
        addLine(oldLines[offset] ?? null, newLines[offset] ?? null,
          offset < oldLines.length ? oldLine + offset : null,
          offset < newLines.length ? newLine + offset : null, change);
      }
      oldLine += oldCount;
      newLine += newCount;
    }
    return finish(output, ctx);
  } catch (error) {
    return failed("source", ctx, error);
  }
}
