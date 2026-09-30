export function conversationFixture() {
  const review = { reviewId: "review-1", entryKey: "entry", version: 7, state: "open", createdAt: 100, endedAt: null };
  const target = { kind: "selection", anchor: { quote: "Original wording", prefix: "", suffix: " context" } };
  const thread = {
    threadId: "thread-1", reviewId: review.reviewId, pageKey: "page", version: 1, sequence: 1,
    target, status: "open", createdAt: 101, updatedAt: 101,
  };
  const message = {
    messageId: "message-1", reviewId: review.reviewId, threadId: thread.threadId,
    version: 1, sequence: 2, createdAt: 102, updatedAt: 102,
    author: "reviewer", body: "Why this wording?", intent: "discuss", submissionId: null,
  };
  const edit = {
    editId: "edit-1", reviewId: review.reviewId, pageKey: "page", version: 1, sequence: 3,
    author: "reviewer", createdAt: 103, updatedAt: 103,
    content: {
      label: "Paragraph", kind: "edited", before: "Before", after: "After",
      before_html: "<p><b>Before</b></p>", after_html: '<p>After<img src="/asset/image"></p>',
      truncated: false, truncated_fields: [], staged_assets: [{ id: "image", preview_src: "/asset/image" }],
    },
    source: { state: "pending" },
    assets: [{ id: "image", path: "C:\\isolated-fixture\\image.png", preview_src: "/asset/image" }],
  };
  const base = { reviewId: review.reviewId, entryKey: review.entryKey, requestId: "request-1", expectedVersion: review.version };
  const send = {
    ...base, operation: "send", pageKeys: ["page"],
    messages: [{ threadId: thread.threadId, messageId: message.messageId, version: message.version }],
    edits: [{ pageKey: edit.pageKey, editId: edit.editId, version: edit.version }],
  };
  const submission = {
    submissionId: "submission-1", reviewId: review.reviewId, entryKey: review.entryKey, version: 2, sequence: 4,
    state: "delivered", createdAt: 104, deliveredAt: 105, completedAt: null,
    pageKeys: ["page"], exclusionKeys: ["entry", "page"],
    messages: [{ pageKey: "page", target, message: { ...message, submissionId: "submission-1" } }],
    edits: [structuredClone(edit)], resultId: null, abandonment: null,
  };
  const response = {
    ...base, operation: "respond", requestId: "response-1", expectedVersion: submission.version,
    submissionId: submission.submissionId,
    responses: [{ threadId: thread.threadId, messageId: message.messageId, messageVersion: message.version,
      body: "The wording preserves the original meaning.", outcome: "answered" }],
    editOutcomes: [{ editId: edit.editId, editVersion: edit.version, outcome: "applied", reason: "Copied the exact paragraph and asset to source." }],
    resultNote: "Updated the paragraph and preserved its image.",
  };
  const reply = {
    messageId: "reply-1", reviewId: review.reviewId, threadId: thread.threadId, version: 1, sequence: 5,
    createdAt: 106, updatedAt: 106, author: "agent", submissionId: submission.submissionId,
    replyToMessageId: message.messageId, body: response.responses[0].body, outcome: "answered",
  };
  const result = {
    resultId: "result-1", reviewId: review.reviewId, submissionId: submission.submissionId, sequence: 6,
    createdAt: 106, author: "agent", body: response.resultNote, title: "What changed", effect: "changes-reported",
    responses: [reply], editOutcomes: structuredClone(response.editOutcomes),
  };
  const receipt = {
    receiptId: "receipt-1", requestId: response.requestId, reviewId: review.reviewId, entryKey: review.entryKey,
    operation: "respond", acceptedAt: 106,
    value: { reviewVersion: 8, submissionId: submission.submissionId, resultId: result.resultId },
  };
  const scope = { authenticated: true, review, pageKeys: ["entry", "page", "other-page"] };
  const items = {
    threads: [thread], messages: [message], edits: [edit],
    sources: [{ reviewId: review.reviewId, pageKey: "page", sourceHash: "current-source", writable: true,
      revert: { baselineRevisionId: "baseline-1", sourceHash: "current-source" } }],
  };
  const pagingScope = {
    reviewId: review.reviewId, entryKey: review.entryKey, collection: "threads",
    pageKey: null, threadId: null, submissionId: null, status: "open",
  };
  const abandon = {
    ...base, operation: "abandon", requestId: "abandon-1", expectedVersion: submission.version,
    submissionId: submission.submissionId, confirmExternalWorkMayContinue: true, reason: "Stopped waiting; source work may continue.",
  };
  const savedEdit = structuredClone(edit);
  savedEdit.source = {
    state: "saved",
    evidence: { evidenceId: "save-1", reviewId: review.reviewId, pageKey: edit.pageKey,
      editId: edit.editId, editVersion: edit.version, sourceHash: "current-source", savedAt: 103 },
  };
  return { review, target, thread, message, edit, savedEdit, base, send, submission, response, reply, result, receipt, scope, items, pagingScope, abandon };
}
