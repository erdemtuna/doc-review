import type {
  AvailableComparison, CaptureProvenance, FrameEnvelope, FrameIdentity, Page, PersistedPageRecord,
  RawPageInput, RawSemanticSnapshotInput, RevisionComparison, SemanticSnapshot, ShellToFrameMessage,
  SnapshotMessage, UnavailableComparison, PageResponse, FrameRenderState, RenderExecution,
  FrameToShellMessage, ThemePayload,
} from "../../src/contracts/index.js";
import { isFrameIdentity, isPageResponse } from "../../src/contracts/index.js";
import { framePolicy } from "../../src/frame-policy.js";
import { applyBodyReviewMode, keepBodyInReviewMode, normalizeReviewMode, reviewConfiguration } from "../../src/review-mode.js";
import { frameMessage } from "../../src/frame-channel.js";

type Assert<Condition extends true> = Condition;
type NotAssignable<From, To> = From extends To ? false : true;
export type RejectRawPage = Assert<NotAssignable<RawPageInput, Page>>;
export type RejectStoredPageAsPublic = Assert<NotAssignable<PersistedPageRecord, Page>>;
export type RequireFeedbackValidation = Assert<NotAssignable<PageResponse, Page>>;
export type RejectRawSnapshot = Assert<NotAssignable<RawSemanticSnapshotInput, SemanticSnapshot>>;
export type RejectRawProvenanceName = Assert<NotAssignable<"feedbackOnly", keyof CaptureProvenance>>;
export type RequireIdentityGeneration = Assert<NotAssignable<{ capability: string; pageKey: string }, FrameIdentity>>;
export type RejectGenerationString = Assert<NotAssignable<{ capability: string; pageKey: string; generation: string }, FrameIdentity>>;
export type RejectMissingCaptureResult = Assert<NotAssignable<{ type: "eh:snapshot"; requestId: string }, SnapshotMessage>>;
export type RequireUnavailableReason = Assert<NotAssignable<{ available: false; mode: "content"; changes: []; limitations: [] }, UnavailableComparison>>;
export type RejectUnavailableCounts = Assert<NotAssignable<UnavailableComparison, AvailableComparison>>;
export type RequireTheme = Assert<NotAssignable<{ themeRevision: number }, ThemePayload>>;
export type RequireThemeRevision = Assert<NotAssignable<{ theme: "light" }, ThemePayload>>;
export type RejectNullTheme = Assert<NotAssignable<{ theme: null; themeRevision: number }, ThemePayload>>;
export type RejectNullThemeRevision = Assert<NotAssignable<{ theme: "light"; themeRevision: null }, ThemePayload>>;
export type RejectUnknownTheme = Assert<NotAssignable<{ theme: "system"; themeRevision: number }, ThemePayload>>;
export type RejectThemeAckDirection = Assert<NotAssignable<{ type: "eh:themeApplied"; theme: "light"; themeRevision: number }, ShellToFrameMessage>>;
export type RejectThemeCommandDirection = Assert<NotAssignable<{ type: "eh:setTheme"; theme: "light"; themeRevision: number }, FrameToShellMessage>>;
export const themeCommand = {
  type: "eh:setTheme", theme: "dark", themeRevision: 1, capability: "secret", generation: 1, pageKey: "page",
} satisfies FrameEnvelope<ShellToFrameMessage>;

export const configuration = reviewConfiguration({ kind: "file", arbitrary: true }, "invalid");
export const defaultMode = normalizeReviewMode();
export const policy = framePolicy({ kind: "url", extraMetadata: true }, "http://localhost:3000");
export const message = {
  type: "eh:configureReview", mode: "view", savePolicy: "feedback-only",
  capability: "secret", generation: 1, pageKey: "page",
} satisfies FrameEnvelope<ShellToFrameMessage>;
export const unavailable = {
  available: false, mode: "content", reason: "Missing snapshot", changes: [], limitations: [],
} satisfies RevisionComparison;
export function summarize(comparison: RevisionComparison): string {
  if (comparison.available) return `${comparison.counts.total} changes`;
  return comparison.reason;
}
export function readIdentity(input: unknown): number | null {
  return isFrameIdentity(input) ? input.generation : null;
}
export function constructMessage(): FrameEnvelope<{ type: "eh:ready"; scrollHeight: number }> {
  return frameMessage("eh:ready" as const, { scrollHeight: 100, capability: 123, generation: "spoofed" });
}
export const emptyFrame = { key: null, renderId: null, generation: 0, loading: false } satisfies FrameRenderState;
export const execution = {
  executionMode: "static", savePolicy: "writable", feedbackOnly: false, executionNotice: null,
} satisfies RenderExecution;
export function readPageEnvelope(value: unknown): string | null {
  return isPageResponse(value) ? value.filename : null;
}

export function configureRealDocument(document: Document): void {
  applyBodyReviewMode(document.body, "view");
  const controller = keepBodyInReviewMode(document.body, "view");
  controller.setMode("edit");
  controller.disconnect();
}
