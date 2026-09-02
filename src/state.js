import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalTarget, ensureStateDir, pageKey, realFile, statePath, targetKey } from "./paths.js";

/** Anything untouched this long is review debris, not work in progress. */
const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DELIVERY_STATES = new Set(["queued", "possibly_delivered", "delivered"]);

const fresh = (entry, now) => !!entry && now - (entry.updatedAt || 0) < PRUNE_AGE_MS;
const batchId = () => `b_${crypto.randomBytes(12).toString("hex")}`;
const emptyState = () => ({ pages: {}, batches: {}, receipts: {} });

function pruneData(data, now = Date.now()) {
  let changed = false;
  for (const [key, page] of Object.entries(data.pages)) {
    const missingFile = page.kind !== "url" && !fs.existsSync(page.file);
    if (!fresh(page, now) || missingFile) {
      delete data.pages[key];
      delete data.batches[key];
      changed = true;
    }
  }
  for (const [key, batch] of Object.entries(data.batches)) {
    if (!fresh(batch, now)) {
      delete data.batches[key];
      changed = true;
    }
  }
  for (const [id, receipt] of Object.entries(data.receipts)) {
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
  };
  let changed = !parsed.batches || !parsed.receipts;
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
  }
  return { data, changed };
}

/**
 * Atomic write via a unique sibling tmp file. The name is unguessable and the
 * create is exclusive, so a pre-planted symlink can never redirect the write,
 * and a failed rename never leaves a predictable orphan behind.
 */
export function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.doc-review.tmp`;
  fs.writeFileSync(tmp, data, { flag: "wx" });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
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
  constructor({ write = atomicWrite, makeBatchId = batchId } = {}) {
    this.data = emptyState();
    this.write = write;
    this.makeBatchId = makeBatchId;
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
    return this.update(key, (page) => {
      page.comments.push(comment);
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
  setPristine(key, html) {
    return this.update(key, (page) => {
      page.pristine = html;
      page.edits = [];
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

  setBatch(entryKey, { batch, cleanup, deliveryState = "queued" }) {
    if (!DELIVERY_STATES.has(deliveryState)) throw new Error(`Unknown delivery state: ${deliveryState}`);
    return this.transaction((draft) => {
      const existing = draft.batches[entryKey];
      if (existing && existing.delivery_state !== "queued") {
        draft.receipts[existing.batch_id] = {
          cleanup: existing.cleanup,
          delivery_state: existing.delivery_state,
          updatedAt: Date.now(),
        };
      }
      const id = batch.batch_id || this.makeBatchId();
      const storedBatch = { ...batch, batch_id: id };
      const record = {
        batch_id: id,
        batch: storedBatch,
        cleanup,
        delivery_state: deliveryState,
        updatedAt: Date.now(),
      };
      draft.batches[entryKey] = record;
      return record;
    });
  }

  markBatchDelivered(entryKey) {
    if (!this.batch(entryKey)) return null;
    return this.transaction((draft) => {
      const record = draft.batches[entryKey];
      record.delivery_state = "delivered";
      record.updatedAt = Date.now();
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
        updatedAt: Date.now(),
      };
      const staged = [];
      const keys = [];
      for (const { key, ids, staged: assets = [], sentAt } of record.cleanup) {
        staged.push(...assets);
        keys.push(key);
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
      return { acknowledged: true, staged, keys };
    });
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
