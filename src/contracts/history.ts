import type { FeedbackBatch } from "./feedback.js";
import {
  agentMessageSchema, conversationThreadSchema, directEditSchema, reviewerMessageSchema,
  type AgentMessage, type ReviewerMessage,
} from "./feedback.js";
import {
  array, canonicalJson, ContractError, CONTRACT_LIMITS, enumeration, id, integer, literal, nullable,
  object, optional, refine, reject, text, timestamp, type Infer, type Schema,
} from "./validation.js";

export type InlineMark = "strong" | "em" | "underline" | "strike" | "delete" | "insert" |
  "code" | "kbd" | "samp" | "sub" | "sup" | "mark";
export interface InlineRun {
  text: string;
  marks: InlineMark[];
  href?: string;
}

/** Normalized flat blocks: legacy attrs and scalar path inputs are not retained. */
export interface SemanticBlock {
  id: string;
  tag: string;
  text: string;
  path: string[];
  selector: string;
  attributes: Record<string, string>;
  runs: InlineRun[];
  parentId?: string;
}

export interface SemanticSnapshot {
  version: 1;
  blocks: SemanticBlock[];
  limitations: string[];
}

export interface RawSemanticSnapshotInput {
  version?: unknown;
  blocks?: unknown;
  limitations?: unknown;
}

export interface RawSemanticBlockInput {
  id?: unknown;
  tag?: unknown;
  text?: unknown;
  path?: unknown;
  selector?: unknown;
  parentId?: unknown;
  attrs?: unknown;
  attributes?: unknown;
  runs?: unknown;
}

export interface CapturedTab {
  groupId: string;
  tabId: string;
  panelId: string;
  label: string;
}

export type CapturedView =
  | { version: 1; status: "identified"; tabs: CapturedTab[] }
  | { version: 1; status: "unverified"; tabs: []; reason: string };

/** Normalized manifest provenance; feedbackOnly is an API input, not this field. */
export interface CaptureProvenance {
  sessionId?: string;
  pageKey?: string;
  sourceHash?: string;
  sourceRevisionId?: string;
  captureId?: string;
  generation?: number;
  feedbackOnlyEdits?: boolean;
  trustedInteractive?: boolean;
}

export interface RevisionManifest {
  revisionId: string;
  version: 1;
  documentId: string;
  reason: string;
  limitations: string[];
  source?: SnapshotRepresentation & { mediaType: string };
  semantic?: SnapshotRepresentation & { schemaVersion: 1; view?: CapturedView };
}

export interface SnapshotRepresentation {
  blobId: string;
  hash: string;
  bytes: number;
  capturedAt: number;
  provenance: CaptureProvenance;
}

export type BaselineTarget = { key: string; ownerSessionId?: string } & (
  { baselineRevisionId: string; baselineUnavailable?: never } |
  { baselineRevisionId?: never; baselineUnavailable: string }
);
export type FeedbackStatus = "queued" | "delivered" | "acknowledged" | "superseded";
export type RoundCaptureStatus = "pending" | "ready" | "partial" | "failed" | "cancelled";
export type TargetCaptureStatus = "pending" | "running" | "ready" | "failed" | "unavailable";
export interface CaptureLease {
  captureId: string;
  status: TargetCaptureStatus;
  ownerSessionId: string | null;
  generation: number | null;
  attempt: number;
  leaseExpiresAt: number;
  error?: string | null;
  capturedAt?: number;
}
export interface SnapshotCoverage {
  source: boolean;
  semantic: boolean;
}
export interface HistoryTarget {
  key: string;
  ownerSessionId?: string | null;
  baselineRevisionId?: string;
  baselineUnavailable?: string;
  resultRevisionId: string | null;
  capture: CaptureLease | null;
  captureStatus?: TargetCaptureStatus;
  baselineCoverage?: SnapshotCoverage;
  resultCoverage?: SnapshotCoverage;
  sourceResultRevisionId?: string;
  sourceResultUnavailable?: string;
  resultUnavailable?: string;
}
export interface HistoryRound {
  roundId: string;
  entryKey: string;
  ordinal: number;
  batchId: string;
  createdAt: number;
  sentAt: string;
  feedbackStatus: FeedbackStatus;
  captureStatus: RoundCaptureStatus;
  targets: HistoryTarget[];
  completedAt?: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
  deliveredFeedback?: FeedbackBatch;
}

export type PersistedHistoryRound = Omit<HistoryRound, "sentAt"> & { sentAt?: string };
export interface HistoryResponse {
  activeKey: string;
  rounds: (Omit<HistoryRound, "targets"> & {
    targets: (HistoryTarget & { filename: string; kind: "file" | "url" })[];
  })[];
}

