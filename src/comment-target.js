const finite = (value) => typeof value === "number" && Number.isFinite(value);

export function groupCommentTargets(targets) {
  const groups = new Map();
  for (const [id, element] of targets) {
    if (!element?.isConnected) continue;
    if (!groups.has(element)) groups.set(element, []);
    groups.get(element).push(id);
  }
  return groups;
}

export function nextCommentId(ids, activeId) {
  return ids.length ? ids[(ids.indexOf(activeId) + 1) % ids.length] : null;
}

/** Retarget dwell is independent of initial intent; revisiting a candidate
 * does not restart its clock. The caller owns corridor and selection policy. */
export function createHoverIntent(commit, {
  initial = 150, retarget = 100, exit = 120,
  schedule = setTimeout, unschedule = clearTimeout,
} = {}) {
  let current = null;
  let candidate = null;
  let timer = null;
  const cancel = () => {
    unschedule(timer);
    timer = null;
    candidate = null;
  };
  return {
    cancel,
    reset() { cancel(); current = null; },
    request(key, payload, immediate = false) {
      if (key === current && !immediate) { cancel(); return; }
      if (timer !== null && candidate === key && !immediate) return;
      cancel();
      candidate = key;
      const apply = () => {
        timer = null;
        current = key;
        candidate = null;
        commit(payload);
      };
      if (immediate) apply();
      else timer = schedule(apply, key === null ? exit : current === null ? initial : retarget);
    },
  };
}

export function normalizeSelectionRange(map, range) {
  let first = null;
  let last = null;
  // Element offsets index children, not characters. Intersect the filtered text
  // nodes so an exclusive endpoint before the next block never includes it.
  for (const entry of map) {
    const length = entry.node.nodeValue.length;
    if (range.comparePoint(entry.node, length) < 0 || range.comparePoint(entry.node, 0) > 0) continue;
    const from = entry.node === range.startContainer ? range.startOffset : 0;
    const to = entry.node === range.endContainer ? range.endOffset : length;
    if (to <= from) continue;
    first ||= { entry, offset: from };
    last = { entry, offset: to };
  }
  if (!first || !last) return null;
  const normalized = range.cloneRange();
  normalized.setStart(first.entry.node, first.offset);
  normalized.setEnd(last.entry.node, last.offset);
  return {
    start: first.entry.start + first.offset,
    end: last.entry.start + last.offset,
    range: normalized,
  };
}

export function sameRange(one, two) {
  return !!one && !!two &&
    one.startContainer === two.startContainer && one.startOffset === two.startOffset &&
    one.endContainer === two.endContainer && one.endOffset === two.endOffset;
}

export function pointInCommentApproach(point, target, action) {
  if (!target || !action || action.width <= 0 || action.height <= 0) return false;
  return point.x >= Math.min(target.left, action.left) &&
    point.x <= Math.max(target.right, action.right) &&
    point.y >= Math.min(target.top, action.top) &&
    point.y <= Math.max(target.bottom, action.bottom);
}

export function sanitizeRect(rect) {
  if (!rect) return null;
  const values = ["left", "top", "right", "bottom", "width", "height"];
  if (!values.every((key) => finite(rect[key]))) return null;
  if (rect.width < 0 || rect.height < 0 || rect.right < rect.left || rect.bottom < rect.top) return null;
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

export function sanitizeClientRect(rect, viewport) {
  const safe = sanitizeRect(rect);
  if (!safe || !viewport || !finite(viewport.width) || !finite(viewport.height)) return null;
  const { left: rawLeft, top: rawTop, right: rawRight, bottom: rawBottom } = safe;
  if (rawRight <= 0 || rawBottom <= 0 || rawLeft >= viewport.width || rawTop >= viewport.height) return null;
  const left = Math.max(0, Math.min(viewport.width, rawLeft));
  const top = Math.max(0, Math.min(viewport.height, rawTop));
  const right = Math.max(left, Math.min(viewport.width, rawRight));
  const bottom = Math.max(top, Math.min(viewport.height, rawBottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export function sanitizeClientRects(rects, viewport, limit = 64) {
  if (!Array.isArray(rects)) return [];
  return rects.slice(0, limit).map((rect) => sanitizeClientRect(rect, viewport)).filter(Boolean);
}

export function sanitizeClipRect(rect, viewport) {
  const safe = sanitizeClientRect(rect, viewport);
  return safe && safe.width > 0 && safe.height > 0 ? safe : null;
}

export function sanitizeRelation(value) {
  return ["visible", "above", "below", "unavailable"].includes(value) ? value : "unavailable";
}

export function targetMessage(
  { kind, quote, anchor, rects, generation, relation, clip, horizontal },
  viewport
) {
  const safeRects = sanitizeClientRects(rects, viewport);
  const safeClip = sanitizeClipRect(clip, viewport);
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  const safeRelation = sanitizeRelation(relation);
  if (!safeClip || (safeRelation === "visible" && !safeRects.length)) return null;
  return {
    kind: kind === "element" ? "element" : "selection",
    quote: String(quote || ""),
    anchor: anchor || null,
    rects: safeRects,
    generation,
    relation: safeRelation,
    clip: safeClip,
    horizontal: finite(horizontal) ? Math.max(safeClip.left, Math.min(safeClip.right, horizontal)) : null,
  };
}

export function acceptsTargetGeometry(currentGeneration, incoming) {
  return !!incoming && Number.isSafeInteger(incoming.generation) && incoming.generation === currentGeneration;
}

export function acceptedOpenGeneration(
  { pendingGeneration = null, retargetGeneration = null },
  { accepted, requestedGeneration }
) {
  if (!accepted) return pendingGeneration;
  if (requestedGeneration === retargetGeneration) return retargetGeneration;
  if (requestedGeneration === pendingGeneration) return pendingGeneration;
  return null;
}
