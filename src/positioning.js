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