export type ComparisonMode = "content" | "source";
export type ChangeKind = "added" | "modified" | "removed";
export type MatchConfidence = "exact" | "context" | "ambiguous";
export interface DiffSegment { value: string; added?: true; removed?: true }
export interface SourceBlock { text: string; startLine: number; endLine: number }
export interface ComparisonChange {
  id: string;
  kind: ChangeKind;
  before: string;
  after: string;
  confidence: MatchConfidence;
  evidence: string;
  navigation: { selector: string; blockId: string } | null;
  fields: string[];
  segments: DiffSegment[];
  beforeBlock: SemanticBlock | SourceBlock | null;
  afterBlock: SemanticBlock | SourceBlock | null;
}
export interface ComparisonRow {
  id: string;
  kind: ChangeKind | "unchanged";
  beforeIndex: number | null;
  afterIndex: number | null;
  changeId: string | null;
  confidence: MatchConfidence;
  evidence: string;
  segments: DiffSegment[];
  beforeBlock: SemanticBlock | SourceBlock | null;
  afterBlock: SemanticBlock | SourceBlock | null;
  moveId?: string;
}
interface ComparisonMetadata {
  mode: ComparisonMode;
  limitations: string[];
  baselineRevisionId: string;
  resultRevisionId: string;
  beforeCapturedAt: number;
  afterCapturedAt: number;
  sourceHash: string | null;
  capturedSessionId: string | null;
  capturedGeneration: number | null;
  viewComparison?: { status: "matched" | "mismatch" | "unverified"; message: string };
}
export interface AvailableComparison extends ComparisonMetadata {
  available: true;
  version: 2;
  status: "complete";
  changes: ComparisonChange[];
  rows: ComparisonRow[];
  hunks: { id: string; kind: "context" | "changes"; start: number; count: number }[];
  counts: { added: number; modified: number; removed: number; total: number };
  limits: Record<string, number>;
  endOfFile?: { before: { empty: boolean; newline: boolean }; after: { empty: boolean; newline: boolean } };
}
export interface UnavailableComparison extends Partial<ComparisonMetadata> {
  available: false;
  mode: ComparisonMode;
  reason: string;
  changes: [];
  limitations: string[];
  version?: 2;
  status?: "limited" | "unavailable";
  rows?: [];
  hunks?: [];
  counts?: null;
  limits?: Record<string, number>;
}
export type RevisionComparison = AvailableComparison | UnavailableComparison;

/** Read-only renderer input also accepts older persisted excerpt-only comparisons. */
export interface SavedBlock {
  text: string;
  tag?: string;
  selector?: string;
  path?: string[];
  attributes?: Record<string, string>;
  runs?: { text: string; marks: string[]; href?: string }[];
  startLine?: number;
}
export interface SavedChange extends Omit<Partial<ComparisonChange>, "beforeBlock" | "afterBlock"> {
  beforeBlock?: SavedBlock | null;
  afterBlock?: SavedBlock | null;
}
export interface SavedRow extends Pick<ComparisonRow, "id" | "kind"> {
  beforeBlock?: SavedBlock | null;
  afterBlock?: SavedBlock | null;
  changeId?: string | null;
  moveId?: string;
  segments?: DiffSegment[];
}
export interface ComparisonInput {
  version?: number;
  status?: string;
  available?: boolean;
  rows?: readonly SavedRow[];
  changes?: readonly SavedChange[];
}

