import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  acceptedMutationSchema, abandonRequestSchema, agentMessageSchema, conversationThreadSchema,
  directEditSchema, directEditContentSchema, exactReplay, exclusionKeys, handlingReceiptSchema, reviewerMessageSchema,
  reviewerMutationSchema, completeResponseSchema, resultTitle, responseEffect, submissionReadSchema,
  submissionSchema, submissionResultSchema, validateAbandonment, validateResponseCommit, validateResponseCoverage,
  assertNoOutstandingWork,
} from "./contracts/feedback.js";
import {
  assertReviewScope, openReviewRequestSchema, pollResponseSchema, reviewPageSchema, reviewReadRequestSchema,
  reviewSchema, reviewStatusSchema, validateReviewerMutation,
} from "./contracts/page-boundary.js";
import {
  comparisonReferenceSchema, contextWindow, conversationListRequestSchema, latestExchange,
  paginate, submissionHistoryItemSchema, threadSummarySchema, validatePageOutput,
} from "./contracts/history.js";
import { canonicalJson, reject, object, id, integer, nullable, timestamp, optional } from "./contracts/validation.js";
import { compareCapturedViews } from "./view-identity.js";
import { canonicalTarget, targetKey } from "./paths.js";
import { atomicWrite } from "./atomic-write.js";
import { editIncluded, proveSave, readSource, resolveEditAssets, sourceHash, sourceEditContent } from "./conversation-save.js";

