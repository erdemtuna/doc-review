import fs from "node:fs";
import crypto from "node:crypto";
import { stripSdk } from "./html-transform.js";
import { isMarkdown } from "./markdown.js";
import { compareSemanticSnapshots, compareSources } from "./revision-diff.js";
import { REVISION_LIMITS } from "./revision-schema.js";
import { normalizeView, compareCapturedViews } from "./view-identity.js";

const SOURCE_LIMIT = REVISION_LIMITS.sourceBytes;
const hash = (value) => crypto.createHash("sha1").update(value).digest("hex");

export class HistoryRequestError extends Error {
  constructor(message, { status = 400, code = "history_invalid_request", targets = [] } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.targets = targets;
  }
}

export function historyErrorStatus(error) {
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 600) return error.status;
  return {
    INVALID_REVISION: 400, SNAPSHOT_TOO_LARGE: 413, CAPTURE_CONFLICT: 409, CAPTURE_FINALIZED: 409,
  }[error.code] ?? 500;
}

function sourceFor(page) {
  if (!page) {
    throw new HistoryRequestError("The reviewed target is no longer available.", {
      status: 409, code: "history_target_unavailable",
    });
  }
  if (page.kind === "url") return null;
  let stat;
  let content;
  try {
    stat = fs.statSync(page.file);
    if (stat.size <= SOURCE_LIMIT) content = stripSdk(fs.readFileSync(page.file, "utf8"));
  } catch (error) {
    if (!["ENOENT", "EACCES", "EPERM"].includes(error.code)) throw error;
    throw new HistoryRequestError("The reviewed source is missing or cannot be read.", {
      status: 409, code: "history_source_unavailable",
    });
  }
  if (stat.size > SOURCE_LIMIT) {
    throw new HistoryRequestError(`The source exceeds the ${SOURCE_LIMIT / (1024 * 1024)} MiB history capture limit.`, {
      status: 413, code: "history_source_too_large",
    });
  }
  if (Buffer.byteLength(content) > SOURCE_LIMIT) {
    throw new HistoryRequestError(`The source exceeds the ${SOURCE_LIMIT / (1024 * 1024)} MiB history capture limit.`, {
      status: 413, code: "history_source_too_large",
    });
  }
  return {
    content,
    hash: hash(content),
    mediaType: isMarkdown(page.file) ? "text/markdown" : "text/html",
  };
}

export function compareRevisions(revisions, beforeId, afterId, mode, { baselineUnavailable, resultUnavailable } = {}) {
  if (!["content", "source"].includes(mode)) throw new HistoryRequestError("Unknown comparison mode.");
  const before = beforeId ? revisions.get(beforeId) : null;
  const after = afterId ? revisions.get(afterId) : null;
  const representation = mode === "content" ? "semantic" : "source";
  if (!before?.[representation] || !after?.[representation]) {
    return {
      available: false, mode,
      reason: !before?.[representation] ? baselineUnavailable || `The before ${mode} snapshot is unavailable.`
        : resultUnavailable || `The result ${mode} snapshot has not been captured.`,
      changes: [], limitations: [mode === "source" ? "source_unavailable" : "semantic_unavailable"],
    };
  }
  const differences = mode === "source"
    ? compareSources(revisions.readSource(before.revisionId), revisions.readSource(after.revisionId))
    : compareSemanticSnapshots(revisions.readSemantic(before.revisionId), revisions.readSemantic(after.revisionId));
  return {
    ...differences, available: differences.status === "complete",
    ...(differences.status !== "complete" ? {
      reason: differences.status === "limited"
        ? "This comparison exceeds its processing limits. Its contents have not been partially displayed."
        : "The captured content cannot be compared.",
    } : {}),
    mode, baselineRevisionId: before.revisionId, resultRevisionId: after.revisionId,
    beforeCapturedAt: before[representation].capturedAt, afterCapturedAt: after[representation].capturedAt,
    sourceHash: after.source?.provenance.sourceHash ?? null,
    capturedSessionId: after.semantic?.provenance.sessionId ?? null,
    capturedGeneration: after.semantic?.provenance.generation ?? null,
    ...(mode === "content" ? { viewComparison: compareCapturedViews(before.semantic?.view, after.semantic?.view) } : {}),
  };
}

