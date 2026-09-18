import type { FeedbackBatch } from "./feedback.js";

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
