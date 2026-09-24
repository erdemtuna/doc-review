import {
  array, booleanValue, canonicalJson, CONTRACT_LIMITS, enumeration, id, integer, literal,
  nullable, object, optional, refine, reject, text, timestamp, union, unique, version,
  type Infer,
} from "./validation.js";

// Existing consumer types remain during the staged replacement; new boundaries use the schemas below.
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

export const intentSchema = enumeration(["discuss", "request-change"]);
export type ReviewerIntent = Infer<typeof intentSchema>;
export const DEFAULT_REVIEWER_INTENT: ReviewerIntent = "discuss";
export function intentBadge(intent: ReviewerIntent): "Discussion" | "Change requested" {
  return intentSchema.parse(intent) === "discuss" ? "Discussion" : "Change requested";
}

export const conversationTargetSchema = union(
  object({
    kind: literal("selection"),
    anchor: object({
      quote: text(CONTRACT_LIMITS.quoteUnits),
      prefix: optional(text(CONTRACT_LIMITS.contextUnits, false)),
      suffix: optional(text(CONTRACT_LIMITS.contextUnits, false)),
      selector: optional(text(CONTRACT_LIMITS.selectorUnits)),
    }),
  }),
  object({
    kind: literal("element"),
    anchor: object({
      selector: text(CONTRACT_LIMITS.selectorUnits),
      label: optional(text(CONTRACT_LIMITS.labelUnits, false)),
    }),
  }),
);
export type ConversationTarget = Infer<typeof conversationTargetSchema>;
export const overallNoteSchema = object({ body: text(), intent: intentSchema });
export type OverallNote = Infer<typeof overallNoteSchema>;
export const messageOutcomeSchema = enumeration(["applied", "answered", "clarification-needed", "deferred"]);
export const editOutcomeSchema = enumeration(["applied", "already-saved", "deferred"]);

const messageFields = {
  messageId: id, reviewId: id, threadId: id, version, sequence: integer(1),
  createdAt: timestamp, updatedAt: timestamp, body: text(),
};
export const reviewerMessageSchema = object({
  ...messageFields, author: literal("reviewer"), intent: intentSchema, submissionId: nullable(id),
});
export const agentMessageSchema = object({
  ...messageFields, author: literal("agent"), submissionId: id, replyToMessageId: id,
  outcome: messageOutcomeSchema,
});
export const conversationMessageSchema = union(reviewerMessageSchema, agentMessageSchema);
export type ReviewerMessage = Infer<typeof reviewerMessageSchema>;
export type AgentMessage = Infer<typeof agentMessageSchema>;
export type ConversationMessage = Infer<typeof conversationMessageSchema>;
export const conversationThreadSchema = object({
  threadId: id, reviewId: id, pageKey: id, version, sequence: integer(1),
  target: conversationTargetSchema, status: enumeration(["open", "resolved"]),
  createdAt: timestamp, updatedAt: timestamp,
});
export type ConversationThread = Infer<typeof conversationThreadSchema>;