export function createConversationCapture({ store, currentRender }) {
  const saveRevision = (value) => {
    const provenance = {
      pageKey: value.documentId,
      ...(value.provenance.sessionId ? { sessionId: value.provenance.sessionId } : {}),
      ...(value.provenance.renderGeneration !== undefined ? { generation: value.provenance.renderGeneration } : {}),
      ...(value.source?.hash ? { sourceHash: value.source.hash } : {}),
      ...(value.provenance.captureId ? { captureId: value.provenance.captureId } : {}),
      feedbackOnlyEdits: value.provenance.feedbackOnly === true,
      trustedInteractive: value.provenance.trustedInteractive === true,
    };
    return store.revisions.put({
      documentId: value.documentId,
      reason: value.provenance.captureReason,
      limitations: value.limitations || [],
      ...(value.source ? {
        source: {
          text: value.source.content, mediaType: value.source.mediaType,
          capturedAt: value.capturedAt, provenance,
        },
      } : {}),
      ...(value.semantic ? {
        semantic: { snapshot: value.semantic, capturedAt: value.semanticCapturedAt ?? value.capturedAt, provenance, view: value.view },
      } : {}),
    });
  };
  function currentFrame(session, input, key) {
    const render = typeof input.renderId === "string" ? currentRender(input.renderId) : null;
    if (
      !render || render.sessionId !== session.id || render.pageKey !== key ||
      render.generation !== input.generation || render.documentState !== "served" ||
      session.activeKey !== key
    ) {
      throw new HistoryRequestError("The page changed or its current frame is unavailable. Recapture it.", {
        status: 409, code: "history_frame_changed",
      });
    }
    return render;
  }

  function checkedSource(page, render, expectedHash, session) {
    const source = sourceFor(page);
    const write = store.data.conversations.writes[page.key];
    const savedInReview = write?.reviewId === session.reviewId && write?.hash === source?.hash;
    if (source && (
      typeof expectedHash !== "string" ||
      source.hash !== expectedHash ||
      (render.sourceHash !== expectedHash && !savedInReview)
    )) {
      throw new HistoryRequestError("The source changed since this version was reviewed. Reload and recapture it.", {
        status: 409, code: "history_source_changed",
      });
    }
    return source;
  }

  function snapshot(session, key, input, reason) {
    const page = store.page(key);
    const render = currentFrame(session, input, key);
    if (!input.semantic || typeof input.semantic !== "object" || Array.isArray(input.semantic)) {
      throw new HistoryRequestError("The current page did not provide a content snapshot.", {
        status: 409, code: "history_semantic_unavailable",
      });
    }
    if (input.semanticCapturedAt !== undefined && (
      !Number.isSafeInteger(input.semanticCapturedAt) ||
      input.semanticCapturedAt < render.createdAt || input.semanticCapturedAt > Date.now() + 5000
    )) {
      throw new HistoryRequestError("The content capture timestamp does not belong to this rendered version.");
    }
    const source = checkedSource(page, render, input.expectedSourceHash, session);
    return {
      documentId: key,
      capturedAt: Date.now(),
      semanticCapturedAt: input.semanticCapturedAt,
      source,
      semantic: input.semantic,
      view: normalizeView(input.view),
      provenance: {
        sessionId: session.id,
        renderGeneration: render.generation,
        renderId: render.renderId,
        pageKey: key,
        sourceHashAtRender: render.sourceHash ?? null,
        captureReason: reason,
        feedbackOnly: page.kind === "url" || isMarkdown(page.file) || render.feedbackOnly === true,
        trustedInteractive: render.trustedInteractive === true,
      },
    };
  }

  return {
    captureObservation: (session, key, input, reason) => saveRevision(snapshot(session, key, input, reason)),
  };
}
