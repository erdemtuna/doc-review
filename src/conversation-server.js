import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  contractFailure, ContractError, CONTRACT_LIMITS, reject, object, id, enumeration, integer,
  nullable, optional, timestamp, schema,
} from "./contracts/validation.js";
import { reviewReadRequestSchema } from "./contracts/page-boundary.js";
import { agentStatusSchema } from "./contracts/agent.js";
import { stagedRoot } from "./conversation-save.js";
import { compareRevisions } from "./history-server.js";
import { normalizeSemanticSnapshot } from "./revision-schema.js";
import { normalizeView } from "./view-identity.js";

export async function readConversationBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= CONTRACT_LIMITS.requestBytes) chunks.push(chunk);
  }
  if (size > CONTRACT_LIMITS.requestBytes) reject("INPUT_TOO_LARGE", "Request exceeds 24 MiB UTF-8.");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    reject("MALFORMED_JSON", "Expected a JSON document.");
  }
}

export function conversationFailure(error) {
  if (error instanceof ContractError) return contractFailure(error);
  const known = {
    SNAPSHOT_TOO_LARGE: "SNAPSHOT_TOO_LARGE", INVALID_REVISION: "INVALID_INPUT",
    history_invalid_request: "INVALID_INPUT", history_frame_changed: "VERSION_CONFLICT",
    history_source_changed: "SAVE_EVIDENCE_CONFLICT", history_source_unavailable: "SAVE_EVIDENCE_CONFLICT",
    history_source_too_large: "SNAPSHOT_TOO_LARGE",
  }[error.code];
  if (known) return contractFailure(new ContractError(known, error.message));
  console.error("[doc-review] conversation request failed:", error);
  return contractFailure(new ContractError("INTERNAL_ERROR", error.message));
}

