import {
  assertNoOutstandingWork, directEditSchema, reviewerMutationSchema, sendRequestSchema, submissionSchema,
  type ConversationThread, type DirectEdit, type ReviewerMessage, type ReviewerMutation, type ReviewSubmission,
} from "./feedback.js";
import { pagedSchema } from "./history.js";
import {
  array, booleanValue, enumeration, id, integer, literal, nullable, object, refine,
  reject, text, timestamp, union, version, type Infer,
} from "./validation.js";

export const CONVERSATION_STATE_FILE = "conversation-state.json";
export const reviewSchema = refine(object({
  reviewId: id, entryKey: id, version, state: enumeration(["open", "ended"]),
  createdAt: timestamp, endedAt: nullable(timestamp),
}), (review) => {
  if ((review.state === "ended") !== (review.endedAt !== null)) reject("INVALID_INPUT", "End time must match review state.");
});
export type ConversationReview = Infer<typeof reviewSchema>;
export const canonicalPageSchema = object({
  pageKey: id,
  target: union(object({ kind: literal("file"), path: text() }), object({ kind: literal("url"), url: text() })),
  sourceHash: nullable(id),
});
export type CanonicalPage = Infer<typeof canonicalPageSchema>;
export const reviewPageSchema = object({
  reviewId: id, sequence: integer(1), page: canonicalPageSchema, joinedAt: timestamp,
  savePolicy: enumeration(["writable", "feedback-only"]),
  pendingMessageCount: integer(), pendingEditCount: integer(),
  writeBlockedBy: array(object({ reviewId: id, submissionId: id })),
  revert: nullable(object({ baselineRevisionId: id, sourceHash: id })),
  canRevert: booleanValue,
});
export type ConversationPage = Infer<typeof reviewPageSchema>;
export const reviewPageListSchema = pagedSchema(reviewPageSchema);
export const openReviewRequestSchema = object({ operation: literal("open"), requestId: id, target: text() });
export const reviewReadRequestSchema = union(
  object({ operation: literal("read-review"), reviewId: id, entryKey: id }),
  object({ operation: literal("read-page"), reviewId: id, entryKey: id, pageKey: id }),
  object({ operation: literal("status"), reviewId: id, entryKey: id }),
  object({ operation: literal("poll"), reviewId: id, entryKey: id }),
  object({ operation: literal("submission"), reviewId: id, entryKey: id, submissionId: id }),
  object({ operation: literal("receipt"), reviewId: id, entryKey: id, requestId: id }),
  object({ operation: literal("open-receipt"), target: text(), requestId: id }),
);
export const pollResponseSchema = union(
  refine(object({ state: literal("work"), review: reviewSchema, submission: submissionSchema }), ({ review, submission }) => {
    if (submission.state !== "delivered" || submission.reviewId !== review.reviewId || submission.entryKey !== review.entryKey) {
      reject("INVALID_INPUT", "Poll must return delivered work from the exact review, including after End.");
    }
  }),
  object({ state: literal("waiting"), review: refine(reviewSchema, (review) => {
    if (review.state !== "open") reject("INVALID_INPUT", "Ended review cannot wait without outstanding work.");
  }) }),
  object({ state: literal("ended"), review: refine(reviewSchema, (review) => {
    if (review.state !== "ended") reject("INVALID_INPUT", "Open review cannot signal end.");
  }) }),
);
export const reviewStatusSchema = object({
  review: reviewSchema,
  pendingMessageCount: integer(), pendingEditCount: integer(),
  work: nullable(object({ submissionId: id, state: enumeration(["queued", "delivered"]), version })),
  blockers: array(object({ reviewId: id, submissionId: id, targetKeys: array(id) })),
});
export const statusObservationSchema = union(
  object({ state: literal("known"), status: reviewStatusSchema }),
  object({ state: literal("unknown"), reason: enumeration(["offline", "unavailable", "invalid-response"]) }),
);
export type ReviewStatus = Infer<typeof reviewStatusSchema>;