const editTextSchema = text(CONTRACT_LIMITS.editCodePoints, false, true);
const editTextFields = ["before", "after", "before_html", "after_html", "moved_after", "moved_before"] as const;
const editContentFields = {
  label: text(), before: optional(editTextSchema), after: optional(editTextSchema),
  before_html: optional(editTextSchema), after_html: optional(editTextSchema),
  truncated: booleanValue, truncated_fields: array(enumeration(editTextFields), editTextFields.length),
  staged_assets: array(object({ id, preview_src: text() }), CONTRACT_LIMITS.editAssets),
};
export const directEditContentSchema = refine(union(
  object({ ...editContentFields, kind: literal("edited") }),
  object({ ...editContentFields, kind: literal("deleted") }),
  object({ ...editContentFields, kind: literal("moved"), moved_after: editTextSchema, moved_before: editTextSchema }),
), (edit) => {
  unique(edit.truncated_fields);
  unique(edit.staged_assets.map((asset) => asset.id));
  if (edit.truncated !== (edit.truncated_fields.length > 0)) reject("INVALID_INPUT", "Inconsistent truncation metadata.");
  for (const field of edit.truncated_fields) {
    if (!(field in edit)) reject("INVALID_INPUT", "Truncated field must be preserved.");
  }
  if (edit.before === undefined && edit.before_html === undefined) reject("INVALID_INPUT", "An edit requires its before content.");
  if (edit.kind === "edited" && edit.after === undefined && edit.after_html === undefined) {
    reject("INVALID_INPUT", "An edited block requires its after content.");
  }
});
export type DirectEditContent = Infer<typeof directEditContentSchema>;
export const saveEvidenceSchema = object({
  evidenceId: id, reviewId: id, pageKey: id, editId: id, editVersion: version,
  sourceHash: id, savedAt: timestamp,
});
export type SaveEvidence = Infer<typeof saveEvidenceSchema>;
export const directEditSchema = refine(object({
  editId: id, reviewId: id, pageKey: id, version, sequence: integer(1),
  author: literal("reviewer"), createdAt: timestamp, updatedAt: timestamp,
  content: directEditContentSchema,
  source: union(
    object({ state: literal("pending") }),
    object({ state: literal("saved"), evidence: saveEvidenceSchema }),
  ),
  assets: array(object({ id, path: text(), preview_src: text() }), CONTRACT_LIMITS.editAssets),
}), (edit) => {
  unique(edit.assets.map((asset) => asset.id));
  if (canonicalJson(edit.assets.map(({ id: assetId, preview_src }) => ({ id: assetId, preview_src }))) !==
      canonicalJson(edit.content.staged_assets)) reject("INVALID_INPUT", "Durable assets must match staged references.");
  if (edit.source.state === "saved") {
    const evidence = edit.source.evidence;
    if (evidence.reviewId !== edit.reviewId || evidence.pageKey !== edit.pageKey ||
        evidence.editId !== edit.editId || evidence.editVersion !== edit.version || edit.content.truncated) {
      reject("SAVE_EVIDENCE_CONFLICT", "Save evidence does not describe this exact complete edit.");
    }
  }
});
export type DirectEdit = Infer<typeof directEditSchema>;
export function validateSaveEvidence(edit: DirectEdit, currentSourceHash: string | null, writable: boolean): void {
  directEditSchema.parse(edit);
  if (edit.source.state !== "saved" || !writable || edit.source.evidence.sourceHash !== currentSourceHash) {
    reject("SAVE_EVIDENCE_CONFLICT", "Current writable source does not match server-owned save evidence.");
  }
}

export const messageSelectionSchema = object({ threadId: id, messageId: id, version });
export const editSelectionSchema = object({ pageKey: id, editId: id, version });
export const submittedMessageSchema = object({
  pageKey: id, target: conversationTargetSchema, message: reviewerMessageSchema,
});
export const submissionSchema = refine(object({
  submissionId: id, reviewId: id, entryKey: id, version, sequence: integer(1),
  state: enumeration(["queued", "delivered", "handled", "abandoned"]),
  createdAt: timestamp, deliveredAt: nullable(timestamp), completedAt: nullable(timestamp),
  pageKeys: array(id), exclusionKeys: array(id),
  messages: array(submittedMessageSchema), edits: array(directEditSchema),
  overallNote: optional(overallNoteSchema),
  resultId: nullable(id), abandonment: nullable(object({ requestId: id, at: timestamp, reason: text() })),
}), (submission) => {
  unique(submission.pageKeys);
  unique(submission.exclusionKeys);
  unique(submission.messages.map(({ message }) => message.messageId));
  unique(submission.edits.map((edit) => edit.editId));
  if (!submission.pageKeys.length ||
      (!submission.messages.length && !submission.edits.length && !submission.overallNote)) {
    reject("EMPTY_SUBMISSION", "Select known pages and at least one message, edit, or overall note.");
  }
  const expectedKeys = exclusionKeys(submission.entryKey, submission.pageKeys);
  if (canonicalJson(expectedKeys) !== canonicalJson(submission.exclusionKeys)) {
    reject("INVALID_INPUT", "Exclusions must be the sorted entry and submitted page target keys.");
  }
  for (const { pageKey, message } of submission.messages) {
    if (message.reviewId !== submission.reviewId || message.submissionId !== submission.submissionId ||
        !submission.pageKeys.includes(pageKey)) reject("SCOPE_MISMATCH", "Message is outside the submission.");
  }
  for (const edit of submission.edits) {
    if (edit.reviewId !== submission.reviewId || !submission.pageKeys.includes(edit.pageKey)) {
      reject("SCOPE_MISMATCH", "Edit is outside the submission.");
    }
  }
  if ((submission.state === "queued" && submission.deliveredAt !== null) ||
      ((submission.state === "delivered" || submission.state === "handled") && submission.deliveredAt === null) ||
      ((submission.state === "handled" || submission.state === "abandoned") !== (submission.completedAt !== null)) ||
      ((submission.state === "handled") !== (submission.resultId !== null)) ||
      ((submission.state === "abandoned") !== (submission.abandonment !== null))) {
    reject("INVALID_INPUT", "Inconsistent submission lifecycle evidence.");
  }
});
export type ReviewSubmission = Infer<typeof submissionSchema>;