export function createConversationController({ store, sessions, watchPage, json, emit, sourceWritten, currentRender, captureObservation }) {
  store.conversations.observationIsCurrent = (review, key, observation) => {
    const session = sessions.get(observation.sessionId);
    const render = currentRender(observation.renderId);
    return session?.reviewId === review.reviewId && render?.sessionId === session.id && render.pageKey === key &&
      render.generation === observation.generation && render.documentState === "served";
  };
  const attach = (reference) => {
    const review = store.conversations.read({ operation: "read-review", ...reference });
    const record = store.data.conversations.reviews[review.reviewId];
    const sessionId = `s_${crypto.randomBytes(16).toString("hex")}`;
    const session = {
      id: sessionId, reviewId: review.reviewId, entryKey: review.entryKey, activeKey: review.entryKey,
      generation: 0, renderId: null, executionPreferences: new Map(),
      visited: new Set(Object.keys(record.pages)), clients: new Set(), lastSeen: Date.now(),
    };
    sessions.set(sessionId, session);
    for (const key of session.visited) watchPage(key);
    return { sessionId, review, path: `/r/${review.reviewId}` };
  };
  const changed = () => {
    // An overlapping review's permissions may have changed too. Always refetch.
    for (const session of sessions.values()) if (session.reviewId) {
      emit(session, "invalidate", { reviewId: session.reviewId });
    }
  };
  const capture = (reference) => {
    try { store.conversations.captureResults(reference); }
    catch (error) { console.error("[doc-review] result capture state not persisted; restart retries:", error.message); }
  };
  for (const record of Object.values(store.data.conversations.reviews)) capture(record.review);

  async function handle(req, res, url) {
    if (!url.pathname.startsWith("/api/conversation")) return false;
    try {
      if (req.method !== "POST") reject("INVALID_INPUT", "Conversation endpoints require POST.");
      const input = await readConversationBody(req);
      let result;
      if (url.pathname === "/api/conversation") {
        const before = store.data;
        result = store.conversations.execute(input);
        if (before !== store.data && (input.operation === "save-edit" || input.operation === "revert")) sourceWritten(input.pageKey);
        if (input.operation === "respond") capture(input);
        if (input.operation === "respond" && before !== store.data) {
          const submission = store.data.conversations.reviews[input.reviewId].submissions[input.submissionId];
          const result = store.data.conversations.reviews[input.reviewId].results[submission.resultId];
          if (result.effect === "changes-reported") for (const session of sessions.values()) {
            if (session.reviewId === input.reviewId && submission.pageKeys.includes(session.activeKey)) {
              emit(session, "reload", { key: session.activeKey, reason: "submission-result" });
            }
          }
        }
        if (before !== store.data) changed();
      } else if (url.pathname === "/api/conversation/status") {
        const request = reviewReadRequestSchema.parse(input);
        if (request.operation !== "status") reject("INVALID_INPUT", "Status requires a status reference.");
        const status = store.conversations.read(request);
        const history = store.conversations.list({
          operation: "list", scope: {
            reviewId: request.reviewId, entryKey: request.entryKey, collection: "history",
            pageKey: null, threadId: null, submissionId: null, status: "all",
          }, query: { limit: 1 },
        });
        result = agentStatusSchema.parse({ source: "server", status, latestSubmission: history.items[0] ?? null });
      } else if (url.pathname === "/api/conversation/session") {
        const request = reviewReadRequestSchema.parse(input);
        if (request.operation !== "read-review") reject("INVALID_INPUT", "Attach requires a read-review reference.");
        result = attach({ reviewId: request.reviewId, entryKey: request.entryKey });
      } else if (url.pathname === "/api/conversation/capture") {
        const request = object({
          reviewId: id, entryKey: id, pageKey: id, submissionId: nullable(id),
          sessionId: id, renderId: id, generation: integer(1), expectedSourceHash: nullable(id),
          semantic: schema((value) => normalizeSemanticSnapshot(value)),
          semanticCapturedAt: optional(timestamp), view: optional(schema((value) => normalizeView(value))),
        }).parse(input);
        store.conversations.read({ operation: "read-page", reviewId: request.reviewId, entryKey: request.entryKey, pageKey: request.pageKey });
        if (request.submissionId === null && store.conversations.read({
          operation: "read-review", reviewId: request.reviewId, entryKey: request.entryKey,
        }).state !== "open") reject("REVIEW_ENDED", "Ended review cannot replace a Send baseline.");
        const session = sessions.get(request.sessionId);
        if (session?.reviewId !== request.reviewId || session.entryKey !== request.entryKey) reject("SCOPE_MISMATCH", "Capture frame belongs to another review.");
        const saved = captureObservation(session, request.pageKey, request, request.submissionId === null ? "submission-baseline" : "submission-result");
        result = store.conversations.observe(request, {
          revisionId: saved.revisionId, sessionId: session.id, renderId: request.renderId, generation: request.generation,
        });
        changed();
      } else if (url.pathname === "/api/conversation/asset") {
        const request = object({ reviewId: id, entryKey: id, pageKey: id,
          type: enumeration(["image/png", "image/jpeg", "image/gif", "image/webp"]), base64: id }).parse(input);
        const page = store.conversations.read({
          operation: "read-page", reviewId: request.reviewId, entryKey: request.entryKey, pageKey: request.pageKey,
        });
        const review = store.conversations.read({ operation: "read-review", reviewId: request.reviewId, entryKey: request.entryKey });
        if (review.state !== "open") reject("REVIEW_ENDED", "Ended review assets are read-only.");
        if (page.writeBlockedBy.length) reject("WORK_OUTSTANDING", "Target has outstanding work.");
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.base64)) reject("INVALID_INPUT", "Invalid base64 image.");
        const bytes = Buffer.from(request.base64, "base64");
        if (!bytes.length) reject("INVALID_INPUT", "Empty image.");
        const extension = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[request.type];
        const assetId = `paste_${crypto.randomBytes(16).toString("hex")}.${extension}`;
        fs.mkdirSync(stagedRoot(request.pageKey), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(stagedRoot(request.pageKey), assetId), bytes, { flag: "wx", mode: 0o600 });
        result = { id: assetId, preview_src: `__doc_review_paste__/${assetId}` };
      } else if (url.pathname === "/api/conversation/comparison") {
        const request = object({ reviewId: id, entryKey: id, submissionId: id, pageKey: id, mode: enumeration(["source", "content"]) }).parse(input);
        store.conversations.read({ operation: "submission", reviewId: request.reviewId, entryKey: request.entryKey, submissionId: request.submissionId });
        const record = store.data.conversations.reviews[request.reviewId];
        const comparison = Object.values(record.comparisons).find((item) => item.submissionId === request.submissionId && item.pageKey === request.pageKey);
        if (!comparison) reject("SCOPE_MISMATCH", "Page has no comparison in this submission.");
        result = compareRevisions(store.revisions, comparison.baselineRevisionId, comparison.resultRevisionId, request.mode, {
          resultUnavailable: comparison.reason,
        });
      } else reject("NOT_FOUND", "Unknown conversation endpoint.");
      json(res, 200, result);
    } catch (error) {
      const failure = conversationFailure(error);
      json(res, failure.error.status, failure);
    }
    return true;
  }
  return { attach, changed, handle };
}