export const pagingScopeSchema = refine(object({
  reviewId: id, entryKey: id,
  collection: enumeration(["threads", "context", "history", "pages", "edits", "comparisons"]),
  pageKey: nullable(id), threadId: nullable(id), submissionId: nullable(id),
  status: enumeration(["open", "resolved", "all"]),
}), (scope) => {
  if ((scope.collection === "context") !== (scope.threadId !== null)) reject("INVALID_INPUT", "Only context requires a thread.");
  if ((scope.collection === "comparisons") !== (scope.submissionId !== null)) reject("INVALID_INPUT", "Only comparisons requires a submission.");
  if (scope.collection !== "threads" && scope.status !== "all") reject("INVALID_INPUT", "Status filter applies only to threads.");
});
export type PagingScope = Infer<typeof pagingScopeSchema>;
export const pageQuerySchema = object({
  limit: optional(integer(1, CONTRACT_LIMITS.pageMaximum)), cursor: optional(text()),
});
export const conversationListRequestSchema = object({
  operation: literal("list"), scope: pagingScopeSchema, query: pageQuerySchema,
});
export const pageCursorSchema = object({
  scope: pagingScopeSchema, highWater: integer(), before: integer(1),
});
export type PageCursor = Infer<typeof pageCursorSchema>;
export function encodePageCursor(cursor: PageCursor): string {
  return canonicalJson(pageCursorSchema.parse(cursor));
}
export function decodePageCursor(raw: string, scope: PagingScope): PageCursor {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return reject("INVALID_CURSOR", "Malformed cursor.");
  }
  let cursor: PageCursor;
  try { cursor = pageCursorSchema.parse(parsed); }
  catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return reject("INVALID_CURSOR", "Invalid cursor shape.");
  }
  if (canonicalJson(cursor.scope) !== canonicalJson(pagingScopeSchema.parse(scope)) || cursor.before > cursor.highWater) {
    reject("INVALID_CURSOR", "Cursor belongs to different filters/review or exceeds its high-water mark.");
  }
  return cursor;
}
export function pagedSchema<T>(item: Schema<T>): Schema<{
  items: T[]; nextCursor: string | null; totalCount: number; highWater: number;
}> {
  return refine(object({
    items: array(item, CONTRACT_LIMITS.pageMaximum), nextCursor: nullable(text()), totalCount: integer(), highWater: integer(),
  }), (page) => {
    if (page.totalCount < page.items.length || (!page.items.length && page.nextCursor !== null)) {
      reject("INVALID_INPUT", "Inconsistent page counts/cursor.");
    }
  });
}
export function validatePageOutput<T extends { sequence: number }>(
  input: unknown, item: Schema<T>, scope: PagingScope, queryInput: unknown,
) {
  const page = pagedSchema(item).parse(input);
  const query = pageQuerySchema.parse(queryInput);
  const cursor = query.cursor === undefined ? null : decodePageCursor(query.cursor, scope);
  if (page.items.length > (query.limit ?? CONTRACT_LIMITS.pageDefault) ||
      (cursor && page.highWater !== cursor.highWater)) reject("INVALID_INPUT", "Page exceeds requested window.");
  const sequences = page.items.map((entry) => entry.sequence);
  const ordered = [...sequences].sort((a, b) => scope.collection === "context" ? a - b : b - a);
  if (new Set(sequences).size !== sequences.length || canonicalJson(ordered) !== canonicalJson(sequences) ||
      sequences.some((sequence) => sequence > page.highWater || (cursor && sequence >= cursor.before))) {
    reject("INVALID_INPUT", "Page order/high-water mismatch.");
  }
  if (page.nextCursor !== null) {
    const next = decodePageCursor(page.nextCursor, scope);
    if (next.highWater !== page.highWater || next.before !== Math.min(...sequences)) {
      reject("INVALID_CURSOR", "Next cursor does not continue this page.");
    }
  }
  return page;
}
/** Inputs are the authorized, filtered collection. Sequence is immutable and review-wide. */
export function paginate<T extends { sequence: number }>(
  records: readonly T[], scopeInput: PagingScope, queryInput: unknown, currentSequence: number,
): { items: T[]; nextCursor: string | null; totalCount: number; highWater: number } {
  const scope = pagingScopeSchema.parse(scopeInput);
  const query = pageQuerySchema.parse(queryInput);
  const limit = query.limit ?? CONTRACT_LIMITS.pageDefault;
  const cursor = query.cursor === undefined ? null : decodePageCursor(query.cursor, scope);
  const sequences = records.map((record) => integer(1).parse(record.sequence));
  if (new Set(sequences).size !== sequences.length) reject("INVALID_INPUT", "Duplicate creation sequence.");
  integer().parse(currentSequence);
  if (cursor && cursor.highWater > currentSequence) reject("INVALID_CURSOR", "Cursor exceeds the review's current sequence.");
  const highWater = cursor?.highWater ?? currentSequence;
  const bounded = records.filter((record) => record.sequence <= highWater).sort((a, b) => b.sequence - a.sequence);
  const remaining = bounded.filter((record) => !cursor || record.sequence < cursor.before);
  const selected = remaining.slice(0, limit);
  const nextCursor = remaining.length > selected.length
    ? encodePageCursor({ scope, highWater, before: selected[selected.length - 1]!.sequence }) : null;
  // Context windows load backwards but read chronologically.
  return { items: scope.collection === "context" ? selected.reverse() : selected, nextCursor, totalCount: bounded.length, highWater };
}

