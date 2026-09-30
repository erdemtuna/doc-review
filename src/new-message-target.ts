import { conversationTargetSchema } from "./contracts/feedback.js";
import { reject } from "./contracts/validation.js";
import { sanitizeClientRects, sanitizeClipRect } from "./comment-target.js";
import type { TargetGeometry } from "./contracts/frame.js";

/** Existing SDK payload: anchors are required to save; geometry is optional presentation. */
export function readNewMessageTarget(input: Record<string, unknown>) {
  const target = conversationTargetSchema.parse({ kind: input.kind, anchor: input.anchor });
  if (!Number.isSafeInteger(input.targetGeneration) || Number(input.targetGeneration) < 1) {
    reject("INVALID_INPUT", "Invalid new-comment target generation.");
  }
  const viewport = input.viewport as TargetGeometry["viewport"] | undefined;
  const relation = input.relation;
  const clip = viewport && Number.isFinite(viewport.width) && viewport.width > 0 &&
    Number.isFinite(viewport.height) && viewport.height > 0 ? sanitizeClipRect(input.clip, viewport) : null;
  const rects = clip ? sanitizeClientRects(input.rects, viewport).flatMap((rect) => {
    if (!rect) return [];
    const left = Math.max(rect.left, clip.left), top = Math.max(rect.top, clip.top);
    const right = Math.min(rect.right, clip.right), bottom = Math.min(rect.bottom, clip.bottom);
    return right > left && bottom > top ? [{ left, top, right, bottom, width: right - left, height: bottom - top }] : [];
  }) : [];
  const geometry = clip && ["visible", "above", "below", "unavailable"].includes(String(relation)) &&
    (relation !== "visible" || rects.length) ? {
      rects, clip, viewport: viewport!, relation: relation as TargetGeometry["relation"],
      horizontal: typeof input.horizontal === "number" && Number.isFinite(input.horizontal) ? input.horizontal : null,
    } : null;
  return { target, generation: Number(input.targetGeneration), geometry };
}
export type NewMessageTarget = ReturnType<typeof readNewMessageTarget>;
