import type { CommentAnchor, CommentKind, FeedbackComment, FrameEdit } from "./feedback.js";
import type { CapturedView, SemanticSnapshot } from "./history.js";
import type { ReviewConfiguration } from "./page.js";
import { conversationTargetSchema } from "./feedback.js";
import {
  array, enumeration, id, integer, literal, object, refine, reject, schema, union, unique, type Infer,
} from "./validation.js";

export interface FrameIdentity {
  capability: string;
  generation: number;
  pageKey: string;
}
export type FrameEnvelope<Message> = Message & FrameIdentity;

export type ReviewTheme = "light" | "dark";
export interface ThemePayload { theme: ReviewTheme; themeRevision: number }
export function isThemePayload(value: unknown): value is ThemePayload {
  return typeof value === "object" && value !== null &&
    "theme" in value && (value.theme === "light" || value.theme === "dark") &&
    "themeRevision" in value && typeof value.themeRevision === "number" &&
    Number.isSafeInteger(value.themeRevision) && value.themeRevision > 0;
}

/** Correlation alone does not validate a message type or its payload. */
export function isFrameIdentity(value: unknown): value is FrameIdentity {
  return typeof value === "object" && value !== null &&
    "capability" in value && typeof value.capability === "string" &&
    "generation" in value && typeof value.generation === "number" &&
    "pageKey" in value && typeof value.pageKey === "string";
}

export interface FrameRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
export interface FrameViewport { width: number; height: number }
export interface TargetGeometry {
  kind: CommentKind;
  quote: string;
  anchor: CommentAnchor | null;
  targetGeneration: number;
  rects: FrameRect[];
  viewport: FrameViewport;
  relation: "visible" | "above" | "below" | "unavailable";
  clip: FrameRect;
  horizontal: number | null;
}
export type ShellToFrameMessage =
  | FrameThreadAnchors | FrameThreadAction
  | ({ type: "eh:setTheme" } & ThemePayload)
  | ({ type: "eh:configureReview" } & ReviewConfiguration)
  | { type: "eh:anchors"; comments: FeedbackComment[] }
  | { type: "eh:activate"; id: string; scroll: boolean }
  | { type: "eh:remove"; id: string }
  | { type: "eh:modeMenuState"; open: boolean }
  | { type: "eh:deactivateComment" }
  | { type: "eh:commit"; id: string; targetGeneration?: number; restoreFocus?: boolean }
  | { type: "eh:cancel"; targetGeneration?: number; discardThroughGeneration?: number; restoreFocus?: boolean; preserveRetarget?: boolean }
  | { type: "eh:commentOpenResult"; requestedGeneration: number; targetGeneration: number | null; accepted: boolean }
  | { type: "eh:revealTarget"; targetGeneration: number }
  | { type: "eh:flush"; requestId?: string }
  | { type: "eh:captureSnapshot"; requestId: string; requireStable?: boolean }
  | { type: "eh:historyJump"; selector: string; text: string }
  | { type: "eh:abortSave" }
  | { type: "eh:raw"; html: string }
  | { type: "eh:restoreScroll"; x: number; y: number }
  | { type: "eh:assetSaved"; id: string; src: string; stagedId?: string }
  | { type: "eh:assetFailed"; id: string };

export type SnapshotMessage =
  | { type: "eh:snapshot"; requestId: string; snapshot: SemanticSnapshot; capturedAt: number; view: CapturedView; error?: never }
  | { type: "eh:snapshot"; requestId: string; error: { code: string; message: string }; snapshot?: never };

export type FrameToShellMessage =
  | FrameThreadAnchorStates | FrameThreadAction
  | ({ type: "eh:themeApplied" } & ThemePayload)
  | { type: "eh:ready"; scrollHeight: number }
  | ({ type: "eh:configurationApplied" } & ReviewConfiguration)
  | ({ type: "eh:target" | "eh:openComment" | "eh:targetGeometry" } & TargetGeometry)
  | { type: "eh:commentGeometry"; id: string; rects: FrameRect[]; visible: boolean; viewport: FrameViewport }
  | { type: "eh:revealTargetResult"; targetGeneration: number; success: boolean }
  | { type: "eh:historyJumpResult"; success: boolean; reason?: "unresolved" }
  | { type: "eh:interaction"; interaction: string }
  | { type: "eh:dismiss" | "eh:saving" | "eh:clean" | "eh:dynamic" }
  | { type: "eh:activate" | "eh:notInView"; id: string }
  | { type: "eh:anchorStatus"; resolved: string[]; orphaned: string[] }
  | { type: "eh:formBlocked"; reason: string }
  | ({ type: "eh:edit" } & FrameEdit)
  | { type: "eh:asset"; id: string; assetType: string; bytes: ArrayBuffer }
  | { type: "eh:html"; html: string }
  | SnapshotMessage
  | { type: "eh:viewChanged"; view: CapturedView }
  | { type: "eh:flushed"; requestId?: string }
  | { type: "eh:scroll"; x: number; y: number }
  | { type: "eh:external" | "eh:navigate"; href: string };

export type FrameMessage = FrameEnvelope<ShellToFrameMessage | FrameToShellMessage>;

const finiteCoordinate = schema<number>((value, path) => typeof value === "number" && Number.isFinite(value)
  ? value : reject("INVALID_INPUT", "Expected finite geometry.", path));