export const inlineResponseSchema = object({
  threadId: id, messageId: id, messageVersion: version, body: text(), outcome: messageOutcomeSchema,
});
export const directEditOutcomeSchema = object({
  editId: id, editVersion: version, outcome: editOutcomeSchema, reason: text(),
});
export const completeResponseSchema = object({
  operation: literal("respond"), reviewId: id, entryKey: id, submissionId: id,
  requestId: id, expectedVersion: version,
  responses: array(inlineResponseSchema), editOutcomes: array(directEditOutcomeSchema),
  resultNote: text(), overallOutcome: optional(messageOutcomeSchema),
});
export type CompleteResponse = Infer<typeof completeResponseSchema>;

export function validateResponseCoverage(input: unknown, delivered: ReviewSubmission): CompleteResponse {
  const response = completeResponseSchema.parse(input);
  const submission = submissionSchema.parse(delivered);
  if (response.reviewId !== submission.reviewId || response.entryKey !== submission.entryKey ||
      response.submissionId !== submission.submissionId) reject("SCOPE_MISMATCH", "Response belongs to another submission.");
  if (submission.state === "abandoned") reject("SUBMISSION_ABANDONED", "Abandonment won; late completion is rejected.");
  if (submission.state === "handled") reject("ALREADY_HANDLED", "Use the original response request for replay.");
  if (submission.state !== "delivered") reject("RESPONSE_COVERAGE", "Only delivered work can be completed.");
  if (response.expectedVersion !== submission.version) reject("VERSION_CONFLICT", "Submission version changed.");
  const messages = new Map(submission.messages.map(({ message }) => [message.messageId, message]));
  const edits = new Map(submission.edits.map((edit) => [edit.editId, edit]));
  if (response.responses.length !== messages.size || response.editOutcomes.length !== edits.size) {
    reject("RESPONSE_COVERAGE", "Every submitted message and exact edit must have one outcome.");
  }
  for (const reply of response.responses) {
    const message = messages.get(reply.messageId);
    if (!message || reply.threadId !== message.threadId || reply.messageVersion !== message.version) {
      reject("RESPONSE_COVERAGE", "Unknown, duplicate, or mismatched message response.");
    }
    if (message.intent === "discuss" && reply.outcome === "applied") reject("RESPONSE_COVERAGE", "Discuss cannot authorize Applied.");
    messages.delete(reply.messageId);
  }
  for (const outcome of response.editOutcomes) {
    const edit = edits.get(outcome.editId);
    if (!edit || outcome.editVersion !== edit.version) reject("RESPONSE_COVERAGE", "Unknown, duplicate, or mismatched edit.");
    if ((outcome.outcome === "already-saved" && edit.source.state !== "saved") ||
        (outcome.outcome === "applied" && (edit.source.state === "saved" || edit.content.truncated))) {
      reject("SAVE_EVIDENCE_CONFLICT", "Outcome cannot claim new work or saved evidence for this edit.");
    }
    edits.delete(outcome.editId);
  }
  if ((submission.overallNote !== undefined) !== (response.overallOutcome !== undefined) ||
      (submission.overallNote?.intent === "discuss" && response.overallOutcome === "applied")) {
    reject("RESPONSE_COVERAGE", "Overall outcome requires its own nonempty note and intent.");
  }
  return response;
}
export function responseEffect(response: CompleteResponse): "reply-only" | "changes-reported" {
  completeResponseSchema.parse(response);
  return response.responses.some((reply) => reply.outcome === "applied") ||
    response.editOutcomes.some((edit) => edit.outcome === "applied") || response.overallOutcome === "applied"
    ? "changes-reported" : "reply-only";
}
export const submissionResultSchema = object({
  resultId: id, reviewId: id, submissionId: id, createdAt: timestamp, sequence: integer(1),
  author: literal("agent"), body: text(), title: enumeration(["What changed", "Agent response"]),
  effect: enumeration(["reply-only", "changes-reported"]),
  responses: array(agentMessageSchema), editOutcomes: array(directEditOutcomeSchema),
  overallOutcome: optional(messageOutcomeSchema),
});
export type SubmissionResult = Infer<typeof submissionResultSchema>;
export function resultTitle(response: CompleteResponse): SubmissionResult["title"] {
  completeResponseSchema.parse(response);
  return responseEffect(response) === "changes-reported" ||
    response.editOutcomes.some((edit) => edit.outcome === "already-saved") ? "What changed" : "Agent response";
}

