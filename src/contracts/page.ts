import type { FeedbackComment, FeedbackEdit } from "./feedback.js";

// Keep the currently served page guard self-contained until consumer integration.
export type {
  CanonicalPage, ConversationPage, ConversationReview, ReviewItems, ReviewScope, ReviewStatus,
} from "./page-boundary.js";

export type ReviewMode = "view" | "edit";
export type SavePolicy = "writable" | "feedback-only";
export type ExecutionMode = "static" | "interactive" | "application";
export type ExecutionPreference = "auto" | "static";

export interface ReviewConfiguration {
  mode: ReviewMode;
  savePolicy: SavePolicy;
}

export interface ExecutionPolicy {
  executionMode: ExecutionMode;
  savePolicy: SavePolicy;
  feedbackOnly: boolean;
}

export type PageMetadata = ExecutionPolicy & {
  key: string;
  file: string;
  filename: string;
  markdown: boolean;
  executionPreference?: ExecutionPreference;
  canRevert: boolean;
  pollCommand: string;
  historySupported: boolean;
} & ({ kind: "file"; url?: never } | { kind: "url"; url: string });

/** Normalized feedback, not a durable Store page or unvalidated JSON. */
export type Page = PageMetadata & { comments: FeedbackComment[]; edits: FeedbackEdit[] };

/** A checked response envelope does not validate legacy feedback entries. */
export type PageResponse = PageMetadata & { comments: unknown[]; edits: unknown[] };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isExecutionPolicy(value: unknown): value is ExecutionPolicy {
  return record(value) &&
    (value.executionMode === "static" || value.executionMode === "interactive" || value.executionMode === "application") &&
    (value.savePolicy === "writable" || value.savePolicy === "feedback-only") &&
    typeof value.feedbackOnly === "boolean";
}

export function isPageResponse(value: unknown): value is PageResponse {
  return record(value) && isExecutionPolicy(value) &&
    typeof value.key === "string" && typeof value.file === "string" &&
    typeof value.filename === "string" && typeof value.markdown === "boolean" &&
    typeof value.canRevert === "boolean" && typeof value.pollCommand === "string" &&
    typeof value.historySupported === "boolean" &&
    (value.executionPreference === undefined || value.executionPreference === "auto" || value.executionPreference === "static") &&
    ((value.kind === "file" && value.url === undefined) || (value.kind === "url" && typeof value.url === "string")) &&
    Array.isArray(value.comments) && Array.isArray(value.edits);
}

/** Successfully decoded legacy storage still needs normalization before becoming Page. */
export type PersistedPageRecord = {
  key: string;
  pristine: string;
  comments: FeedbackComment[];
  edits: FeedbackEdit[];
  updatedAt: number;
  revisionRefs?: string[];
} & ({ kind?: "file"; file: string; url?: never } | { kind: "url"; url: string; file?: never });

/** Boundary fields are unknown until the corresponding producer's validator runs. */
export interface RawPageInput {
  key?: unknown;
  kind?: unknown;
  file?: unknown;
  url?: unknown;
  markdown?: unknown;
  savePolicy?: unknown;
  feedbackOnly?: unknown;
  comments?: unknown;
  edits?: unknown;
}

export interface RenderIdentity {
  renderId: string;
  generation: number;
  pageKey: string;
}

/** The controller's current frame may be absent or not yet ready. */
export interface FrameRenderState {
  key: string | null;
  renderId: string | null;
  generation: number;
  loading: boolean;
}

export interface RenderExecution extends ExecutionPolicy {
  executionNotice: string | null;
}

export function isRenderExecution(value: unknown): value is RenderExecution {
  return record(value) && isExecutionPolicy(value) &&
    (value.executionNotice === null || typeof value.executionNotice === "string");
}

export interface RenderMetadata extends RenderExecution {
  sourceHash: string | null;
  sourceCapturedAt: string | null;
}

export interface RenderRegistration extends RenderIdentity {
  capability: string;
  path: string;
}
