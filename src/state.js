import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeCommentAnchor } from "./comment-anchor.js";
import { canonicalTarget, ensureStateDir, pageKey, realFile, statePath, targetKey } from "./paths.js";
export { atomicWrite } from "./atomic-write.js";
import { atomicWrite } from "./atomic-write.js";
import { RevisionStore } from "./revision-store.js";
import { CAPTURE_LEASE_MS, HISTORY_SCHEMA_VERSION, normalizeHistoryTargets, revisionError } from "./revision-schema.js";
import { historyRevisionReferences, retainHistory } from "./history-policy.js";

/** Anything untouched this long is review debris, not work in progress. */
const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DELIVERY_STATES = new Set(["queued", "possibly_delivered", "delivered"]);

const fresh = (entry, now) => !!entry && now - (entry.updatedAt || 0) < PRUNE_AGE_MS;
const batchId = () => `b_${crypto.randomBytes(12).toString("hex")}`;
const emptyState = () => ({ pages: {}, batches: {}, receipts: {}, histories: {} });
const historyId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString("hex")}`;

function historyRound(data, entryKey, roundId) {
  return data.histories[entryKey]?.rounds.find((round) => round.roundId === roundId) || null;
}

function batchRound(data, entryKey, id) {
  return data.histories[entryKey]?.rounds.find((round) => round.batchId === id) || null;
}

function publicRound(round) {
  if (!round) return null;
  const copy = structuredClone(round);
  copy.sentAt ||= new Date(copy.createdAt).toISOString();
  for (const target of copy.targets) {
    target.captureStatus = target.capture?.status || "pending";
    target.ownerSessionId = target.capture?.ownerSessionId || target.ownerSessionId || null;
  }
  return copy;
}

function finishCapture(round) {
  const statuses = round.targets.map((target) => target.capture?.status || "pending");
  if (statuses.every((status) => status === "ready" || status === "unavailable")) {
    const fullContent = round.targets.every((target) => target.capture.status === "ready" &&
      target.baselineCoverage?.semantic && target.resultCoverage?.semantic);
    const anyResult = statuses.some((status) => status === "ready") ||
      round.targets.some((target) => target.sourceResultRevisionId);
    round.captureStatus = fullContent ? "ready" : anyResult ? "partial" : "failed";
    round.completedAt ||= Date.now();
  } else {
    round.captureStatus = statuses.some((status) => status === "failed") ? "failed" : "pending";
  }
}

function pruneData(data, now = Date.now()) {
  let changed = retainHistory(data);
  for (const [key, page] of Object.entries(data.pages)) {
    const protectedPage = page.comments?.length || page.edits?.length || page.revisionRefs?.length ||
      data.batches[key] || Object.values(data.batches).some((record) => record.cleanup.some((item) => item.key === key)) ||
      Object.values(data.histories).some((history) => history.rounds.some((round) =>
        round.targets.some((target) => target.key === key)));
    if (protectedPage) continue;
    const missingFile = page.kind !== "url" && !fs.existsSync(page.file);
    if (!fresh(page, now) || missingFile) {
      delete data.pages[key];
      delete data.batches[key];
      changed = true;
    }
  }
  for (const [id, receipt] of Object.entries(data.receipts)) {
    if (Object.values(data.histories).some((history) => history.rounds.some((round) => round.batchId === id))) continue;
    if (!fresh(receipt, now)) {
      delete data.receipts[id];
      changed = true;
    }
  }
  return changed;
}

function normalizeState(parsed, makeBatchId) {
  if (!parsed || typeof parsed !== "object" || !parsed.pages || typeof parsed.pages !== "object") {
    throw new Error("Invalid doc-review state: expected a pages object.");
  }
  const data = {
    pages: parsed.pages,
    batches: parsed.batches && typeof parsed.batches === "object" ? parsed.batches : {},
    receipts: parsed.receipts && typeof parsed.receipts === "object" ? parsed.receipts : {},
    histories: parsed.histories && typeof parsed.histories === "object" ? parsed.histories : {},
  };
  let changed = !parsed.batches || !parsed.receipts;
  for (const history of Object.values(data.histories)) {
    if (history?.version !== HISTORY_SCHEMA_VERSION || !Array.isArray(history.rounds) ||
        !Number.isSafeInteger(history.nextOrdinal)) throw new Error("Invalid doc-review history.");
    for (const round of history.rounds) {
      if (!round?.roundId || !round.batchId || !Array.isArray(round.targets)) throw new Error("Invalid doc-review round.");
      for (const target of round.targets) {
        if (target.capture?.status === "running") {
          target.capture = {
            ...target.capture, captureId: historyId("cap"), status: "pending",
            ownerSessionId: null, generation: null, leaseExpiresAt: 0, error: "context_lost",
          };
          changed = true;
        }
      }
    }
  }
  const normalizeAnchor = (comment) => {
    if (!comment || comment.anchor == null) return;
    const normalized = normalizeCommentAnchor(comment.kind === "element" ? "element" : "selection", comment.anchor);
    if (JSON.stringify(normalized) !== JSON.stringify(comment.anchor)) {
      comment.anchor = normalized;
      changed = true;
    }
  };
  for (const page of Object.values(data.pages)) {
    for (const comment of page?.comments || []) normalizeAnchor(comment);
  }
  for (const record of Object.values(data.batches)) {
    if (!record || typeof record !== "object" || !record.batch || !Array.isArray(record.cleanup)) {
      throw new Error("Invalid doc-review state: malformed feedback batch.");
    }
    const existingId = record.batch_id || record.batch.batch_id;
    if (record.batch_id && record.batch.batch_id && record.batch_id !== record.batch.batch_id) {
      throw new Error("Invalid doc-review state: feedback batch IDs disagree.");
    }
    if (!existingId) {
      record.batch_id = makeBatchId();
      record.batch.batch_id = record.batch_id;
      record.delivery_state = "possibly_delivered";
      changed = true;
    } else {
      record.batch_id = existingId;
      if (record.batch.batch_id !== existingId) {
        record.batch.batch_id = existingId;
        changed = true;
      }
      if (!record.delivery_state) {
        record.delivery_state = "possibly_delivered";
        changed = true;
      }
    }
    if (!DELIVERY_STATES.has(record.delivery_state)) {
      throw new Error(`Invalid doc-review state: unknown delivery state ${record.delivery_state}.`);
    }
    for (const page of record.batch.pages || []) {
      for (const comment of page.comments || []) normalizeAnchor(comment);
    }
  }
  return { data, changed };
}

/**
 * All durable state lives in one JSON file. No database, no network.
 *
 * Shape:
 *   {
 *     pages:   { <key>: { key, file, pristine, comments[], edits[], updatedAt } },
 *     batches: { <entryKey>: { batch_id, batch, cleanup, delivery_state, updatedAt } },
 *     receipts:{ <batchId>: { cleanup, delivery_state, updatedAt } },
 *   }
 *
 * Pages are fully independent: no page ever references another. Batches are
 * feedback the user sent that no agent has acknowledged yet; persisting them
 * means "your feedback is safe" stays true across server restarts.
 */
export class Store {
  constructor({ write = atomicWrite, makeBatchId = batchId, revisions = new RevisionStore() } = {}) {
    this.data = emptyState();
    this.write = write;
    this.makeBatchId = makeBatchId;
    this.revisions = revisions;
    this.load();
  }

  load() {
    let parsed;
    try {
      const raw = fs.readFileSync(statePath(), "utf8");
      parsed = JSON.parse(raw);
    } catch (err) {
      if (err.code === "ENOENT") return this.data;
      throw err;
    }
    const normalized = normalizeState(parsed, this.makeBatchId);
    this.data = normalized.data;
    const changed = pruneData(this.data);
    if (normalized.changed || changed) this.persist(this.data);
    return this.data;
  }

  persist(data) {
    ensureStateDir();
    this.write(statePath(), JSON.stringify(data, null, 2));
  }

  /** Replace durable state once, then publish the committed draft in memory. */
  transaction(mutator) {
    const draft = structuredClone(this.data);
    const result = mutator(draft);
    if (result && typeof result.then === "function") {
      throw new Error("Store.transaction mutators must be synchronous.");
    }
    pruneData(draft);
    this.persist(draft);
    this.data = draft;
    return result;
  }

  /** Persist deliberate direct changes used by maintenance and tests. */
  save() {
    const draft = structuredClone(this.data);
    pruneData(draft);
    this.persist(draft);
    this.data = draft;
    return this.data;
  }

  /** Register a file as a reviewable page, capturing the agent's version. */
  openPage(file, pristine) {
    const key = pageKey(file);
    return this.transaction((draft) => {
      const existing = draft.pages[key];
      const page = existing || {
        key,
        kind: "file",
        file: realFile(file),
        pristine: "",
        comments: [],
        edits: [],
        updatedAt: 0,
      };
      page.kind = "file";
      page.file = realFile(file);
      delete page.url;
      if (!existing || typeof pristine === "string") {
        page.pristine = typeof pristine === "string" ? pristine : page.pristine;
      }
      page.updatedAt = Date.now();
      draft.pages[key] = page;
      return page;
    });
  }

  /** Register a rendered localhost route. Browser edits are never written to it. */
  openUrl(url) {
    const target = canonicalTarget(url);
    if (target.kind !== "url") throw new Error("Expected a localhost URL.");
    const key = targetKey(target.value);
    return this.transaction((draft) => {
      const existing = draft.pages[key];
      const page = existing || {
        key,
        kind: "url",
        url: target.value,
        pristine: "",
        comments: [],
        edits: [],
        updatedAt: 0,
      };
      page.kind = "url";
      page.url = target.value;
      delete page.file;
      page.updatedAt = Date.now();
      draft.pages[key] = page;
      return page;
    });
  }

  page(key) {
    return this.data.pages[key] || null;
  }

  pageForFile(file) {
    return this.page(pageKey(file));
  }

  pageForTarget(target) {
    return this.page(targetKey(target));
  }

  update(key, mutate) {
    if (!this.page(key)) return null;
    return this.transaction((draft) => {
      const page = draft.pages[key];
      mutate(page);
      page.updatedAt = Date.now();
      return page;
    });
  }

  addComment(key, comment) {
    const anchor = comment.anchor == null
      ? comment.anchor
      : normalizeCommentAnchor(comment.kind === "element" ? "element" : "selection", comment.anchor);
    if (comment.anchor != null && !anchor) throw new Error("Invalid comment anchor.");
    return this.update(key, (page) => {
      page.comments.push({ ...comment, ...(comment.anchor !== undefined ? { anchor } : {}) });
    });
  }

  removeComment(key, id) {
    return this.update(key, (page) => {
      page.comments = page.comments.filter((c) => c.id !== id);
    });
  }

  /** Reword feedback, optionally turning a delivered instruction into a correction. */
  updateComment(key, id, feedback, { replacementId = "", correctionOf = "" } = {}) {
    let found = false;
    const page = this.update(key, (p) => {
      const index = p.comments.findIndex((c) => c.id === id);
      const comment = p.comments[index];
      if (comment) {
        const updated = {
          ...comment,
          ...(replacementId ? { id: replacementId } : {}),
          feedback,
          updatedAt: Date.now(),
          ...(correctionOf ? { correction: true, correctionOf } : {}),
        };
        p.comments[index] = updated;
        found = true;
      }
    });
    return found ? page : null;
  }

  /**
   * Reword a comment and every queued copy in one commit. Any evidence that
   * the old ID may have shipped turns the edit into a replacement correction.
   */
  reviseComment(key, id, feedback, { replacementId } = {}) {
    if (!this.page(key)?.comments.some((comment) => comment.id === id)) return null;
    return this.transaction((draft) => {
      const page = draft.pages[key];
      const index = page.comments.findIndex((comment) => comment.id === id);
      const existing = page.comments[index];
      const matching = (record) => record.cleanup.some((item) => item.key === key && item.ids.includes(id));
      const mayHaveShipped =
        Object.values(draft.batches).some((record) => record.delivery_state !== "queued" && matching(record)) ||
        Object.values(draft.receipts).some((record) => matching(record));

      if (mayHaveShipped) {
        page.comments[index] = {
          ...existing,
          id: replacementId || this.makeBatchId().replace(/^b_/, "c_"),
          feedback,
          updatedAt: Date.now(),
          correction: true,
          correctionOf: existing.feedback,
        };
        page.updatedAt = Date.now();
        return { delivery: "correction", page };
      }

      page.comments[index] = { ...existing, feedback, updatedAt: Date.now() };
      page.updatedAt = Date.now();
      let updatedPending = false;
      for (const record of Object.values(draft.batches)) {
        if (record.delivery_state !== "queued" || !matching(record)) continue;
        for (const batchPage of record.batch.pages || []) {
          const comment = (batchPage.comments || []).find((item) => item.id === id);
          if (comment) {
            comment.feedback = feedback;
            updatedPending = true;
          }
        }
        record.updatedAt = Date.now();
      }
      return { delivery: updatedPending ? "updated-pending" : "unsent", page };
    });
  }

  /**
   * Edits are deduped by label+kind so retyping one block stays one row, but
   * the text is refreshed every time so `after` is always the latest wording.
   */
  addEdit(key, label, kind, before, after, beforeHtml, afterHtml, extra) {
    return this.update(key, (page) => {
      const row = page.edits.find((e) => e.label === label && e.kind === kind);
      if (row) {
        if (after !== undefined) row.after = after;
        if (afterHtml !== undefined) row.after_html = afterHtml;
        // A re-move of the same block replaces its landing spot.
        if (extra) {
          if (Array.isArray(extra.truncated_fields)) {
            const replaced = new Set([
              ...(after !== undefined ? ["after"] : []),
              ...(afterHtml !== undefined ? ["after_html"] : []),
              ...["moved_after", "moved_before"].filter((field) => extra[field] !== undefined),
            ]);
            // Original before text is retained across edits, including its truncation.
            const truncatedFields = [...new Set([
              ...(row.truncated_fields || []).filter((field) => !replaced.has(field)),
              ...extra.truncated_fields.filter((field) => replaced.has(field)),
            ])];
            extra = { ...extra, truncated: truncatedFields.length > 0, truncated_fields: truncatedFields };
          }
          if (extra.staged_assets) {
            const assets = [...(row.staged_assets || []), ...extra.staged_assets];
            extra = { ...extra, staged_assets: [...new Map(assets.map((asset) => [asset.path, asset])).values()] };
          }
          Object.assign(row, extra);
        }
        row.updatedAt = Date.now();
        return;
      }
      page.edits.push({ label, kind, before, after, before_html: beforeHtml, after_html: afterHtml, ...(extra || {}), at: Date.now(), updatedAt: Date.now() });
    });
  }

  clearEdits(key) {
    return this.update(key, (page) => {
      page.edits = [];
    });
  }

  /** After the agent writes, its version becomes the new revert target. */
  setPristine(key, html, { keepEdits = false } = {}) {
    return this.update(key, (page) => {
      page.pristine = html;
      if (!keepEdits) page.edits = [];
    });
  }

  /**
   * Drop exactly what the acknowledged batch carried. Comments made after
   * Send have unknown ids; edits made (or retyped) after Send have a newer
   * timestamp than the batch. Both must survive for the next batch.
   */
  clearSent(key, ids, sentAt) {
    return this.update(key, (page) => {
      const drop = new Set(ids);
      page.comments = page.comments.filter((c) => !drop.has(c.id));
      // >= not >: an edit stamped the same millisecond as the send may not
      // have shipped — resending it is harmless, dropping it loses work.
      page.edits = typeof sentAt === "number" ? page.edits.filter((e) => (e.updatedAt || e.at || 0) >= sentAt) : [];
    });
  }

  // Sent-but-unacked feedback, keyed by the entry page the agent polls.

  batch(entryKey) {
    return this.data.batches[entryKey] || null;
  }

  allBatches() {
    return this.data.batches;
  }

  setBatch(entryKey, { batch, cleanup, deliveryState = "queued", history } = {}, options = {}) {
    const optionHistory = options.history || (options.targets ? options : undefined);
    if (history && optionHistory) throw revisionError("Specify history context only once.");
    history ||= optionHistory;
    if (!DELIVERY_STATES.has(deliveryState)) throw new Error(`Unknown delivery state: ${deliveryState}`);
    const targets = history ? normalizeHistoryTargets(history.targets) : null;
    for (const target of targets || []) {
      if (!this.page(target.key)) throw revisionError("Unknown history document.");
      if (target.baselineRevisionId) {
        const manifest = this.revisions.verify(target.baselineRevisionId, target.key);
        target.baselineCoverage = { source: !!manifest.source, semantic: !!manifest.semantic };
      }
    }
    return this.transaction((draft) => {
      const existing = draft.batches[entryKey];
      const superseded = existing ? batchRound(draft, entryKey, existing.batch_id) : null;
      if (superseded) {
        superseded.feedbackStatus = "superseded";
        superseded.supersededAt = Date.now();
        superseded.captureStatus = "cancelled";
      }
      if (existing && existing.delivery_state !== "queued") {
        draft.receipts[existing.batch_id] = {
          cleanup: existing.cleanup,
          delivery_state: existing.delivery_state,
          batch: structuredClone(existing.batch),
          updatedAt: Date.now(),
        };
      }
      const id = batch.batch_id || this.makeBatchId();
      const storedBatch = { ...structuredClone(batch), batch_id: id };
      const record = {
        batch_id: id,
        batch: storedBatch,
        cleanup: structuredClone(cleanup),
        delivery_state: deliveryState,
        updatedAt: Date.now(),
      };
      draft.batches[entryKey] = record;
      if (targets) {
        const historyState = draft.histories[entryKey] ||= {
          version: HISTORY_SCHEMA_VERSION, entryKey, nextOrdinal: 1, rounds: [],
        };
        const round = {
          roundId: historyId("round"), entryKey, ordinal: historyState.nextOrdinal++,
          batchId: id, createdAt: Date.now(),
          sentAt: new Date().toISOString(),
          feedbackStatus: deliveryState === "delivered" ? "delivered" : "queued",
          captureStatus: "pending",
          targets: targets.map((target) => ({ ...target, resultRevisionId: null, capture: null })),
        };
        if (deliveryState === "delivered") round.deliveredFeedback = structuredClone(storedBatch);
        historyState.rounds.push(round);
        record.round_id = round.roundId;
      }
      return record;
    });
  }

  markBatchDelivered(entryKey) {
    if (!this.batch(entryKey)) return null;
    return this.transaction((draft) => {
      const record = draft.batches[entryKey];
      record.delivery_state = "delivered";
      record.updatedAt = Date.now();
      const round = batchRound(draft, entryKey, record.batch_id);
      if (round) {
        round.feedbackStatus = "delivered";
        round.deliveredAt ||= Date.now();
        round.deliveredFeedback ||= structuredClone(record.batch);
      }
      return record;
    });
  }

  /**
   * Clear exactly one delivered receipt and its shipped page contents.
   * Stale, duplicate, queued, and legacy possibly-delivered IDs are no-ops.
   */
  acknowledgeBatch(entryKey, id) {
    const current = this.batch(entryKey);
    if (!current || current.batch_id !== id || current.delivery_state !== "delivered") {
      return { acknowledged: false, staged: [], keys: [] };
    }
    return this.transaction((draft) => {
      const record = draft.batches[entryKey];
      delete draft.batches[entryKey];
      draft.receipts[id] = {
        cleanup: record.cleanup,
        delivery_state: "acknowledged",
        batch: structuredClone(record.batch),
        updatedAt: Date.now(),
      };
      const round = batchRound(draft, entryKey, id);
      if (round) {
        round.feedbackStatus = "acknowledged";
        round.acknowledgedAt = Date.now();
        round.deliveredFeedback ||= structuredClone(record.batch);
        for (const target of round.targets) {
          target.capture = {
            captureId: historyId("cap"), status: "pending", ownerSessionId: null,
            generation: null, attempt: 0, leaseExpiresAt: 0,
          };
        }
      }
      const staged = [];
      const keys = round ? round.targets.map((target) => target.key) : [];
      for (const { key, ids, staged: assets = [], sentAt } of record.cleanup) {
        staged.push(...assets);
        if (!keys.includes(key)) keys.push(key);
        const page = draft.pages[key];
        if (!page) continue;
        const drop = new Set(ids);
        page.comments = page.comments.filter((comment) => !drop.has(comment.id));
        page.edits =
          typeof sentAt === "number"
            ? page.edits.filter((edit) => (edit.updatedAt || edit.at || 0) >= sentAt)
            : [];
        page.updatedAt = Date.now();
      }
      return { acknowledged: true, staged, keys, ...(round ? { roundId: round.roundId } : {}) };
    });
  }

  listHistory(entryKey) {
    return (this.data.histories[entryKey]?.rounds || []).map(publicRound).sort((a, b) => b.ordinal - a.ordinal);
  }

  getRound(entryKey, roundId) {
    return publicRound(historyRound(this.data, entryKey, roundId));
  }

  recordSourceResult(entryKey, roundId, key, { revisionId, unavailable } = {}) {
    if (revisionId && unavailable) throw revisionError("Source result availability is ambiguous.");
    if (revisionId) {
      const manifest = this.revisions.verify(revisionId, key);
      if (!manifest.source) throw revisionError("Source result must contain a source snapshot.");
    } else if (typeof unavailable !== "string" || !unavailable || unavailable.length > 500) {
      throw revisionError("Source result needs a revision or unavailable reason.");
    }
    const existing = historyRound(this.data, entryKey, roundId);
    const existingTarget = existing?.targets.find((target) => target.key === key);
    if (existing?.feedbackStatus !== "acknowledged" || !existingTarget) throw revisionError("Source capture is not pending.");
    if (existingTarget.sourceResultRevisionId) {
      if (existingTarget.sourceResultRevisionId === revisionId) return { accepted: false, duplicate: true, round: publicRound(existing) };
      throw revisionError("The source result is already frozen.", "CAPTURE_FINALIZED");
    }
    if (existing.completedAt || existingTarget.resultRevisionId || existingTarget.capture?.status === "unavailable") {
      throw revisionError("The target capture is already finalized.", "CAPTURE_FINALIZED");
    }
    const result = this.transaction((draft) => {
      const round = historyRound(draft, entryKey, roundId);
      const target = round.targets.find((item) => item.key === key);
      if (revisionId) {
        target.sourceResultRevisionId = revisionId;
        delete target.sourceResultUnavailable;
      } else target.sourceResultUnavailable = unavailable;
      return round;
    });
    return { accepted: true, round: publicRound(result) };
  }

  claimCapture(entryKey, roundId, key, { ownerSessionId, generation, leaseMs = CAPTURE_LEASE_MS } = {}) {
    if (typeof ownerSessionId !== "string" || !ownerSessionId || ownerSessionId.length > 200 ||
        !Number.isSafeInteger(generation) || generation < 0 ||
        !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 5 * CAPTURE_LEASE_MS) {
      throw revisionError("Invalid capture ownership.");
    }
    const result = this.transaction((draft) => {
      const round = historyRound(draft, entryKey, roundId);
      const target = round?.targets.find((item) => item.key === key);
      if (round?.feedbackStatus !== "acknowledged" || !target?.capture) throw revisionError("Capture is not pending.");
      if (target.capture.status === "ready" || target.capture.status === "unavailable") throw revisionError("Capture is already finalized.", "CAPTURE_FINALIZED");
      if (target.capture.status === "running" && target.capture.leaseExpiresAt > Date.now()) {
        if (target.capture.ownerSessionId === ownerSessionId && target.capture.generation === generation) return target.capture;
        throw revisionError("Another frame owns this capture.", "CAPTURE_CONFLICT");
      }
      target.capture = {
        captureId: historyId("cap"), status: "running", ownerSessionId, generation,
        attempt: target.capture.attempt + 1, leaseExpiresAt: Date.now() + leaseMs,
      };
      round.captureStatus = "pending";
      return target.capture;
    });
    return structuredClone(result);
  }

  recordCaptureResult(entryKey, roundId, key, { captureId, ownerSessionId, generation, revisionId } = {}) {
    const manifest = this.revisions.verify(revisionId, key);
    const result = this.transaction((draft) => {
      const round = historyRound(draft, entryKey, roundId);
      const target = round?.targets.find((item) => item.key === key);
      const capture = target?.capture;
      if (capture?.status === "ready" && capture.captureId === captureId &&
          capture.ownerSessionId === ownerSessionId && capture.generation === generation &&
          target.resultRevisionId === revisionId) return { accepted: false, duplicate: true, round };
      this.assertCapture(round, capture, { captureId, ownerSessionId, generation });
      target.resultRevisionId = revisionId;
      target.resultCoverage = { source: !!manifest.source, semantic: !!manifest.semantic };
      capture.status = "ready";
      capture.capturedAt = Date.now();
      capture.leaseExpiresAt = 0;
      finishCapture(round);
      return { accepted: true, round };
    });
    return structuredClone(result);
  }

  markCaptureUnavailable(entryKey, roundId, key, { captureId, ownerSessionId, generation, reason, final = false } = {}) {
    if (typeof reason !== "string" || !reason || reason.length > 500) throw revisionError("Invalid capture failure reason.");
    const result = this.transaction((draft) => {
      const round = historyRound(draft, entryKey, roundId);
      const target = round?.targets.find((item) => item.key === key);
      const capture = target?.capture;
      const unowned = round?.feedbackStatus === "acknowledged" &&
        (capture?.status === "pending" || capture?.status === "failed") &&
        !capture.ownerSessionId && capture.captureId === captureId &&
        !ownerSessionId && generation == null;
      if (!unowned) this.assertCapture(round, capture, { captureId, ownerSessionId, generation });
      capture.status = final ? "unavailable" : "failed";
      capture.error = reason;
      capture.leaseExpiresAt = 0;
      if (final) target.resultUnavailable = reason;
      finishCapture(round);
      return { accepted: true, round };
    });
    return structuredClone(result);
  }

  assertCapture(round, capture, { captureId, ownerSessionId, generation }) {
    if (round?.feedbackStatus !== "acknowledged" || capture?.status !== "running" ||
        capture.captureId !== captureId || capture.ownerSessionId !== ownerSessionId ||
        capture.generation !== generation || capture.leaseExpiresAt <= Date.now()) {
      throw revisionError("Capture response is stale or belongs to another frame.", "CAPTURE_CONFLICT");
    }
  }

  collectHistoryGarbage(options) {
    return this.revisions.collectGarbage(historyRevisionReferences(this.data), options);
  }

  clearBatch(entryKey) {
    if (!this.batch(entryKey)) return null;
    return this.transaction((draft) => {
      const record = draft.batches[entryKey];
      delete draft.batches[entryKey];
      return record;
    });
  }
}

/** Resolve a sibling asset request without escaping the artifact's directory. */
export function resolveAsset(pageFile, relative) {
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return null;
  }
  const base = path.dirname(pageFile);
  const target = path.resolve(base, decoded);
  const contained = (candidate, root) => {
    const rel = path.relative(root, candidate);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  if (!contained(target, base)) return null;
  // The lexical check alone would follow a symlink out of the directory, so
  // the resolved filesystem path must land inside it too.
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    // Nothing readable at that path — anything a symlink could point to would
    // have resolved. The caller's read fails with a plain 404.
    return target;
  }
  let realBase = base;
  try {
    realBase = fs.realpathSync(base);
  } catch {}
  if (!contained(real, realBase)) return null;
  return real;
}