const mutationFields = { reviewId: id, entryKey: id, requestId: id, expectedVersion: version };
export const joinReviewPageRequestSchema = object({
  ...mutationFields, operation: literal("join-page"), target: text(),
});
export const sendRequestSchema = refine(object({
  ...mutationFields, operation: literal("send"),
  pageKeys: array(id), messages: array(messageSelectionSchema), edits: array(editSelectionSchema),
  overallNote: optional(overallNoteSchema),
}), (request) => {
  unique(request.pageKeys);
  unique(request.messages.map((message) => message.messageId));
  unique(request.edits.map((edit) => edit.editId));
  if (!request.pageKeys.length || (!request.messages.length && !request.edits.length && !request.overallNote)) {
    reject("EMPTY_SUBMISSION", "Send requires selected known pages and feedback.");
  }
  if (request.edits.some((edit) => !request.pageKeys.includes(edit.pageKey))) reject("SCOPE_MISMATCH", "Unselected edit page.");
});
export type SendRequest = Infer<typeof sendRequestSchema>;
export const reviewerMutationSchema = union(
  joinReviewPageRequestSchema,
  object({ ...mutationFields, operation: literal("create-thread"), pageKey: id, target: conversationTargetSchema,
    body: text(), intent: intentSchema }),
  object({ ...mutationFields, operation: literal("reply"), threadId: id, body: text(), intent: intentSchema }),
  object({ ...mutationFields, operation: literal("update-message"), threadId: id, messageId: id,
    messageVersion: version, body: text(), intent: intentSchema }),
  object({ ...mutationFields, operation: literal("set-thread-status"), threadId: id, status: enumeration(["open", "resolved"]) }),
  object({ ...mutationFields, operation: literal("delete-thread"), threadId: id }),
  object({ ...mutationFields, operation: literal("record-edit"), pageKey: id,
    editId: optional(id), editVersion: optional(version), content: directEditContentSchema }),
  object({ ...mutationFields, operation: literal("save-edit"), pageKey: id, editId: id, editVersion: version,
    expectedSourceHash: id, html: text(Infinity, false) }),
  object({ ...mutationFields, operation: literal("revert"), pageKey: id, expectedSourceHash: id, baselineRevisionId: id }),
  sendRequestSchema,
  object({ ...mutationFields, operation: literal("end"), confirmUnsentReadOnly: literal(true) }),
);
export type ReviewerMutation = Infer<typeof reviewerMutationSchema>;
export const abandonRequestSchema = object({
  ...mutationFields, operation: literal("abandon"), submissionId: id,
  confirmExternalWorkMayContinue: literal(true), reason: text(),
});
export type AbandonRequest = Infer<typeof abandonRequestSchema>;
export const receiptValueSchema = object({
  reviewVersion: version,
  pageKey: optional(id), threadId: optional(id), messageId: optional(id), editId: optional(id),
  submissionId: optional(id), resultId: optional(id),
});
export const mutationOperationSchema = enumeration([
  "open", "join-page", "create-thread", "reply", "update-message", "set-thread-status", "delete-thread",
  "record-edit", "save-edit", "revert", "send", "end", "abandon", "respond",
]);
export const handlingReceiptSchema = refine(object({
  receiptId: id, requestId: id, reviewId: id, entryKey: id,
  operation: mutationOperationSchema, acceptedAt: timestamp, value: receiptValueSchema,
}), (receipt) => {
  const required: Partial<Record<typeof receipt.operation, (keyof Infer<typeof receiptValueSchema>)[]>> = {
    "join-page": ["pageKey"],
    "create-thread": ["threadId", "messageId"], reply: ["threadId", "messageId"],
    "update-message": ["threadId", "messageId"], "set-thread-status": ["threadId"], "delete-thread": ["threadId"],
    "record-edit": ["editId"], "save-edit": ["editId"], send: ["submissionId"],
    abandon: ["submissionId"], respond: ["submissionId", "resultId"],
  };
  for (const field of required[receipt.operation] ?? []) {
    if (receipt.value[field] === undefined) reject("INVALID_INPUT", `Receipt requires ${field}.`);
  }
  const allowed = new Set<string>(["reviewVersion", ...required[receipt.operation] ?? []]);
  for (const field of Object.keys(receipt.value)) {
    if (!allowed.has(field)) reject("INVALID_INPUT", `Receipt operation does not produce ${field}.`);
  }
});
export type HandlingReceipt = Infer<typeof handlingReceiptSchema>;
export const acceptedMutationSchema = object({ ok: literal(true), receipt: handlingReceiptSchema });
export const receiptLookupSchema = union(
  object({ state: literal("accepted"), receipt: handlingReceiptSchema }),
  object({ state: literal("not-found"), requestId: id }),
);
export interface ReplayRecord { canonicalPayload: string; receipt: HandlingReceipt }

