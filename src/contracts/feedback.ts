export interface SelectionAnchor {
  quote: string;
  prefix?: string;
  suffix?: string;
  selector?: string;
}

export interface ElementAnchor {
  selector: string;
  label?: string;
}

export type CommentAnchor = SelectionAnchor | ElementAnchor;
export type CommentKind = "selection" | "element";

interface CommentFields {
  id: string;
  quote: string;
  feedback: string;
  createdAt?: number;
  updatedAt?: number;
  correction?: boolean;
  correctionOf?: string;
}

export type FeedbackComment = CommentFields & (
  { kind: "selection"; anchor?: SelectionAnchor | null } |
  { kind: "element"; anchor?: ElementAnchor | null }
);

export type EditKind = "edited" | "deleted" | "moved";
export type EditTextField = "before" | "after" | "before_html" | "after_html" | "moved_after" | "moved_before";

export interface StagedAssetReference {
  id: string;
  preview_src: string;
}

export interface StagedAsset {
  path: string;
  preview_src: string;
}

export interface FeedbackEdit {
  label: string;
  kind: EditKind;
  before?: string;
  after?: string;
  before_html?: string;
  after_html?: string;
  moved_after?: string;
  moved_before?: string;
  feedback_only?: boolean;
  truncated?: boolean;
  truncated_fields?: EditTextField[];
  staged_assets?: StagedAsset[];
  at?: number;
  updatedAt?: number;
}

/** SDK edits reference staged IDs; only the server resolves durable filesystem paths. */
export type FrameEdit = Omit<FeedbackEdit, "staged_assets" | "at" | "updatedAt"> & {
  staged_assets?: StagedAssetReference[];
};

export interface RawFeedbackInput {
  id?: unknown;
  kind?: unknown;
  quote?: unknown;
  anchor?: unknown;
  feedback?: unknown;
  label?: unknown;
  before?: unknown;
  after?: unknown;
  staged_assets?: unknown;
}

/** Batch serialization uses snake_case; stored comments use correctionOf. */
export type BatchComment = FeedbackComment extends infer Comment
  ? Comment extends FeedbackComment
    ? Omit<Comment, "correctionOf" | "createdAt" | "updatedAt"> & { correction_of?: string }
    : never
  : never;

export interface FeedbackBatch {
  batch_id: string;
  status: "feedback";
  pages: {
    kind: "file" | "url";
    file: string;
    url?: string;
    comments: BatchComment[];
    edits: FeedbackEdit[];
  }[];
  overall_note: string;
  sent_at: string;
  next_step: string;
}