const uid = (prefix) => `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
const own = (record, key) => Object.hasOwn(record, key) ? record[key] : undefined;
const values = (record) => Object.values(record);
const outstanding = (submission) => ["queued", "delivered"].includes(submission.state);
const seq = (record) => ++record.sequence;
export const emptyConversations = () => ({ reviews: {}, requests: {}, writes: {} });
function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("Unsupported or corrupt conversation state shape.");
  }
}

function recordFor(data, reference) {
  const record = own(data.conversations.reviews, reference.reviewId);
  if (!record) reject("NOT_FOUND", "Unknown durable review.");
  assertReviewScope(scopeFor(record), reference);
  return record;
}
const scopeFor = (record) => ({ authenticated: true, review: record.review, pageKeys: Object.keys(record.pages) });
const allSubmissions = (data) => values(data.conversations.reviews).flatMap((record) => values(record.submissions));
const submittedEdit = (record, edit) => values(record.submissions).some((submission) =>
  submission.edits.some((item) => item.editId === edit.editId && item.version === edit.version));
function entity(record, collection, id) {
  const result = own(record[collection], id);
  if (!result) reject("NOT_FOUND", `Unknown ${collection} identity in this review.`);
  return result;
}
function sourceItems(data, record) {
  return values(record.pages).map((membership) => {
    const source = readSource(data.pages[membership.pageKey]);
    const write = own(data.conversations.writes, membership.pageKey);
    return {
      reviewId: record.review.reviewId, pageKey: membership.pageKey, sourceHash: source.hash,
      writable: source.writable,
      revert: write?.reviewId === record.review.reviewId && write.hash === source.hash
        ? { baselineRevisionId: membership.baselineRevisionId, sourceHash: write.hash } : null,
    };
  });
}
function itemsFor(data, record) {
  return {
    threads: values(record.threads), messages: values(record.messages).filter((message) => message.author === "reviewer"),
    edits: values(record.edits), sources: sourceItems(data, record),
  };
}
function receiptFor(request, record, value) {
  return handlingReceiptSchema.parse({
    receiptId: uid("receipt"), requestId: request.requestId,
    reviewId: record.review.reviewId, entryKey: record.review.entryKey,
    operation: request.operation, acceptedAt: Date.now(),
    value: { reviewVersion: record.review.version, ...value },
  });
}
function requestKey(request, openEntryKey) {
  return canonicalJson(request.operation === "open"
    ? ["open", openEntryKey, request.requestId]
    : ["review", request.reviewId, request.requestId]);
}
function remember(data, request, receipt) {
  Object.defineProperty(data.conversations.requests, requestKey(request, receipt.entryKey), {
    value: { canonicalPayload: canonicalJson(request), receipt }, enumerable: true, configurable: true, writable: true,
  });
  return acceptedMutationSchema.parse({ ok: true, receipt });
}
function snapshot(store, page, source, reason) {
  if (source.text === null) return null;
  return store.revisions.put({
    documentId: page.key, reason,
    source: { text: source.text, mediaType: "text/plain", provenance: { pageKey: page.key, sourceHash: source.hash } },
  }).revisionId;
}
function resolveReviewTarget(target) {
  try { return canonicalTarget(target); }
  catch (error) {
    if (error instanceof Error && !error.code) reject("INVALID_INPUT", error.message);
    throw error;
  }
}
function joinPage(store, data, record, targetText) {
  const target = resolveReviewTarget(targetText);
  const key = targetKey(target.value);
  if (own(record.pages, key)) return key;
  const page = own(data.pages, key) || {
    key, kind: target.kind, ...(target.kind === "url" ? { url: target.value } : { file: target.value }),
    pristine: "", comments: [], edits: [], updatedAt: Date.now(),
  };
  const source = readSource(page);
  if (target.kind === "file" && source.text === null) reject("NOT_FOUND", "Source is missing or unreadable.");
  const baselineRevisionId = snapshot(store, page, source, "review-open");
  data.pages[key] = page;
  record.pages[key] = { pageKey: key, sequence: seq(record), joinedAt: Date.now(), baselineRevisionId };
  return key;
}

/** Strictly validate the new durable store, never repair/import obsolete records. */
export function validateConversations(data) {
  exactKeys(data, ["schemaVersion", "conversations", "pages", "batches", "receipts", "histories"]);
  const c = data.conversations;
  exactKeys(c, ["reviews", "requests", "writes"]);
  if (data.schemaVersion !== 1 || !c || !c.reviews || !c.requests || !c.writes) throw new Error("Unsupported or corrupt conversation state.");
  for (const map of [data.pages, data.batches, data.receipts, data.histories, c.reviews, c.requests, c.writes]) {
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("Corrupt conversation state map.");
  }
  const open = new Set();
  const receiptResults = new Map();
  for (const [key, request] of Object.entries(c.requests)) {
    exactKeys(request, ["canonicalPayload", "receipt"]);
    handlingReceiptSchema.parse(request.receipt);
    const payload = JSON.parse(request.canonicalPayload);
    (payload.operation === "open" ? openReviewRequestSchema : payload.operation === "respond" ? completeResponseSchema :
      payload.operation === "abandon" ? abandonRequestSchema : reviewerMutationSchema).parse(payload);
    if (key !== requestKey(payload, request.receipt.entryKey) ||
        own(c.reviews, request.receipt.reviewId)?.review.entryKey !== request.receipt.entryKey ||
        !exactReplay(payload, request)) throw new Error("Corrupt receipt scope.");
    if (request.receipt.value.resultId) {
      const resultKey = canonicalJson([request.receipt.reviewId, request.receipt.value.resultId]);
      if (receiptResults.has(resultKey)) throw new Error("Duplicate handling receipt.");
      receiptResults.set(resultKey, request);
    }
  }
  for (const [reviewId, record] of Object.entries(c.reviews)) {
    exactKeys(record, ["review", "sequence", "pages", "threads", "messages", "edits", "editBases", "submissions", "results", "comparisons"]);
    reviewSchema.parse(record.review);
    if (reviewId !== record.review.reviewId || !Number.isSafeInteger(record.sequence) || record.sequence < 1) throw new Error("Corrupt review identity/sequence.");
    if (record.review.state === "open") {
      if (open.has(record.review.entryKey)) throw new Error("Multiple open reviews for one entry.");
      open.add(record.review.entryKey);
    }
    for (const name of ["pages", "threads", "messages", "edits", "editBases", "submissions", "results", "comparisons"]) {
      if (!record[name] || typeof record[name] !== "object" || Array.isArray(record[name])) throw new Error(`Corrupt review ${name}.`);
    }
    if (!own(record.pages, record.review.entryKey)) throw new Error("Review has no entry membership.");
    const sequences = new Set();
    const checkSequence = (item) => {
      if (!Number.isSafeInteger(item.sequence) || item.sequence < 1 || item.sequence > record.sequence || sequences.has(item.sequence)) {
        throw new Error("Corrupt or duplicate review sequence.");
      }
      sequences.add(item.sequence);
    };
    for (const [key, membership] of Object.entries(record.pages)) {
      object({ pageKey: id, sequence: integer(1), joinedAt: timestamp, baselineRevisionId: nullable(id),
        observation: optional(object({ revisionId: id, sessionId: id, renderId: id, generation: integer(1) })),
      }).parse(membership);
      checkSequence(membership);
      if (membership.pageKey !== key || !own(data.pages, key) || !Number.isSafeInteger(membership.sequence) ||
          membership.sequence < 1 || membership.sequence > record.sequence) throw new Error("Corrupt page membership.");
    }
    for (const [name, schema, idField] of [
      ["threads", conversationThreadSchema, "threadId"], ["edits", directEditSchema, "editId"],
      ["submissions", submissionSchema, "submissionId"], ["results", submissionResultSchema, "resultId"],
      ["comparisons", comparisonReferenceSchema, "sequence"],
    ]) for (const [key, item] of Object.entries(record[name])) {
      schema.parse(item);
      checkSequence(item);
      if (String(item[idField]) !== key || item.reviewId !== reviewId || item.sequence > record.sequence ||
          (item.pageKey && !own(record.pages, item.pageKey))) throw new Error(`Corrupt ${name} scope.`);
    }
    for (const [key, message] of Object.entries(record.messages)) {
      (message.author === "reviewer" ? reviewerMessageSchema : agentMessageSchema).parse(message);
      checkSequence(message);
      if (key !== message.messageId || message.reviewId !== reviewId || !own(record.threads, message.threadId) ||
          message.sequence > record.sequence) throw new Error("Corrupt message scope.");
    }
    for (const [editId, base] of Object.entries(record.editBases)) {
      entity(record, "edits", editId);
      object({ sourceHash: nullable(id), priorContent: nullable(directEditContentSchema) }).parse(base);
    }
    for (const edit of values(record.edits)) entity(record, "editBases", edit.editId);
    for (const submission of values(record.submissions)) {
      const lifecycleVersion = 1 + Number(submission.deliveredAt !== null) + Number(submission.completedAt !== null);
      if (submission.version !== lifecycleVersion) throw new Error("Corrupt submission lifecycle version.");
      if (submission.entryKey !== record.review.entryKey || submission.pageKeys.some((key) => !own(record.pages, key))) {
        throw new Error("Corrupt submission membership.");
      }
      for (const item of submission.messages) {
        const message = entity(record, "messages", item.message.messageId);
        const thread = entity(record, "threads", message.threadId);
        if (canonicalJson(message) !== canonicalJson(item.message) || thread.pageKey !== item.pageKey ||
            canonicalJson(thread.target) !== canonicalJson(item.target)) throw new Error("Corrupt immutable submitted message.");
      }
      for (const edit of submission.edits) {
        if (canonicalJson(entity(record, "edits", edit.editId)) !== canonicalJson(edit)) throw new Error("Corrupt immutable submitted edit.");
      }
      const result = submission.resultId ? entity(record, "results", submission.resultId) : null;
      const responseRecord = result ? receiptResults.get(canonicalJson([reviewId, result.resultId])) : null;
      const receipt = responseRecord?.receipt ?? null;
      submissionReadSchema.parse({ submission, result, receipt });
      if (responseRecord) validateResponseCommit({
        ...submission, version: submission.version - 1, state: "delivered", completedAt: null, resultId: null,
      }, JSON.parse(responseRecord.canonicalPayload), result, receipt);
    }
    for (const result of values(record.results)) {
      if (entity(record, "submissions", result.submissionId).resultId !== result.resultId) throw new Error("Orphan result.");
      for (const reply of result.responses) {
        if (canonicalJson(entity(record, "messages", reply.messageId)) !== canonicalJson(reply)) throw new Error("Corrupt persisted inline reply.");
      }
    }
    for (const message of values(record.messages)) {
      if (message.submissionId !== null) entity(record, "submissions", message.submissionId);
    }
    for (const comparison of values(record.comparisons)) {
      if (!entity(record, "submissions", comparison.submissionId).pageKeys.includes(comparison.pageKey)) throw new Error("Orphan comparison.");
    }
  }
  for (const [pageKey, write] of Object.entries(c.writes)) {
    object({ reviewId: id, hash: id }).parse(write);
    const record = own(c.reviews, write.reviewId);
    if (!record || !own(record.pages, pageKey)) throw new Error("Corrupt write ownership.");
  }
  const held = new Set();
  for (const submission of allSubmissions(data).filter(outstanding)) {
    for (const key of submission.exclusionKeys) {
      if (held.has(key)) throw new Error("Corrupt overlapping outstanding submissions.");
      held.add(key);
    }
  }
  return data;
}

export class Conversations {
  constructor(store, { writeSource = atomicWrite } = {}) {
    this.store = store;
    this.writeSource = writeSource;
    this.observationIsCurrent = () => false;
  }

  execute(input) {
    if (input?.operation === "open") return this.open(input);
    if (input?.operation === "list") return this.list(input);
    if (["read-review", "read-page", "status", "poll", "submission", "receipt", "open-receipt"].includes(input?.operation)) return this.read(input);
    return this.mutate(input);
  }

  open(input) {
    const request = openReviewRequestSchema.parse(input);
    const entryKey = targetKey(resolveReviewTarget(request.target).value);
    const replay = exactReplay(request, own(this.store.data.conversations.requests, requestKey(request, entryKey)));
    if (replay) return { ok: true, receipt: structuredClone(replay) };
    return this.store.transaction((data) => {
      let record = values(data.conversations.reviews).find((item) => item.review.entryKey === entryKey && item.review.state === "open");
      if (!record) {
        const reviewId = uid("review");
        record = {
          review: { reviewId, entryKey, version: 1, state: "open", createdAt: Date.now(), endedAt: null },
          sequence: 0, pages: {}, threads: {}, messages: {}, edits: {}, editBases: {}, submissions: {}, results: {}, comparisons: {},
        };
        joinPage(this.store, data, record, request.target);
        data.conversations.reviews[reviewId] = record;
      }
      return remember(data, request, receiptFor(request, record, {}));
    });
  }

  mutate(input) {
    const request = (input?.operation === "respond" ? completeResponseSchema :
      input?.operation === "abandon" ? abandonRequestSchema : reviewerMutationSchema).parse(input);
    recordFor(this.store.data, request);
    const replay = exactReplay(request, own(this.store.data.conversations.requests, requestKey(request)));
    if (replay) return { ok: true, receipt: structuredClone(replay) };
    return this.store.transaction((data) => {
      const record = recordFor(data, request);
      if (request.operation === "respond") return this.respond(data, record, request);
      if (request.operation === "abandon") {
        const submission = entity(record, "submissions", request.submissionId);
        validateAbandonment(request, submission);
        submission.state = "abandoned";
        submission.version++;
        submission.completedAt = Date.now();
        submission.abandonment = { requestId: request.requestId, at: submission.completedAt, reason: request.reason };
        record.review.version++;
        return remember(data, request, receiptFor(request, record, { submissionId: submission.submissionId }));
      }
      validateReviewerMutation(request, scopeFor(record), itemsFor(data, record), allSubmissions(data));
      const now = Date.now();
      let value = {};
      const addMessage = (threadId) => {
        const messageId = uid("message");
        record.messages[messageId] = reviewerMessageSchema.parse({
          messageId, reviewId: request.reviewId, threadId, version: 1, sequence: seq(record),
          createdAt: now, updatedAt: now, body: request.body, author: "reviewer",
          intent: request.intent, submissionId: null,
        });
        return messageId;
      };
      switch (request.operation) {
        case "join-page":
          value = { pageKey: joinPage(this.store, data, record, request.target) };
          break;
        case "create-thread": {
          const threadId = uid("thread");
          record.threads[threadId] = conversationThreadSchema.parse({
            threadId, reviewId: request.reviewId, pageKey: request.pageKey, version: 1, sequence: seq(record),
            target: request.target, status: "open", createdAt: now, updatedAt: now,
          });
          value = { threadId, messageId: addMessage(threadId) };
          break;
        }
        case "reply":
          value = { threadId: request.threadId, messageId: addMessage(request.threadId) };
          record.threads[request.threadId].updatedAt = now;
          record.threads[request.threadId].version++;
          break;
        case "update-message": {
          const message = record.messages[request.messageId];
          Object.assign(message, { body: request.body, intent: request.intent, version: message.version + 1, updatedAt: now });
          value = { threadId: request.threadId, messageId: request.messageId };
          break;
        }
        case "set-thread-status":
          Object.assign(record.threads[request.threadId], {
            status: request.status, updatedAt: now, version: record.threads[request.threadId].version + 1,
          });
          value = { threadId: request.threadId };
          break;
        case "delete-thread":
          for (const message of values(record.messages)) if (message.threadId === request.threadId) delete record.messages[message.messageId];
          delete record.threads[request.threadId];
          value = { threadId: request.threadId };
          break;
        case "record-edit": {
          const editId = request.editId || uid("edit");
          const previous = own(record.edits, editId);
          const source = readSource(data.pages[request.pageKey]);
          record.editBases[editId] = {
            sourceHash: source.hash,
            priorContent: previous?.source.state === "saved" && previous.source.evidence.sourceHash === source.hash
              ? sourceEditContent(previous) : record.editBases[editId]?.priorContent ?? null,
          };
          record.edits[editId] = directEditSchema.parse({
            editId, reviewId: request.reviewId, pageKey: request.pageKey, version: (previous?.version || 0) + 1,
            sequence: previous?.sequence || seq(record), author: "reviewer",
            createdAt: previous?.createdAt || now, updatedAt: now,
            content: request.content, source: { state: "pending" }, assets: resolveEditAssets(request.pageKey, request.content),
          });
          value = { editId };
          break;
        }
        case "save-edit":
          this.saveEdit(data, record, request);
          value = { editId: request.editId };
          break;
        case "revert":
          this.revert(data, record, request);
          break;
        case "send":
          value = { submissionId: this.send(data, record, request) };
          break;
        case "end":
          record.review.state = "ended";
          record.review.endedAt = now;
          break;
      }
      record.review.version++;
      return remember(data, request, receiptFor(request, record, value));
    });
  }

  saveEdit(data, record, request) {
    const page = data.pages[request.pageKey];
    const source = readSource(page);
    const edit = record.edits[request.editId];
    const base = record.editBases[edit.editId];
    const previousWrite = own(data.conversations.writes, page.key);
    if (base.sourceHash !== source.hash && !(previousWrite?.reviewId === request.reviewId && previousWrite.hash === source.hash)) {
      reject("SAVE_EVIDENCE_CONFLICT", "Source changed after this edit was recorded; record a new version against current source.");
    }
    let html = request.html;
    const pending = values(record.edits).filter((item) => item.pageKey === page.key && !submittedEdit(record, item) && item.source.state === "pending");
    // A live frame retains preview paths after saving or submitting an edit.
    // Translate only this review/page's server-resolved assets; proveSave still
    // requires every resulting source delta to have an exact pending transition.
    for (const item of values(record.edits).filter((item) => item.pageKey === page.key)) {
      for (const asset of item.assets) html = html.replaceAll(asset.preview_src, `assets/${asset.id}`);
    }
    const included = pending.filter((item) => item.editId === edit.editId || (!item.content.truncated && editIncluded(html, sourceEditContent(item))));
    if (!included.some((item) => item.editId === edit.editId)) reject("SAVE_EVIDENCE_CONFLICT", "Save requires a pending recorded transition.");
    for (const item of included) {
      const itemBase = record.editBases[item.editId];
      if (itemBase.sourceHash !== source.hash && !(previousWrite?.reviewId === request.reviewId && previousWrite.hash === source.hash)) {
        reject("SAVE_EVIDENCE_CONFLICT", "An included edit was recorded against a different source.");
      }
    }
    proveSave(source.text, html, included.sort((a, b) => a.sequence - b.sequence).map((item) => ({
      content: sourceEditContent(item), priorContent: record.editBases[item.editId].priorContent,
    })));
    // No source writes occur until all state/evidence checks and snapshots succeeded.
    const nextHash = sourceHash(html);
    const membership = record.pages[page.key];
    const baselineHash = membership.baselineRevisionId
      ? this.store.revisions.get(membership.baselineRevisionId)?.source?.provenance?.sourceHash : null;
    if (previousWrite ? previousWrite.reviewId !== request.reviewId || previousWrite.hash !== source.hash : baselineHash !== source.hash) {
      record.pages[page.key].baselineRevisionId = snapshot(this.store, page, source, "review-write-baseline");
    }
    for (const other of values(record.edits)) {
      if (other.pageKey !== page.key || submittedEdit(record, other)) continue;
      const eligible = included.some((item) => item.editId === other.editId) ||
        (other.source.state === "saved" && other.source.evidence.sourceHash === source.hash);
      if (!eligible) continue;
      other.source = editIncluded(html, sourceEditContent(other)) ? {
        state: "saved", evidence: {
          evidenceId: uid("save"), reviewId: request.reviewId, pageKey: page.key,
          editId: other.editId, editVersion: other.version, sourceHash: nextHash, savedAt: Date.now(),
        },
      } : { state: "pending" };
    }
    if (edit.source.state !== "saved") reject("SAVE_EVIDENCE_CONFLICT", "Exact recorded edit is not present in saved output.");
    for (const asset of included.flatMap((item) => item.assets)) {
      const destination = path.join(path.dirname(page.file), "assets", asset.id);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const bytes = fs.readFileSync(asset.path);
      if (fs.existsSync(destination)) {
        if (!fs.readFileSync(destination).equals(bytes)) reject("SAVE_EVIDENCE_CONFLICT", "Destination asset differs; no overwrite was authorized.");
      } else fs.writeFileSync(destination, bytes, { flag: "wx" });
    }
    data.conversations.writes[page.key] = { reviewId: request.reviewId, hash: nextHash };
    this.writeSource(page.file, html);
  }

  revert(data, record, request) {
    const page = data.pages[request.pageKey];
    this.store.revisions.verify(request.baselineRevisionId, page.key);
    const baseline = this.store.revisions.readSource(request.baselineRevisionId);
    if (baseline === null) reject("SAVE_EVIDENCE_CONFLICT", "Revert has no source baseline.");
    for (const edit of values(record.edits)) {
      if (edit.pageKey === page.key && !submittedEdit(record, edit)) {
        // Keep exact human records, but do not claim their reverted content is saved.
        edit.source = { state: "pending" };
      }
    }
    delete data.conversations.writes[page.key];
    this.writeSource(page.file, baseline);
  }

  send(data, record, request) {
    const submissionId = uid("submission");
    const messages = request.messages.map(({ messageId }) => {
      const message = record.messages[messageId];
      message.submissionId = submissionId;
      const thread = record.threads[message.threadId];
      return { pageKey: thread.pageKey, target: thread.target, message: structuredClone(message) };
    });
    const edits = request.edits.map(({ editId }) => structuredClone(record.edits[editId]));
    record.submissions[submissionId] = submissionSchema.parse({
      submissionId, reviewId: request.reviewId, entryKey: request.entryKey, version: 1, sequence: seq(record),
      state: "queued", createdAt: Date.now(), deliveredAt: null, completedAt: null,
      pageKeys: request.pageKeys, exclusionKeys: exclusionKeys(request.entryKey, request.pageKeys),
      messages, edits, ...(request.overallNote ? { overallNote: request.overallNote } : {}),
      resultId: null, abandonment: null,
    });
    for (const key of request.pageKeys) {
      const page = data.pages[key];
      const source = readSource(page);
      const observation = record.pages[key].observation;
      const observed = observation && this.observationIsCurrent(record.review, key, observation)
        ? this.store.revisions.get(observation.revisionId) : null;
      const baselineRevisionId = observed && (page.kind === "url" || observed.source?.provenance?.sourceHash === source.hash)
        ? observed.revisionId : snapshot(this.store, page, source, "submission-send");
      const sequence = seq(record);
      record.comparisons[sequence] = {
        sequence, reviewId: request.reviewId, submissionId, pageKey: key,
        baselineRevisionId,
        resultRevisionId: null, status: "not-requested", reason: null,
      };
    }
    return submissionId;
  }

  respond(data, record, request) {
    const submission = entity(record, "submissions", request.submissionId);
    validateResponseCoverage(request, submission);
    const resultId = uid("result");
    const now = Date.now();
    const responses = request.responses.map((reply) => agentMessageSchema.parse({
      messageId: uid("message"), reviewId: request.reviewId, threadId: reply.threadId,
      version: 1, sequence: seq(record), createdAt: now, updatedAt: now,
      author: "agent", submissionId: submission.submissionId, replyToMessageId: reply.messageId,
      body: reply.body, outcome: reply.outcome,
    }));
    const result = submissionResultSchema.parse({
      resultId, reviewId: request.reviewId, submissionId: submission.submissionId,
      createdAt: now, sequence: seq(record), author: "agent", body: request.resultNote,
      title: resultTitle(request), effect: responseEffect(request), responses,
      editOutcomes: request.editOutcomes,
      ...(request.overallOutcome === undefined ? {} : { overallOutcome: request.overallOutcome }),
    });
    record.review.version++;
    const receipt = receiptFor(request, record, { submissionId: submission.submissionId, resultId });
    validateResponseCommit(submission, request, result, receipt);
    for (const response of responses) record.messages[response.messageId] = response;
    record.results[resultId] = result;
    submission.state = "handled";
    submission.version++;
    submission.resultId = resultId;
    submission.completedAt = now;
    for (const comparison of values(record.comparisons).filter((item) => item.submissionId === submission.submissionId)) {
      if (result.effect !== "changes-reported") continue;
      // Result acceptance is independent of snapshot I/O. Retry capture separately.
      comparison.status = "pending";
    }
    return remember(data, request, receipt);
  }

  captureResults(reference) {
    const record = recordFor(this.store.data, reference);
    for (const comparison of values(record.comparisons).filter((item) => item.status === "pending" && !item.resultRevisionId)) {
      let revisionId = null;
      let reason = null;
      try {
        const page = this.store.data.pages[comparison.pageKey];
        const source = readSource(page);
        revisionId = snapshot(this.store, page, source, "submission-result");
        if (!revisionId) reason = page.kind === "url" ? "Rendered capture unavailable; source is not writable." : "Source unavailable.";
      } catch (error) {
        console.error("[doc-review] result capture failed:", error.message);
        reason = `Source capture failed: ${error.message}`;
      }
      this.store.transaction((data) => {
        const current = recordFor(data, reference).comparisons[comparison.sequence];
        if (current.status !== "pending") return;
        current.resultRevisionId = revisionId;
        current.status = revisionId ? "partial" : "unavailable";
        current.reason = reason || "Source observed after response acceptance; rendered result has not been captured.";
      });
    }
  }

  observe(reference, observation) {
    return this.store.transaction((data) => {
      const record = recordFor(data, reference);
      const membership = entity(record, "pages", reference.pageKey);
      this.store.revisions.verify(observation.revisionId, reference.pageKey);
      if (reference.submissionId === null) {
        if (record.review.state !== "open") reject("REVIEW_ENDED", "Ended review cannot replace a Send baseline.");
        membership.observation = observation;
        return { revisionId: observation.revisionId };
      }
      const submission = entity(record, "submissions", reference.submissionId);
      const result = submission.resultId && record.results[submission.resultId];
      const comparison = values(record.comparisons).find((item) => item.submissionId === reference.submissionId && item.pageKey === reference.pageKey);
      if (!comparison) reject("SCOPE_MISMATCH", "Page is outside this submission.");
      if (submission.state !== "handled" || result.effect !== "changes-reported") {
        reject("INVALID_INPUT", "Only reported source work needs a result capture.");
      }
      const before = comparison.baselineRevisionId && this.store.revisions.get(comparison.baselineRevisionId);
      const previous = comparison.resultRevisionId && this.store.revisions.get(comparison.resultRevisionId);
      if (previous?.semantic) reject("VERSION_CONFLICT", "Rendered result endpoint is already immutable.");
      const current = this.store.revisions.get(observation.revisionId);
      if (previous?.source && current.source?.hash !== previous.source.hash) {
        reject("VERSION_CONFLICT", "Source changed since the accepted response observation; do not attribute this later DOM to that result.");
      }
      if (compareCapturedViews(before?.semantic?.view, current.semantic?.view).status === "mismatch") {
        reject("VERSION_CONFLICT", "Result shows a different rendered view from the Send baseline.");
      }
      if (previous?.source) {
        // Preserve the first source observation even if the DOM was captured later.
        const merged = this.store.revisions.put({
          documentId: reference.pageKey, reason: "submission-result",
          source: {
            text: this.store.revisions.readSource(previous.revisionId), mediaType: previous.source.mediaType,
            capturedAt: previous.source.capturedAt, provenance: previous.source.provenance,
          },
          semantic: {
            snapshot: this.store.revisions.readSemantic(current.revisionId), capturedAt: current.semantic.capturedAt,
            provenance: current.semantic.provenance, ...(current.semantic.view ? { view: current.semantic.view } : {}),
          },
        });
        comparison.resultRevisionId = merged.revisionId;
      } else comparison.resultRevisionId = current.revisionId;
      comparison.status = before?.semantic ? "ready" : "partial";
      comparison.reason = before?.semantic ? null : "The Send baseline has no rendered snapshot.";
      return comparisonReferenceSchema.parse(comparison);
    });
  }

  page(data, record, key) {
    const membership = entity(record, "pages", key);
    const page = data.pages[key];
    const source = readSource(page);
    const work = allSubmissions(data).filter((submission) => outstanding(submission) &&
      submission.exclusionKeys.some((target) => [record.review.entryKey, key].includes(target)));
    const owner = own(data.conversations.writes, key);
    const revert = owner?.reviewId === record.review.reviewId && owner.hash === source.hash && membership.baselineRevisionId
      ? { baselineRevisionId: membership.baselineRevisionId, sourceHash: owner.hash } : null;
    const threads = new Set(values(record.threads).filter((thread) => thread.pageKey === key).map((thread) => thread.threadId));
    return reviewPageSchema.parse({
      reviewId: record.review.reviewId, sequence: membership.sequence, joinedAt: membership.joinedAt,
      page: { pageKey: key, target: page.kind === "url" ? { kind: "url", url: page.url } : { kind: "file", path: page.file }, sourceHash: source.hash },
      savePolicy: source.writable ? "writable" : "feedback-only",
      pendingMessageCount: values(record.messages).filter((message) => threads.has(message.threadId) && message.submissionId === null).length,
      pendingEditCount: values(record.edits).filter((edit) => edit.pageKey === key && !submittedEdit(record, edit)).length,
      writeBlockedBy: work.map(({ reviewId, submissionId }) => ({ reviewId, submissionId })),
      revert, canRevert: record.review.state === "open" && source.writable && !!revert && !work.length,
    });
  }

  read(input) {
    const request = reviewReadRequestSchema.parse(input);
    const data = this.store.data;
    if (request.operation === "open-receipt") {
      const openRequest = { operation: "open", target: request.target, requestId: request.requestId };
      const entryKey = targetKey(resolveReviewTarget(request.target).value);
      const previous = own(data.conversations.requests, requestKey(openRequest, entryKey));
      if (!previous) return { state: "not-found", requestId: request.requestId };
      const receipt = exactReplay(openRequest, previous);
      return { state: "accepted", receipt: structuredClone(receipt) };
    }
    const record = recordFor(data, request);
    switch (request.operation) {
      case "read-review": return structuredClone(record.review);
      case "read-page": return this.page(data, record, request.pageKey);
      case "receipt": {
        const receipt = own(data.conversations.requests, requestKey(request))?.receipt;
        if (receipt && (receipt.reviewId !== request.reviewId || receipt.entryKey !== request.entryKey)) reject("SCOPE_MISMATCH", "Receipt belongs to another review.");
        return receipt ? { state: "accepted", receipt: structuredClone(receipt) } : { state: "not-found", requestId: request.requestId };
      }
      case "submission": {
        const submission = entity(record, "submissions", request.submissionId);
        const result = submission.resultId ? record.results[submission.resultId] : null;
        const receipt = result ? values(data.conversations.requests).find((item) =>
          item.receipt.reviewId === request.reviewId && item.receipt.value.resultId === result.resultId)?.receipt : null;
        return submissionReadSchema.parse({ submission, result, receipt: receipt ?? null });
      }
      case "status": {
        const work = values(record.submissions).find(outstanding);
        return reviewStatusSchema.parse({
          review: record.review,
          pendingMessageCount: values(record.messages).filter((message) => message.submissionId === null).length,
          pendingEditCount: values(record.edits).filter((edit) => !submittedEdit(record, edit)).length,
          work: work ? { submissionId: work.submissionId, state: work.state, version: work.version } : null,
          blockers: allSubmissions(data).filter((item) => outstanding(item) &&
            item.exclusionKeys.some((key) => key === record.review.entryKey || own(record.pages, key))).map((item) => ({
            reviewId: item.reviewId, submissionId: item.submissionId,
            targetKeys: item.exclusionKeys.filter((key) => key === record.review.entryKey || own(record.pages, key)),
          })),
        });
      }
      case "poll": {
        const work = values(record.submissions).find(outstanding);
        if (!work) return pollResponseSchema.parse({ state: record.review.state === "ended" ? "ended" : "waiting", review: record.review });
        if (work.state === "delivered") return pollResponseSchema.parse({ state: "work", review: record.review, submission: work });
        return this.store.transaction((draft) => {
          const current = recordFor(draft, request);
          const submission = current.submissions[work.submissionId];
          submission.state = "delivered";
          submission.version++;
          submission.deliveredAt = Date.now();
          return pollResponseSchema.parse({ state: "work", review: current.review, submission });
        });
      }
    }
  }

  list(input) {
    const { scope, query } = conversationListRequestSchema.parse(input);
    const data = this.store.data;
    const record = recordFor(data, scope);
    if (scope.pageKey !== null) entity(record, "pages", scope.pageKey);
    const inPage = (item) => scope.pageKey === null || item.pageKey === scope.pageKey;
    let rows;
    let schema;
    switch (scope.collection) {
      case "pages":
        rows = values(record.pages).filter(inPage).map((item) => this.page(data, record, item.pageKey));
        schema = reviewPageSchema;
        break;
      case "edits":
        rows = values(record.edits).filter(inPage).filter((edit) => !submittedEdit(record, edit));
        schema = directEditSchema;
        break;
      case "context": {
        const thread = entity(record, "threads", scope.threadId);
        if (!inPage(thread)) reject("SCOPE_MISMATCH", "Thread belongs to another page.");
        const messages = values(record.messages).filter((item) => item.threadId === scope.threadId);
        return contextWindow(messages.filter((item) => item.author === "reviewer"), messages.filter((item) => item.author === "agent"),
          scope, query, record.sequence);
      }
      case "threads":
        rows = values(record.threads).filter(inPage).filter((thread) => scope.status === "all" || thread.status === scope.status).map((thread) => {
          const messages = values(record.messages).filter((item) => item.threadId === thread.threadId);
          const reviewers = messages.filter((item) => item.author === "reviewer");
          return {
            thread, sequence: thread.sequence, messageCount: reviewers.length,
            pendingMessageCount: reviewers.filter((item) => item.submissionId === null).length,
            latestExchange: latestExchange(reviewers, messages.filter((item) => item.author === "agent")),
          };
        });
        schema = threadSummarySchema;
        break;
      case "history":
        rows = values(record.submissions).filter((submission) => scope.pageKey === null || submission.pageKeys.includes(scope.pageKey)).map((submission) => {
          const result = submission.resultId ? record.results[submission.resultId] : null;
          const comparisons = values(record.comparisons).filter((item) => item.submissionId === submission.submissionId);
          const statuses = comparisons.map((item) => item.status);
          return {
            sequence: submission.sequence, reviewId: scope.reviewId, submissionId: submission.submissionId,
            createdAt: submission.createdAt, state: submission.state,
            result: result ? { resultId: result.resultId, body: result.body, createdAt: result.createdAt, title: result.title, effect: result.effect } : null,
            comparisonStatus: statuses.includes("pending") ? "pending" : statuses.every((status) => status === "ready") ? "ready" :
              statuses.every((status) => status === "not-requested") ? "not-requested" :
                statuses.some((status) => status === "ready" || status === "partial") ? "partial" : "unavailable",
            comparisonCount: comparisons.filter((item) => item.resultRevisionId).length,
          };
        });
        schema = submissionHistoryItemSchema;
        break;
      case "comparisons":
        entity(record, "submissions", scope.submissionId);
        rows = values(record.comparisons).filter(inPage).filter((item) => item.submissionId === scope.submissionId);
        schema = comparisonReferenceSchema;
        break;
    }
    return validatePageOutput(paginate(rows, scope, query, record.sequence), schema, scope, query);
  }

  assertWritableTarget(key) {
    assertNoOutstandingWork([key], allSubmissions(this.store.data));
    if (values(this.store.data.conversations.reviews).some((record) => own(record.pages, key))) {
      reject("SCOPE_MISMATCH", "Conversation pages require review-scoped, versioned write operations.");
    }
  }
}