/** Call after authentication/scope checks, but before ANY version/lifecycle/exclusion check. */
export function exactReplay(
  request: { requestId: string; operation: string; reviewId?: string; entryKey?: string },
  previous: ReplayRecord | undefined,
): HandlingReceipt | null {
  if (!previous) return null;
  const receipt = handlingReceiptSchema.parse(previous.receipt);
  if (request.requestId !== receipt.requestId || canonicalJson(request) !== previous.canonicalPayload) {
    reject("REQUEST_CONFLICT", "Request identity was already used with different content.");
  }
  if (request.operation !== receipt.operation || (request.reviewId !== undefined && request.reviewId !== receipt.reviewId) ||
      (request.entryKey !== undefined && request.entryKey !== receipt.entryKey)) {
    reject("INVALID_INPUT", "Stored replay receipt does not match its request scope/operation.");
  }
  return receipt;
}
export function exclusionKeys(entryKey: string, pageKeys: readonly string[]): string[] {
  id.parse(entryKey);
  array(id).parse(pageKeys);
  return [...new Set([entryKey, ...pageKeys])].sort();
}
export function outstandingSubmissions(targets: readonly string[], submissions: readonly ReviewSubmission[]): string[] {
  return submissions.filter((submission) => {
    submissionSchema.parse(submission);
    return (submission.state === "queued" || submission.state === "delivered") &&
      submission.exclusionKeys.some((key) => targets.includes(key));
  }).map((submission) => submission.submissionId);
}
export function assertNoOutstandingWork(targets: readonly string[], submissions: readonly ReviewSubmission[]): void {
  if (outstandingSubmissions(targets, submissions).length) reject("WORK_OUTSTANDING", "A known canonical target has outstanding work.");
}
export function validateAbandonment(input: unknown, current: ReviewSubmission): AbandonRequest {
  const request = abandonRequestSchema.parse(input);
  submissionSchema.parse(current);
  if (request.reviewId !== current.reviewId || request.entryKey !== current.entryKey ||
      request.submissionId !== current.submissionId) reject("SCOPE_MISMATCH", "Submission belongs to another review.");
  if (current.state === "handled") reject("ALREADY_HANDLED", "Response committed first; abandonment is inapplicable.");
  if (current.state === "abandoned") reject("SUBMISSION_ABANDONED", "Use the original abandonment request for replay.");
  if (request.expectedVersion !== current.version) reject("VERSION_CONFLICT", "Submission version changed.");
  return request;
}