/** Server-resolved identities and permissions, never trusted from request JSON. */
export interface ReviewScope {
  authenticated: boolean;
  review: ConversationReview;
  pageKeys: readonly string[];
}
export function assertReviewScope(scope: ReviewScope, reference: { reviewId: string; entryKey: string }, pageKeys: readonly string[] = []): void {
  if (!scope.authenticated) reject("UNAUTHORIZED", "Local API authentication required.");
  reviewSchema.parse(scope.review);
  if (scope.review.reviewId !== reference.reviewId || scope.review.entryKey !== reference.entryKey) {
    reject("SCOPE_MISMATCH", "Wrong durable review or canonical entry.");
  }
  for (const key of pageKeys) {
    if (!scope.pageKeys.includes(key)) reject("SCOPE_MISMATCH", "Page is not authorized in this review.");
  }
}
export interface ReviewItems {
  threads: readonly ConversationThread[];
  messages: readonly ReviewerMessage[];
  edits: readonly DirectEdit[];
  sources: readonly {
    reviewId: string; pageKey: string; sourceHash: string | null; writable: boolean;
    revert: { baselineRevisionId: string; sourceHash: string } | null;
  }[];
}
function ownedThread(scope: ReviewScope, items: ReviewItems, threadId: string): ConversationThread {
  const thread = items.threads.find((item) => item.threadId === threadId);
  if (!thread) return reject("NOT_FOUND", "Unknown thread.");
  if (thread.reviewId !== scope.review.reviewId) reject("SCOPE_MISMATCH", "Thread belongs to another review.");
  assertReviewScope(scope, scope.review, [thread.pageKey]);
  return thread;
}
function ownedEdit(scope: ReviewScope, items: ReviewItems, pageKey: string, editId: string): DirectEdit {
  const edit = items.edits.find((item) => item.editId === editId);
  if (!edit) return reject("NOT_FOUND", "Unknown edit.");
  directEditSchema.parse(edit);
  if (edit.reviewId !== scope.review.reviewId || edit.pageKey !== pageKey) reject("SCOPE_MISMATCH", "Edit belongs to another review/page.");
  return edit;
}
export function validateSendSelection(input: unknown, scope: ReviewScope, items: ReviewItems): void {
  const request = sendRequestSchema.parse(input);
  assertReviewScope(scope, request, request.pageKeys);
  for (const selected of request.messages) {
    const thread = ownedThread(scope, items, selected.threadId);
    const message = items.messages.find((item) => item.messageId === selected.messageId);
    if (!message) reject("NOT_FOUND", "Unknown reviewer message.");
    if (message.reviewId !== request.reviewId || message.threadId !== thread.threadId || !request.pageKeys.includes(thread.pageKey)) {
      reject("SCOPE_MISMATCH", "Message does not belong to this selected thread/page.");
    }
    if (message.submissionId !== null) reject("MESSAGE_IMMUTABLE", "Submitted messages cannot be queued again.");
    if (thread.status !== "open") reject("THREAD_BUSY", "Reopen the thread before sending.");
    if (message.version !== selected.version) reject("VERSION_CONFLICT", "Selected message changed.");
  }
  for (const selected of request.edits) {
    const edit = ownedEdit(scope, items, selected.pageKey, selected.editId);
    if (edit.version !== selected.version) reject("VERSION_CONFLICT", "Selected edit changed.");
    if (edit.source.state === "saved") {
      const source = items.sources.find((item) => item.pageKey === edit.pageKey);
      if (source && source.reviewId !== request.reviewId) reject("SCOPE_MISMATCH", "Source evidence belongs to another review.");
      if (!source || !source.writable || source.sourceHash !== edit.source.evidence.sourceHash) {
        reject("SAVE_EVIDENCE_CONFLICT", "Save evidence no longer matches current writable source at Send.");
      }
    }
  }
}
/** Pure preconditions only; the store must run these in its accepting transaction, after exact replay. */
export function validateReviewerMutation(
  input: unknown, scope: ReviewScope, items: ReviewItems, submissions: readonly ReviewSubmission[],
): ReviewerMutation {
  const request = reviewerMutationSchema.parse(input);
  assertReviewScope(scope, request, "pageKey" in request ? [request.pageKey] : []);
  if (scope.review.state === "ended") reject("REVIEW_ENDED", "Saved reviewer content is read-only.");
  if (request.expectedVersion !== scope.review.version) reject("VERSION_CONFLICT", "Review changed; refresh before a new mutation.");
  if ("threadId" in request) {
    const thread = ownedThread(scope, items, request.threadId);
    const messages = items.messages.filter((message) => message.threadId === thread.threadId);
    if (request.operation === "reply" && thread.status !== "open") reject("THREAD_BUSY", "Reopen before replying.");
    if (request.operation === "set-thread-status" && request.status === "resolved" &&
        messages.some((message) => message.submissionId === null || submissions.some((submission) =>
          submission.submissionId === message.submissionId && (submission.state === "queued" || submission.state === "delivered")))) {
      reject("THREAD_BUSY", "Pending or outstanding messages prevent Resolve.");
    }
    if (request.operation === "delete-thread" && messages.some((message) => message.submissionId !== null)) {
      reject("MESSAGE_IMMUTABLE", "Only never-submitted threads may be deleted.");
    }
    if (request.operation === "update-message") {
      const message = items.messages.find((item) => item.messageId === request.messageId);
      if (!message) reject("NOT_FOUND", "Unknown reviewer message.");
      if (message.reviewId !== request.reviewId || message.threadId !== thread.threadId) reject("SCOPE_MISMATCH", "Wrong thread message.");
      if (message.submissionId !== null) reject("MESSAGE_IMMUTABLE", "Submitted instructions are immutable.");
      if (message.version !== request.messageVersion) reject("VERSION_CONFLICT", "Message changed.");
    }
  }
  if (request.operation === "send") {
    validateSendSelection(request, scope, items);
    assertNoOutstandingWork([request.entryKey, ...request.pageKeys], submissions);
    for (const selected of request.edits) {
      if (submissions.some((submission) => submission.edits.some((edit) =>
        edit.reviewId === request.reviewId && edit.editId === selected.editId && edit.version === selected.version))) {
        reject("MESSAGE_IMMUTABLE", "Previously submitted edit versions require a deliberate new edit record.");
      }
    }
  }
  if (request.operation === "record-edit" || request.operation === "save-edit" || request.operation === "revert") {
    assertNoOutstandingWork([request.entryKey, request.pageKey], submissions);
    if (request.operation === "save-edit" || request.operation === "revert") {
      const source = items.sources.find((item) => item.pageKey === request.pageKey);
      if (source && source.reviewId !== request.reviewId) reject("SCOPE_MISMATCH", "Source/revert ownership belongs to another review.");
      if (!source?.writable || source.sourceHash !== request.expectedSourceHash) {
        reject("SAVE_EVIDENCE_CONFLICT", "Writable source changed or is unavailable.");
      }
      if (request.operation === "revert" && (source.revert?.baselineRevisionId !== request.baselineRevisionId ||
          source.revert.sourceHash !== source.sourceHash)) {
        reject("SAVE_EVIDENCE_CONFLICT", "Revert baseline/write ownership does not belong to this review.");
      }
    }
    if (request.operation === "record-edit" && (request.editId === undefined) !== (request.editVersion === undefined)) {
      reject("INVALID_INPUT", "Updating an edit requires its identity and version together.");
    }
    if ("editId" in request && request.editId !== undefined) {
      const edit = ownedEdit(scope, items, request.pageKey, request.editId);
      if (edit.version !== request.editVersion) reject("VERSION_CONFLICT", "Edit changed.");
      if (submissions.some((submission) => submission.edits.some((saved) =>
        saved.reviewId === edit.reviewId && saved.editId === edit.editId))) {
        reject("MESSAGE_IMMUTABLE", "Submitted edits are immutable; create a new record.");
      }
    }
  }
  return request;
}

export function assertEntityScope(
  scope: ReviewScope, reference: { reviewId: string; entryKey: string },
  entity: { reviewId: string; pageKey?: string } | undefined,
): void {
  assertReviewScope(scope, reference);
  if (!entity) reject("NOT_FOUND", "Unknown identity; do not substitute the newest review.");
  if (entity.reviewId !== reference.reviewId) reject("SCOPE_MISMATCH", "Identity belongs to another review.");
  if (entity.pageKey !== undefined) assertReviewScope(scope, reference, [entity.pageKey]);
}
