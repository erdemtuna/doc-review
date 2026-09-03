const finite = (value) => typeof value === "number" && Number.isFinite(value);

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
