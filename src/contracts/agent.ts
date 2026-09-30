import { handlingReceiptSchema, intentSchema, messageOutcomeSchema, editOutcomeSchema } from "./feedback.js";
import { reviewSchema } from "./page-boundary.js";
import {
  array, booleanValue, enumeration, id, integer, literal, nullable, object, optional,
  refine, reject, text, timestamp, union, version,
} from "./validation.js";

export const AGENT_OUTPUT_BYTES = 16 * 1024;
export const agentReferenceSchema = object({ reviewId: id, entryKey: id });
const submissionScope = { reviewId: id, entryKey: id, submissionId: id };
export const agentReadRequestSchema = refine(object({
  operation: enumeration(["submission", "context", "history", "content", "response-template", "status"]),
  reviewId: id, entryKey: id,
  submissionId: optional(id), threadId: optional(id), before: optional(id),
  field: optional(text()), cursor: optional(text()), limit: optional(integer(1, 100)),
  requestId: optional(id), version: optional(version),
  invocation: optional(enumeration(["doc-review", "npx -y @erdemtuna/doc-review"])),
}), (request) => {
  const allowed: Record<typeof request.operation, string[]> = {
    submission: ["submissionId", "cursor", "limit"],
    context: ["submissionId", "threadId", "cursor", "limit"],
    history: ["before", "cursor", "limit"],
    content: ["submissionId", "field", "version", "cursor"],
    "response-template": ["submissionId", "requestId", "cursor"],
    status: ["cursor", "limit"],
  };
  for (const key of Object.keys(request)) {
    if (!["operation", "reviewId", "entryKey", "invocation", ...allowed[request.operation]].includes(key)) {
      reject("INVALID_INPUT", `Field ${key} does not apply to ${request.operation}.`);
    }
  }
  if (["submission", "context", "content", "response-template"].includes(request.operation) && !request.submissionId) {
    reject("INVALID_INPUT", "This operation requires a submission.");
  }
});
export const agentHandoffSchema = object({
  pollCommand: text(), statusCommand: text(), responseCommand: text(),
  historyCommand: text(), submissionCommand: optional(text()), templateCommand: optional(text()),
  instructions: text(),
});
const identity = object({ ...submissionScope, version, field: text() });
const integrity = { utf8Bytes: integer(), sha256: id };
export const contentReferenceSchema = object({
  kind: literal("reference"), identity, encoding: enumeration(["utf8", "json"]),
  ...integrity, command: text(), preview: optional(text(Infinity, false)),
  fields: optional(array(object({ name: text(), encoding: enumeration(["utf8", "json"]), ...integrity }))),
});
export const agentTextSchema = union(object({ kind: literal("inline"), text: text(Infinity, false) }), contentReferenceSchema);
// JSON metadata is either retained exactly inline or retrieved through the same scoped content reader.
import { schema } from "./validation.js";
const jsonSchema = schema<unknown>((value) => {
  if (value === undefined) reject("INVALID_INPUT", "Expected JSON data.");
  return value;
});
export const agentDataSchema = union(object({ kind: literal("inline"), value: jsonSchema }), contentReferenceSchema);
export const agentItemSchema = union(
  object({ kind: literal("page"), pageKey: id, data: agentDataSchema }),
  object({ kind: literal("message"), pageKey: id, threadId: id, messageId: id, messageVersion: version,
    intent: intentSchema, target: agentDataSchema, body: agentTextSchema, contextCommand: text() }),
  object({ kind: literal("edit"), pageKey: id, editId: id, editVersion: version,
    editKind: enumeration(["edited", "deleted", "moved"]), label: agentTextSchema,
    source: agentDataSchema, assets: agentDataSchema,
    captureTruncated: booleanValue, truncatedFields: array(text()), content: agentDataSchema }),
  object({ kind: literal("response"), threadId: id, messageId: id, replyToMessageId: id,
    outcome: messageOutcomeSchema, body: agentTextSchema }),
  object({ kind: literal("edit-outcome"), editId: id, editVersion: version, outcome: editOutcomeSchema, reason: agentTextSchema }),
);
const pageFields = { totalCount: integer(), returnedCount: integer(), complete: booleanValue, nextCursor: nullable(text()) };
export const agentInventorySchema = refine(object({ ...pageFields, items: array(agentItemSchema) }), (page) => {
  if (page.returnedCount !== page.items.length || page.totalCount < page.returnedCount ||
      page.complete !== (page.nextCursor === null)) reject("INVALID_INPUT", "Invalid inventory counts.");
});
const lifecycle = {
  submissionId: id, version, state: enumeration(["queued", "delivered", "handled", "abandoned"]),
  createdAt: timestamp, deliveredAt: nullable(timestamp), completedAt: nullable(timestamp),
  abandonment: nullable(agentDataSchema),
};
const note = object({ intent: intentSchema, body: agentTextSchema });
const result = object({
  resultId: id, title: enumeration(["What changed", "Agent response"]),
  effect: enumeration(["reply-only", "changes-reported"]), body: agentTextSchema, summary: optional(agentTextSchema),
  overallOutcome: optional(messageOutcomeSchema),
});
export const agentSubmissionSchema = object({
  ...submissionScope, version, state: lifecycle.state,
  createdAt: timestamp, deliveredAt: nullable(timestamp), completedAt: nullable(timestamp),
  abandonment: nullable(agentDataSchema), overallNote: optional(note), result: nullable(result),
  receipt: nullable(agentDataSchema), inventory: agentInventorySchema, handoff: agentHandoffSchema,
});
export const agentOpenSchema = refine(object({
  ok: literal(true), receipt: handlingReceiptSchema, review: reviewSchema, url: text(), handoff: agentHandoffSchema,
}), ({ receipt, review }) => {
  if (receipt.operation !== "open" || receipt.reviewId !== review.reviewId || receipt.entryKey !== review.entryKey) {
    reject("SCOPE_MISMATCH", "Open receipt and review disagree.");
  }
});
export const agentPollSchema = union(
  refine(object({ state: literal("work"), review: reviewSchema, submission: agentSubmissionSchema }), ({ review, submission }) => {
    if (submission.state !== "delivered" || submission.reviewId !== review.reviewId || submission.entryKey !== review.entryKey) {
      reject("SCOPE_MISMATCH", "Work is not delivered in this exact review.");
    }
  }),
  object({ state: literal("ended"), review: refine(reviewSchema, (review) => {
    if (review.state !== "ended") reject("INVALID_INPUT", "Only ended reviews stop polling.");
  }), handoff: agentHandoffSchema }),
  object({ state: literal("timeout"), reviewId: id, entryKey: id, handoff: agentHandoffSchema }),
);
export const agentHistorySchema = object({
  reviewId: id, entryKey: id, before: nullable(id), ...pageFields,
  items: array(object({ ...lifecycle, overallNote: optional(note), result: nullable(result), command: text() })),
});
export const agentContextSchema = object({
  ...submissionScope, threadId: id, ...pageFields,
  items: array(object({
    submissionId: id, state: lifecycle.state, deliveredAt: nullable(timestamp), completedAt: nullable(timestamp),
    messageId: id, messageVersion: version, intent: intentSchema, body: agentTextSchema,
    response: nullable(object({ outcome: messageOutcomeSchema, body: agentTextSchema })),
  })),
});
export const agentContentSchema = object({
  identity, encoding: enumeration(["utf8", "json"]), ...integrity,
  offset: integer(), returnedBytes: integer(), complete: booleanValue, nextCursor: nullable(text()), text: text(Infinity, false),
});
export const agentStatusSchema = object({
  source: enumeration(["server", "disk"]), review: reviewSchema,
  openThreadCount: integer(), attentionEditCount: integer(),
  pendingMessageCount: integer(), pendingEditCount: integer(),
  work: nullable(object({ submissionId: id, state: enumeration(["queued", "delivered"]), version })),
  blockers: object({ ...pageFields, items: array(jsonSchema) }),
  latestSubmission: nullable(object({ ...lifecycle, result: nullable(result) })),
  handoff: agentHandoffSchema,
});
export const agentReadResponseSchema = union(
  object({ operation: literal("submission"), value: agentSubmissionSchema }),
  object({ operation: literal("context"), value: agentContextSchema }),
  object({ operation: literal("history"), value: agentHistorySchema }),
  object({ operation: literal("content"), value: agentContentSchema }),
  object({ operation: literal("response-template"), value: agentContentSchema }),
  object({ operation: literal("status"), value: agentStatusSchema }),
);