/** Validate the complete transaction's public artifacts, not an acknowledgement-only receipt. */
export function validateResponseCommit(
  submission: ReviewSubmission, input: unknown, resultInput: unknown, receiptInput: unknown,
): { result: SubmissionResult; receipt: HandlingReceipt } {
  const response = validateResponseCoverage(input, submission);
  const result = submissionResultSchema.parse(resultInput);
  const receipt = handlingReceiptSchema.parse(receiptInput);
  if (result.reviewId !== submission.reviewId || result.submissionId !== submission.submissionId ||
      result.body !== response.resultNote || result.title !== resultTitle(response) ||
      result.effect !== responseEffect(response) || result.overallOutcome !== response.overallOutcome ||
      canonicalJson(result.editOutcomes) !== canonicalJson(response.editOutcomes) ||
      result.responses.length !== response.responses.length) {
    reject("RESPONSE_COVERAGE", "Result does not represent the complete accepted response.");
  }
  unique(result.responses.map((reply) => reply.messageId));
  for (let index = 0; index < response.responses.length; index++) {
    const inputReply = response.responses[index]!;
    const savedReply = result.responses[index]!;
    if (savedReply.reviewId !== submission.reviewId || savedReply.submissionId !== submission.submissionId ||
        savedReply.threadId !== inputReply.threadId || savedReply.replyToMessageId !== inputReply.messageId ||
        savedReply.body !== inputReply.body || savedReply.outcome !== inputReply.outcome) {
      reject("RESPONSE_COVERAGE", "Persisted reply association differs from accepted response.");
    }
  }
  if (receipt.operation !== "respond" || receipt.requestId !== response.requestId ||
      receipt.reviewId !== result.reviewId || receipt.entryKey !== submission.entryKey ||
      receipt.value.submissionId !== result.submissionId || receipt.value.resultId !== result.resultId) {
    reject("RESPONSE_COVERAGE", "Atomic result and handling receipt disagree.");
  }
  return { result, receipt };
}

export const submissionReadSchema = refine(object({
  submission: submissionSchema, result: nullable(submissionResultSchema), receipt: nullable(handlingReceiptSchema),
}), ({ submission, result, receipt }) => {
  if (submission.state !== "handled") {
    if (result !== null || receipt !== null) reject("INVALID_INPUT", "Uncompleted work cannot claim a handling result.");
    return;
  }
  if (!result || !receipt || result.resultId !== submission.resultId) reject("RESPONSE_COVERAGE", "Handled submission requires its result and receipt.");
  const responses = result.responses.map((reply) => {
    const message = submission.messages.find((item) => item.message.messageId === reply.replyToMessageId)?.message;
    if (!message) reject("RESPONSE_COVERAGE", "Reply references an unknown submitted message.");
    return { threadId: reply.threadId, messageId: message.messageId, messageVersion: message.version,
      body: reply.body, outcome: reply.outcome };
  });
  const deliveredVersion = submission.version - 1;
  validateResponseCommit({ ...submission, version: deliveredVersion, state: "delivered", completedAt: null, resultId: null }, {
    operation: "respond", reviewId: submission.reviewId, entryKey: submission.entryKey, submissionId: submission.submissionId,
    requestId: receipt.requestId, expectedVersion: deliveredVersion,
    responses, editOutcomes: result.editOutcomes, resultNote: result.body,
    ...(result.overallOutcome === undefined ? {} : { overallOutcome: result.overallOutcome }),
  }, result, receipt);
});
