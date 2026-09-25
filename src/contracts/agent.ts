import { handlingReceiptSchema, submissionSchema } from "./feedback.js";
import { canonicalPageSchema, reviewSchema, reviewStatusSchema } from "./page-boundary.js";
import { submissionHistoryItemSchema } from "./history.js";
import { array, enumeration, id, literal, nullable, object, refine, reject, text, union, unique } from "./validation.js";

export const agentReferenceSchema = object({ reviewId: id, entryKey: id });
export const agentHandoffSchema = object({
  pollCommand: text(), statusCommand: text(), responseCommand: text(),
  contextCommands: array(object({ threadId: id, command: text() })), instructions: text(),
});
export const agentOpenSchema = refine(object({
  ok: literal(true), receipt: handlingReceiptSchema, review: reviewSchema, url: text(), handoff: agentHandoffSchema,
}), ({ receipt, review }) => {
  if (receipt.operation !== "open" || receipt.reviewId !== review.reviewId || receipt.entryKey !== review.entryKey) {
    reject("SCOPE_MISMATCH", "Open receipt and durable review disagree.");
  }
});
export const agentPollSchema = union(
  refine(object({
    state: literal("work"), review: reviewSchema, submission: submissionSchema,
    pages: array(canonicalPageSchema), handoff: agentHandoffSchema,
  }), ({ review, submission, pages, handoff }) => {
    if (submission.state !== "delivered" || submission.reviewId !== review.reviewId || submission.entryKey !== review.entryKey) {
      reject("SCOPE_MISMATCH", "Work is outside the requested review.");
    }
    unique(pages.map((page) => page.pageKey));
    if (pages.length !== submission.pageKeys.length || pages.some((page) => !submission.pageKeys.includes(page.pageKey))) {
      reject("SCOPE_MISMATCH", "Handoff must identify every submitted page.");
    }
    unique(handoff.contextCommands.map((item) => item.threadId));
    const threads = new Set(submission.messages.map((item) => item.message.threadId));
    if (threads.size !== handoff.contextCommands.length || handoff.contextCommands.some((item) => !threads.has(item.threadId))) {
      reject("SCOPE_MISMATCH", "Context commands must address the submitted threads.");
    }
  }),
  object({ state: literal("ended"), review: refine(reviewSchema, (review) => {
    if (review.state !== "ended") reject("INVALID_INPUT", "Only ended reviews stop polling.");
  }), handoff: agentHandoffSchema }),
  object({ state: literal("timeout"), reviewId: id, entryKey: id, handoff: agentHandoffSchema }),
);
export const agentStatusSchema = refine(object({
  source: enumeration(["server", "disk"]), status: reviewStatusSchema,
  latestSubmission: nullable(submissionHistoryItemSchema),
}), ({ status, latestSubmission }) => {
  if (latestSubmission && latestSubmission.reviewId !== status.review.reviewId) {
    reject("SCOPE_MISMATCH", "Status history belongs to another review.");
  }
});
