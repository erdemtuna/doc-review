import fs from "node:fs";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { stripSdk } from "./html-transform.js";
import { isMarkdown } from "./markdown.js";
import { compareSemanticSnapshots, compareSources, DIFF_VERSION } from "./revision-diff.js";
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

export function createHistoryController({
  store, sessions, currentRender, readBody, json, emit, pageState,
}) {
  const cache = new Map();
  let cachedBytes = 0;

  const revision = (id) => id ? store.revisions.get(id) : null;
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
  const roundFor = (session, roundId) => store.getRound(session.entryKey, roundId);

  function changed(entryKey, roundId) {
    for (const session of sessions.values()) {
      if (session.entryKey === entryKey) emit(session, "history", { roundId });
    }
  }

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

  function checkedSource(page, render, expectedHash) {
    const source = sourceFor(page);
    if (source && (
      typeof expectedHash !== "string" ||
      source.hash !== expectedHash ||
      render.sourceHash !== expectedHash
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
    const source = checkedSource(page, render, input.expectedSourceHash);
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

  function prepareBaseline(session, pages, input) {
    if (input === undefined) return null;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new HistoryRequestError("Invalid history submission.");
    }
    if (input.allowUnavailable !== undefined && typeof input.allowUnavailable !== "boolean") {
      throw new HistoryRequestError("Invalid missing-comparison choice.");
    }
    const keys = pages.length ? pages.map((page) => page.key) : [session.entryKey];
    const pending = [];
    const unavailable = [];
    for (const key of keys) {
      const page = store.page(key);
      let value = null;
      let reason = null;
      try {
        value = snapshot(session, key, input, "send");
      } catch (error) {
        if (!(error instanceof HistoryRequestError) && !["ENOENT", "EACCES", "EPERM"].includes(error.code)) throw error;
        reason = error.message;
        unavailable.push({ key, filename: pageState(key)?.filename || key, reason });
        if (input.allowUnavailable) {
          try {
            const source = sourceFor(page);
            if (source) {
              value = {
                documentId: key, capturedAt: Date.now(), source, semantic: null,
                provenance: { captureReason: "send-source-only", pageKey: key },
                limitations: ["semantic_before_unavailable"],
              };
            }
          } catch (sourceError) {
            if (!(sourceError instanceof HistoryRequestError) && !["ENOENT", "EACCES", "EPERM"].includes(sourceError.code)) {
              throw sourceError;
            }
            reason = sourceError.message;
          }
        }
      }
      pending.push({ key, value, reason });
    }
    if (unavailable.length && !input.allowUnavailable) {
      throw new HistoryRequestError("Some pages need to be recaptured before their comparison can be saved.", {
        status: 409, code: "history_baseline_unavailable", targets: unavailable,
      });
    }
    const targets = pending.map(({ key, value, reason }) => ({
      key,
      ...(value ? { baselineRevisionId: saveRevision(value).revisionId } : {
        baselineUnavailable: reason || "The before snapshot is unavailable.",
      }),
      ownerSessionId: session.id,
    }));
    return { targets, unavailable };
  }

  function presentRound(round) {
    return {
      ...round,
      sentAt: round.sentAt ?? round.createdAt,
      targets: round.targets.map((target) => ({
        ...target,
        captureStatus: target.capture?.status || (target.resultRevisionId ? "ready" : "pending"),
        filename: pageState(target.key)?.filename || target.key,
        kind: store.page(target.key)?.kind === "url" ? "url" : "file",
      })),
    };
  }

  function list(session) {
    return {
      activeKey: session.activeKey,
      rounds: store.listHistory(session.entryKey).map(presentRound),
    };
  }

  function captureSources(entryKey, roundId) {
    const rounds = roundId ? [store.getRound(entryKey, roundId)] : store.listHistory(entryKey);
    for (const round of rounds) {
      if (round?.feedbackStatus !== "acknowledged" || round.completedAt) continue;
      for (const target of round.targets) {
        if (
          target.sourceResultRevisionId || target.resultRevisionId ||
          target.capture?.status === "unavailable" || store.page(target.key)?.kind === "url"
        ) continue;
        try {
          const saved = saveRevision({
            documentId: target.key, capturedAt: Date.now(),
            source: sourceFor(store.page(target.key)),
            provenance: { captureReason: "acknowledged-source-result" },
          });
          store.recordSourceResult(entryKey, round.roundId, target.key, { revisionId: saved.revisionId });
          console.info("[doc-review]", { event: "history-source-captured", roundId: round.roundId, key: target.key });
        } catch (error) {
          try {
            store.recordSourceResult(entryKey, round.roundId, target.key, { unavailable: String(error.message).slice(0, 500) });
          } catch (persistenceError) {
            console.error("[doc-review]", { event: "history-source-failure-not-persisted", code: persistenceError.code || "history_storage_failed" });
          }
          console.error("[doc-review]", { event: "history-source-unavailable", roundId: round.roundId, key: target.key, code: error.code || "history_storage_failed" });
        }
      }
    }
  }

  function comparison(round, key, mode) {
    if (!["content", "source"].includes(mode)) throw new HistoryRequestError("Unknown comparison mode.");
    const target = round.targets.find((item) => item.key === key);
    if (!target) throw new HistoryRequestError("This target does not belong to the selected round.", { status: 404 });
    const before = revision(target.baselineRevisionId);
    const after = revision(mode === "source" ? target.sourceResultRevisionId || target.resultRevisionId : target.resultRevisionId);
    const representation = mode === "content" ? "semantic" : "source";
    if (!before?.[representation] || !after?.[representation]) {
      return {
        available: false,
        mode,
        reason: !before?.[representation]
          ? target.baselineUnavailable || `The before ${mode} snapshot is unavailable.`
          : (mode === "source" ? target.sourceResultUnavailable : target.resultUnavailable) || `The result ${mode} snapshot has not been captured.`,
        changes: [],
        limitations: [mode === "source" ? "source_unavailable" : "semantic_unavailable"],
      };
    }
    const cacheKey = `${DIFF_VERSION}:${before.revisionId}:${after.revisionId}:${mode}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey).value;
    const started = performance.now();
    const differences = mode === "source"
      ? compareSources(store.revisions.readSource(before.revisionId), store.revisions.readSource(after.revisionId))
      : compareSemanticSnapshots(store.revisions.readSemantic(before.revisionId), store.revisions.readSemantic(after.revisionId));
    const result = {
      ...differences,
      available: differences.status === "complete",
      ...(differences.status !== "complete" ? {
        reason: differences.status === "limited"
          ? "This comparison exceeds its processing limits. Its contents have not been partially displayed."
          : "The captured content cannot be compared.",
      } : {}),
      mode,
      baselineRevisionId: before.revisionId,
      resultRevisionId: after.revisionId,
      beforeCapturedAt: before[representation].capturedAt,
      afterCapturedAt: after[representation].capturedAt,
      sourceHash: after.source?.provenance.sourceHash ?? null,
      capturedSessionId: after.semantic?.provenance.sessionId ?? null,
      capturedGeneration: after.semantic?.provenance.generation ?? null,
      ...(mode === "content" ? { viewComparison: compareCapturedViews(before.semantic?.view, after.semantic?.view) } : {}),
    };
    const bytes = Buffer.byteLength(JSON.stringify(result));
    while (cache.size && (cache.size >= 16 || cachedBytes + bytes > 8 * 1024 * 1024)) {
      const oldest = cache.keys().next().value;
      cachedBytes -= cache.get(oldest).bytes;
      cache.delete(oldest);
    }
    if (bytes <= 8 * 1024 * 1024) {
      cache.set(cacheKey, { value: result, bytes });
      cachedBytes += bytes;
    }
    console.info("[doc-review]", {
      event: "history-compared", roundId: round.roundId, key, mode,
      durationMs: Math.round(performance.now() - started), changes: result.changes.length,
    });
    return result;
  }

  async function handle(req, res, url) {
    const match = url.pathname.match(/^\/api\/session\/(\w+)\/history(?:\/([\w-]+))?(?:\/(compare|capture))?$/);
    if (!match) return false;
    const session = sessions.get(match[1]);
    if (!session) {
      json(res, 404, { error: "unknown session" });
      return true;
    }
    try {
      if (!match[2] && req.method === "GET") {
        json(res, 200, list(session));
        return true;
      }
      let round = roundFor(session, match[2]);
      if (!round) throw new HistoryRequestError("Unknown round in this review history.", { status: 404 });
      if (!match[3] && req.method === "GET") {
        json(res, 200, { round: presentRound(round) });
        return true;
      }
      if (match[3] === "compare" && req.method === "GET") {
        json(res, 200, comparison(round, url.searchParams.get("key") || session.activeKey, url.searchParams.get("mode") || "content"));
        return true;
      }
      if (match[3] === "capture" && req.method === "POST") {
        const body = await readBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new HistoryRequestError("Invalid capture request.");
        }
        round = roundFor(session, match[2]);
        if (!round) throw new HistoryRequestError("Unknown round in this review history.", { status: 404 });
        const key = typeof body.key === "string" ? body.key : session.activeKey;
        const target = round.targets.find((item) => item.key === key);
        if (!target) throw new HistoryRequestError("This target does not belong to the selected round.", { status: 404 });
        if (round.feedbackStatus !== "acknowledged") {
          throw new HistoryRequestError("The round has not been acknowledged.", { status: 409 });
        }
        if (target.resultRevisionId) {
          json(res, 200, { ok: true, alreadyCaptured: true, round: presentRound(round) });
          return true;
        }
        if (body.manual !== undefined && typeof body.manual !== "boolean") {
          throw new HistoryRequestError("Invalid manual capture choice.");
        }
        if (body.finalUnavailable !== undefined && body.finalUnavailable !== true) {
          throw new HistoryRequestError("Invalid final capture choice.");
        }
        if (body.finalUnavailable === true) {
          if (body.manual !== true) throw new HistoryRequestError("Finishing without content capture must be an explicit choice.");
          if (target.capture?.status === "unavailable") {
            json(res, 200, { ok: true, alreadyFinalized: true, round: presentRound(round) });
            return true;
          }
          captureSources(session.entryKey, round.roundId);
          const claimed = store.claimCapture(session.entryKey, round.roundId, key, {
            ownerSessionId: session.id, generation: 0,
          });
          const updated = store.markCaptureUnavailable(session.entryKey, round.roundId, key, {
            captureId: claimed.captureId, ownerSessionId: session.id, generation: 0,
            reason: "Content capture was explicitly finished with the available snapshots.", final: true,
          });
          changed(session.entryKey, round.roundId);
          json(res, 200, { ok: true, round: presentRound(updated.round) });
          return true;
        }
        const baseline = revision(target.baselineRevisionId);
        const owner = target.ownerSessionId || baseline?.semantic?.provenance.sessionId;
        if (owner && owner !== session.id && body.manual !== true) {
          throw new HistoryRequestError("The review window that sent this round owns automatic capture. Use Capture result to capture here.", {
            status: 409, code: "history_capture_owner",
          });
        }
        const render = currentFrame(session, body, key);
        if (!target.sourceResultRevisionId) captureSources(session.entryKey, round.roundId);
        const claimed = store.claimCapture(session.entryKey, round.roundId, key, {
          ownerSessionId: session.id, generation: render.generation,
        });
        const ownership = {
          captureId: claimed.captureId, ownerSessionId: session.id, generation: render.generation,
        };
        let updated;
        let saved;
        try {
          if (typeof body.error === "string" && body.error.trim()) {
            if (body.error.length > 500) throw new HistoryRequestError("Capture failure reason is too long.");
            updated = store.markCaptureUnavailable(session.entryKey, round.roundId, key, {
              ...ownership, reason: body.error, final: false,
            });
          } else {
            const value = snapshot(session, key, body, body.manual === true ? "manual-result" : "automatic-result");
            const viewComparison = compareCapturedViews(baseline?.semantic?.view, value.view);
            if (viewComparison.status === "mismatch") {
              throw new HistoryRequestError(viewComparison.message, { status: 409, code: "history_view_mismatch" });
            }
            value.provenance.captureId = claimed.captureId;
            saved = saveRevision(value);
            updated = store.recordCaptureResult(session.entryKey, round.roundId, key, {
              ...ownership, revisionId: saved.revisionId,
            });
          }
        } catch (error) {
          try {
            store.markCaptureUnavailable(session.entryKey, round.roundId, key, {
              ...ownership, reason: String(error.message).slice(0, 500), final: false,
            });
            changed(session.entryKey, round.roundId);
          } catch (persistenceError) {
            console.error("[doc-review]", { event: "history-failure-not-persisted", code: persistenceError.code || "history_failed" });
          }
          throw error;
        }
        changed(session.entryKey, round.roundId);
        console.info("[doc-review]", {
          event: saved ? "history-captured" : "history-capture-unavailable",
          roundId: round.roundId, key, ...(saved ? { revisionId: saved.revisionId } : {}),
        });
        json(res, 200, { ok: !!saved, round: presentRound(updated.round) });
        return true;
      }
      json(res, 405, { error: "method not allowed" });
    } catch (error) {
      const status = historyErrorStatus(error);
      console.error("[doc-review]", { event: "history-failed", status, code: error.code || "history_failed" });
      json(res, status, {
        error: error.message,
        code: error.code || "history_failed",
        ...(error.targets?.length ? { targets: error.targets } : {}),
      });
    }
    return true;
  }

  return { prepareBaseline, captureSources, list, handle, changed };
}
