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

/** Popovers may cover unselected prose, never any visible part of their target. */
function placeLocalSurface(geometry, { frameRect, viewport, surfaceWidth, surfaceHeight, minHeight = surfaceHeight, toolbarHeight = 48 }) {
  if (!geometry || geometry.relation === "unavailable") return null;
  const bounds = { left: viewport.left + GAP, right: viewport.left + viewport.width - GAP,
    top: viewport.top + toolbarHeight + GAP, bottom: viewport.top + viewport.height - GAP };
  const width = Math.min(surfaceWidth, bounds.right - bounds.left);
  if (width < 240 || bounds.bottom - bounds.top < minHeight) return null;
  const height = Math.min(surfaceHeight, bounds.bottom - bounds.top);
  const clip = geometry.clip ? frameRectToChrome(geometry.clip, frameRect) : bounds;
  const rects = geometry.rects.map(rect => frameRectToChrome(rect, frameRect)).map(rect => ({
    left: Math.max(rect.left, clip.left, bounds.left - GAP), right: Math.min(rect.right, clip.right, bounds.right + GAP),
    top: Math.max(rect.top, clip.top, bounds.top - GAP), bottom: Math.min(rect.bottom, clip.bottom, bounds.bottom + GAP),
  })).filter(rect => rect.right > rect.left && rect.bottom > rect.top);
  if (!rects.length) {
    if (!["above", "below"].includes(geometry.relation)) return null;
    const horizontal = Number.isFinite(geometry.horizontal) ? frameRect.left + geometry.horizontal : clip.left;
    return { kind: geometry.relation === "above" ? "edge-top" : "edge-bottom",
      left: clamp(horizontal, bounds.left, bounds.right - width),
      top: clamp(geometry.relation === "above" ? clip.top + GAP : clip.bottom - height - GAP, bounds.top, bounds.bottom - height),
      width, height };
  }
  const target = { left: Math.min(...rects.map(rect => rect.left)), right: Math.max(...rects.map(rect => rect.right)),
    top: Math.min(...rects.map(rect => rect.top)), bottom: Math.max(...rects.map(rect => rect.bottom)) };
  const x = clamp(target.left, bounds.left, bounds.right - width);
  const y = clamp(target.top, bounds.top, bounds.bottom - height);
  const below = Math.min(height, bounds.bottom - target.bottom - GAP);
  const above = Math.min(height, target.top - GAP - bounds.top);
  const candidates = [
    { left: target.right + GAP, top: y, height },
    { left: target.left - width - GAP, top: y, height },
    { left: x, top: target.bottom + GAP, height: below },
    { left: x, top: target.top - GAP - above, height: above },
  ];
  const fit = candidates.find(candidate => candidate.height >= minHeight &&
    candidate.left >= bounds.left && candidate.left + width <= bounds.right &&
    candidate.top >= bounds.top && candidate.top + candidate.height <= bounds.bottom &&
    rects.every(rect => candidate.left >= rect.right + GAP || candidate.left + width <= rect.left - GAP ||
      candidate.top >= rect.bottom + GAP || candidate.top + candidate.height <= rect.top - GAP));
  return fit ? { kind: "attached", ...fit, width } : null;
}

export function placeNewMessageSurface(geometry, options) {
  return placeLocalSurface(geometry, options);
}

export function placeConversationSurface(state, { frameRect, viewport, toolbarHeight = 48, width = 360, height = 260, minHeight = 160 }) {
  if (state?.state !== "found") return null;
  return placeLocalSurface(state, { frameRect, viewport, toolbarHeight, surfaceWidth: width, surfaceHeight: height, minHeight });
}