export const exchangeSchema = refine(object({
  sequence: integer(1), reviewer: reviewerMessageSchema, response: nullable(agentMessageSchema),
}), ({ sequence, reviewer, response }) => {
  if (sequence !== reviewer.sequence) reject("INVALID_INPUT", "Exchange ordering belongs to its reviewer message.");
  if (response && (response.replyToMessageId !== reviewer.messageId || response.threadId !== reviewer.threadId ||
      response.reviewId !== reviewer.reviewId || response.submissionId !== reviewer.submissionId ||
      (reviewer.intent === "discuss" && response.outcome === "applied"))) {
    reject("INVALID_INPUT", "Reply is not associated with this reviewer message.");
  }
});
export type ConversationExchange = Infer<typeof exchangeSchema>;
export function latestExchange(
  messages: readonly ReviewerMessage[], replies: readonly AgentMessage[], highWater = Number.MAX_SAFE_INTEGER,
): ConversationExchange | null {
  const latest = messages.filter((message) => message.sequence <= highWater).sort((a, b) => b.sequence - a.sequence)[0];
  if (!latest) return null;
  const matches = replies.filter((reply) => reply.replyToMessageId === latest.messageId && reply.sequence <= highWater);
  if (matches.length > 1) reject("INVALID_INPUT", "Multiple replies to one submitted message.");
  return exchangeSchema.parse({ sequence: latest.sequence, reviewer: latest, response: matches[0] ?? null });
}
export const threadSummarySchema = refine(object({
  thread: conversationThreadSchema, sequence: integer(1),
  messageCount: integer(), pendingMessageCount: integer(),
  latestExchange: nullable(exchangeSchema),
}), (summary) => {
  if (summary.sequence !== summary.thread.sequence || summary.pendingMessageCount > summary.messageCount ||
      ((summary.messageCount === 0) !== (summary.latestExchange === null)) ||
      (summary.latestExchange && (summary.latestExchange.reviewer.threadId !== summary.thread.threadId ||
        summary.latestExchange.reviewer.reviewId !== summary.thread.reviewId))) {
    reject("INVALID_INPUT", "Invalid thread summary association/counts.");
  }
});
export const threadPageSchema = pagedSchema(threadSummarySchema);
export const contextPageSchema = pagedSchema(exchangeSchema);
export function contextWindow(
  messages: readonly ReviewerMessage[], replies: readonly AgentMessage[],
  scope: PagingScope, query: unknown, currentSequence: number,
) {
  if (scope.collection !== "context" || scope.threadId === null) reject("INVALID_INPUT", "Context requires one thread.");
  for (const message of [...messages, ...replies]) {
    if (message.reviewId !== scope.reviewId || message.threadId !== scope.threadId) reject("SCOPE_MISMATCH", "Foreign context message.");
  }
  const parsedQuery = pageQuerySchema.parse(query);
  const highWater = parsedQuery.cursor === undefined ? currentSequence : decodePageCursor(parsedQuery.cursor, scope).highWater;
  const exchanges = messages.filter((message) => message.sequence <= highWater).map((message) =>
    latestExchange([message], replies, highWater)!);
  return validatePageOutput(paginate(exchanges, scope, query, currentSequence), exchangeSchema, scope, query);
}
export const resultSummarySchema = object({
  resultId: id, body: text(), createdAt: timestamp,
  title: enumeration(["What changed", "Agent response"]), effect: enumeration(["reply-only", "changes-reported"]),
});
export const submissionHistoryItemSchema = refine(object({
  sequence: integer(1), reviewId: id, submissionId: id, createdAt: timestamp,
  state: enumeration(["queued", "delivered", "handled", "abandoned"]),
  result: nullable(resultSummarySchema),
  comparisonStatus: enumeration(["not-requested", "pending", "ready", "partial", "failed", "unavailable"]),
  comparisonCount: integer(),
}), (item) => {
  if ((item.state === "handled") !== (item.result !== null)) reject("INVALID_INPUT", "Only handled history has a result.");
});
export const submissionHistoryPageSchema = pagedSchema(submissionHistoryItemSchema);
export const comparisonReferenceSchema = object({
  sequence: integer(1), reviewId: id, submissionId: id, pageKey: id,
  baselineRevisionId: nullable(id), resultRevisionId: nullable(id),
  status: enumeration(["not-requested", "pending", "ready", "partial", "failed", "unavailable"]),
  reason: nullable(text()),
});
export const comparisonReferencePageSchema = pagedSchema(comparisonReferenceSchema);
/** Only review-local unsubmitted edits; submitted versions remain in submission reads. */
export const directEditPageSchema = pagedSchema(directEditSchema);