const dimension = refine(finiteCoordinate, (value) => {
  if (value < 0) reject("INVALID_INPUT", "Negative geometry dimension.");
});
export const conversationRectSchema = refine(object({
  left: finiteCoordinate, top: finiteCoordinate, right: finiteCoordinate, bottom: finiteCoordinate,
  width: dimension, height: dimension,
}), (rect) => {
  if (rect.right < rect.left || rect.bottom < rect.top) reject("INVALID_INPUT", "Inverted geometry.");
});
const renderScopeFields = { capability: id, reviewId: id, pageKey: id, renderId: id, generation: integer(1) };
const projectionScopeFields = { ...renderScopeFields, projectionRevision: integer(1) };
export const anchorProjectionSchema = object({ threadId: id, target: conversationTargetSchema });
export const frameAnchorsSchema = refine(object({
  type: literal("eh:threadAnchors"), ...projectionScopeFields, anchors: array(anchorProjectionSchema),
}), ({ anchors }) => unique(anchors.map((anchor) => anchor.threadId)));
const anchorStateFields = { threadId: id };
export const anchorStateSchema = union(
  object({
    ...anchorStateFields, state: literal("found"),
    rects: refine(array(conversationRectSchema), (rects) => {
      if (!rects.length) reject("INVALID_INPUT", "Found target needs geometry.");
    }),
    viewport: object({ width: dimension, height: dimension }),
    relation: enumeration(["visible", "above", "below", "left", "right"]),
  }),
  object({ ...anchorStateFields, state: literal("missing") }),
  object({ ...anchorStateFields, state: literal("ambiguous"), candidateCount: integer(2) }),
  object({ ...anchorStateFields, state: literal("unavailable"),
    reason: enumeration(["render-loading", "render-changed", "render-unavailable", "hidden", "not-measurable", "invalid-selector"]) }),
);
export const frameAnchorStatesSchema = refine(object({
  type: literal("eh:threadAnchorStates"), ...projectionScopeFields, anchors: array(anchorStateSchema),
}), ({ anchors }) => unique(anchors.map((anchor) => anchor.threadId)));
export type FrameThreadAnchors = Infer<typeof frameAnchorsSchema>;
export type FrameThreadAnchorStates = Infer<typeof frameAnchorStatesSchema>;
export const frameThreadActionSchema = object({
  type: literal("eh:threadAction"), ...projectionScopeFields,
  action: enumeration(["activate", "reveal", "dismiss"]), threadId: id,
});
export type FrameThreadAction = Infer<typeof frameThreadActionSchema>;
function validateRenderScope(states: Infer<typeof renderScopeSchema>, projection: FrameThreadAnchors) {
  if (states.reviewId !== projection.reviewId || states.pageKey !== projection.pageKey ||
      states.renderId !== projection.renderId || states.generation !== projection.generation ||
      states.capability !== projection.capability) {
    reject("SCOPE_MISMATCH", "Stale or foreign render geometry/action.");
  }
}
const renderScopeSchema = object(renderScopeFields);
/** Classify only parsed messages; foreign scope and future revisions are errors. */
export function isCurrentFrameProjection(
  value: FrameThreadAnchorStates | FrameThreadAction, projection: FrameThreadAnchors,
) {
  validateRenderScope(value, projection);
  if (value.projectionRevision > projection.projectionRevision) {
    reject("SCOPE_MISMATCH", "Unknown future anchor projection revision.");
  }
  return value.projectionRevision === projection.projectionRevision;
}
export function sameFrameAnchorProjection(
  left: Omit<FrameThreadAnchors, "projectionRevision">, right: Omit<FrameThreadAnchors, "projectionRevision">,
) {
  return (Object.keys(renderScopeFields) as (keyof typeof renderScopeFields)[]).every((key) => left[key] === right[key]) &&
    left.anchors.length === right.anchors.length && left.anchors.every((anchor) => right.anchors.some((other) =>
      anchor.threadId === other.threadId && JSON.stringify(anchor.target) === JSON.stringify(other.target)));
}
export function validateFrameThreadAction(input: unknown, projectionInput: unknown): FrameThreadAction {
  const action = frameThreadActionSchema.parse(input);
  const projection = frameAnchorsSchema.parse(projectionInput);
  if (!isCurrentFrameProjection(action, projection)) reject("SCOPE_MISMATCH", "Stale anchor projection action.");
  if (!projection.anchors.some((anchor) => anchor.threadId === action.threadId)) {
    reject("SCOPE_MISMATCH", "Thread action is outside the current projection.");
  }
  return action;
}
export function validateFrameAnchorStates(input: unknown, projectionInput: unknown): FrameThreadAnchorStates {
  const states = frameAnchorStatesSchema.parse(input);
  const projection = frameAnchorsSchema.parse(projectionInput);
  if (!isCurrentFrameProjection(states, projection)) reject("SCOPE_MISMATCH", "Stale anchor projection geometry.");
  if (states.anchors.length !== projection.anchors.length ||
      states.anchors.some((state) => !projection.anchors.some((anchor) => anchor.threadId === state.threadId))) {
    reject("SCOPE_MISMATCH", "Anchor states must cover exactly the projected threads.");
  }
  return states;
}
