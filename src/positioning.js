const GAP = 12;

export function visibleViewport(win = window) {
  const viewport = win.visualViewport;
  return viewport
    ? { left: viewport.offsetLeft, top: viewport.offsetTop, width: viewport.width, height: viewport.height }
    : { left: 0, top: 0, width: win.innerWidth, height: win.innerHeight };
}

export function lastVisibleRect(rects) {
  if (!Array.isArray(rects)) return null;
  for (let index = rects.length - 1; index >= 0; index -= 1) {
    const rect = rects[index];
    if (rect && rect.width >= 0 && rect.height >= 0) return rect;
  }
  return null;
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function frameRectToChrome(rect, frameRect) {
  return {
    left: frameRect.left + rect.left,
    right: frameRect.left + rect.right,
    top: frameRect.top + rect.top,
    bottom: frameRect.top + rect.bottom,
  };
}

export function placeContextualSurface(geometry, options) {
  const {
    frameRect,
    viewport,
    surfaceWidth = 340,
    surfaceHeight = 220,
    narrow = false,
    toolbarHeight = 48,
  } = options;
  const bottomSheet = () => ({
    kind: "sheet",
    left: viewport.left,
    top: viewport.top + viewport.height - Math.min(surfaceHeight, viewport.height),
    width: viewport.width,
  });
  if (!geometry || geometry.relation === "unavailable" || !geometry.clip) return { kind: "hidden" };
  if (narrow) return bottomSheet();
  const clip = frameRectToChrome(geometry.clip, frameRect);
  const minLeft = viewport.left + GAP;
  const maxLeft = viewport.left + viewport.width - surfaceWidth - GAP;
  const viewportMinTop = viewport.top + toolbarHeight + GAP;
  const minTop = Math.max(viewportMinTop, clip.top + GAP);
  const maxTop = viewport.top + viewport.height - surfaceHeight - GAP;
  const clipBottomTop = clip.bottom - surfaceHeight - GAP;
  const horizontal = Number.isFinite(geometry.horizontal)
    ? frameRect.left + geometry.horizontal
    : clip.left;
  const edgeLeft = clamp(horizontal + GAP, minLeft, maxLeft);

  if (geometry.relation === "above") {
    return { kind: "edge-top", left: edgeLeft, top: minTop, width: surfaceWidth };
  }
  if (geometry.relation === "below") {
    return {
      kind: "edge-bottom",
      left: edgeLeft,
      top: Math.max(viewportMinTop, Math.min(maxTop, clipBottomTop)),
      width: surfaceWidth,
    };
  }

  const target = lastVisibleRect(geometry.rects);
  if (!target) return { kind: "hidden" };
  const rect = frameRectToChrome(target, frameRect);
  const attachedMaxTop = Math.min(maxTop, clipBottomTop);
  const clampTop = (top) => clamp(top, minTop, Math.max(minTop, attachedMaxTop));
  const candidates = [
    { left: rect.right + GAP, top: clampTop(rect.bottom - surfaceHeight) },
    { left: rect.left - surfaceWidth - GAP, top: clampTop(rect.bottom - surfaceHeight) },
    { left: clamp(rect.left, minLeft, maxLeft), top: rect.bottom + GAP },
    { left: clamp(rect.left, minLeft, maxLeft), top: rect.top - surfaceHeight - GAP },
  ];
  const fit = candidates.find((candidate) =>
    candidate.left >= minLeft &&
    candidate.left <= maxLeft &&
    candidate.top >= minTop &&
    candidate.top <= attachedMaxTop &&
    candidate.left + surfaceWidth <= Math.min(viewport.left + viewport.width - GAP, clip.right) &&
    candidate.top + surfaceHeight <= clip.bottom
  );
  const fallback = fit || {
    left: clamp(rect.right + GAP, minLeft, maxLeft),
    top: clampTop(rect.top),
  };
  return { kind: "attached", ...fallback, width: surfaceWidth };
}

export function alignedCardPosition(rects, { frameRect, viewport, width = 300, height = 180 }) {
  const target = lastVisibleRect(rects);
  if (!target) return null;
  const top = frameRect.top + target.top;
  const right = frameRect.left + target.right;
  if (top < frameRect.top || top > frameRect.bottom || right < frameRect.left || right > frameRect.right) return null;
  return {
    left: Math.max(viewport.left + 12, Math.min(viewport.left + viewport.width - width - 12, right + 12)),
    top: Math.max(viewport.top + 12, Math.min(viewport.top + viewport.height - height - 12, top)),
  };
}

/** Extend the former placement, but never accept its clamped overlapping fallback. */
export function placeNewMessageSurface(geometry, options) {
  if (options.viewport.width < 900) return null;
  const placement = placeContextualSurface(geometry, { ...options, narrow: false });
  if (!("left" in placement) || placement.kind === "sheet") return null;
  const { viewport, frameRect, surfaceHeight, toolbarHeight } = options;
  const clip = frameRectToChrome(geometry.clip, frameRect);
  if (placement.left < viewport.left + GAP || placement.left + placement.width > viewport.left + viewport.width - GAP ||
      placement.top < viewport.top + toolbarHeight + GAP ||
      placement.top + surfaceHeight > viewport.top + viewport.height - GAP ||
      placement.top < clip.top || placement.top + surfaceHeight > clip.bottom) return null;
  if (geometry.rects.some((rect) => {
    const target = frameRectToChrome(rect, frameRect);
    return placement.left < target.right + GAP && placement.left + placement.width > target.left - GAP &&
      placement.top < target.bottom + GAP && placement.top + surfaceHeight > target.top - GAP;
  })) return null;
  return { ...placement, height: surfaceHeight };
}

/** Use document margins, not apparently empty space inside authored content. */
export function placeConversationSurface(state, { frameRect, viewport, toolbarHeight = 88, width = 360, height = 560 }) {
  if (state?.state !== "found" || state.relation !== "visible" || viewport.width < 900) return null;
  const available = viewport.height - toolbarHeight - GAP * 2;
  if (available < 340 || !state.rects.length) return null;
  const measuredHeight = Math.min(height, available);
  const rects = state.rects.map((rect) => frameRectToChrome(rect, frameRect));
  const left = Math.min(...rects.map((rect) => rect.left));
  const right = Math.max(...rects.map((rect) => rect.right));
  const top = clamp(Math.min(...rects.map((rect) => rect.top)),
    viewport.top + toolbarHeight + GAP, viewport.top + viewport.height - measuredHeight - GAP);
  const rightEdge = Number.isFinite(frameRect.right) ? Math.max(right, frameRect.right) : right;
  const leftEdge = Number.isFinite(frameRect.left) ? Math.min(left, frameRect.left) : left;
  for (const x of [rightEdge + GAP, leftEdge - width - GAP]) {
    if (x >= viewport.left + GAP && x + width <= viewport.left + viewport.width - GAP) {
      return { left: x, top, width, height: measuredHeight };
    }
  }
  return null;
}
