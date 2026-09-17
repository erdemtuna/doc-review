import type { CommentAnchor, CommentKind, FeedbackComment, FrameEdit } from "./feedback.js";
import type { CapturedView, SemanticSnapshot } from "./history.js";
import type { ReviewConfiguration } from "./page.js";

export interface FrameIdentity {
  capability: string;
  generation: number;
  pageKey: string;
}
export type FrameEnvelope<Message> = Message & FrameIdentity;

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
