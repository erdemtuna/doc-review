import { decodePage, record } from "./chrome-api.js";
import type { RenderIdentity } from "./frame-controller.js";
import type { PageResponse, SavePolicy } from "./contracts/page.js";

interface SaveState {
  status: "idle" | "saving" | "saved" | "failed";
  savedAt: string;
  baseHash: string | null;
  conflict: boolean;
  dirty: boolean;
  dynamic: boolean;
}

interface Options {
  sessionId: string;
  current: () => RenderIdentity;
  policy: () => SavePolicy;
  request: (path: string, options?: RequestInit) => Promise<unknown>;
  flush: (strict: boolean) => Promise<void>;
  send: (message: Record<string, unknown>) => void;
  sourceHash: (hash: string | null) => void;
  pageChanged: (page: PageResponse) => void;
  conflict: () => void;
  failed: (message: string) => void;
  diagnostic: (event: string) => void;
  sending: () => boolean;
  clock?: () => string;
  setTimer?: typeof globalThis.setTimeout;
  clearTimer?: typeof globalThis.clearTimeout;
}

export function createSaveController({
  sessionId, current, policy, request, flush, send, sourceHash, pageChanged,
  conflict, failed, diagnostic, sending,
  clock = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
}: Options) {
  const state: SaveState = {
    status: "idle", savedAt: "", baseHash: null, conflict: false, dirty: false, dynamic: false,
  };
  const listeners = new Set<() => void>();
  const pipelines = new Map<string, Promise<boolean>>();
  const backlogs = new Map<string, Map<string, Record<string, unknown>>>();
  const errors = new Map<string, unknown>();
  const delays = new Map<ReturnType<typeof setTimeout>, () => void>();
  let activeSave: Promise<boolean> = Promise.resolve(true);
  let sequence = 0;
  let editSequence = 0;
  let pending = 0;
  let disposed = false;
  let lastSave: { html: string; identity: RenderIdentity } | null = null;
  let clean: { identity: RenderIdentity; sequence: number; editSequence: number } | null = null;
  const matches = (identity: RenderIdentity) => !disposed && !!identity.renderId &&
    identity.key === current().key && identity.renderId === current().renderId &&
    identity.generation === current().generation;
  const publish = () => { if (!disposed) for (const listener of listeners) listener(); };
  const delay = (milliseconds: number) => new Promise<void>((resolve) => {
    const timer = setTimer(() => { delays.delete(timer); resolve(); }, milliseconds);
    delays.set(timer, resolve);
  });
  function cancelRetries() {
    for (const [timer, resolve] of delays) { clearTimer(timer); resolve(); }
    delays.clear();
  }
  const queued = (key: string | null) => !!key &&
    (!!backlogs.get(key)?.size || pipelines.has(key));
  function applyClean() {
    if (!clean || !matches(clean.identity) || clean.sequence !== sequence ||
      clean.editSequence !== editSequence || pending || state.status === "failed" ||
      state.conflict || queued(current().key)) return;
    state.dirty = false;
    state.status = state.savedAt ? "saved" : "idle";
    publish();
  }
  function persistEdit(key: string, original: Record<string, unknown>) {
    if (disposed) return Promise.reject(new Error("Review ended"));
    const identity = current();
    let payload = original;
    if (!payload.renderId && key === identity.key && identity.renderId) {
      payload = {
        ...payload, sessionId, renderId: identity.renderId, generation: identity.generation,
        savePolicy: policy(),
      };
    }
    const id = `${String(payload.label || "")}\u0000${String(payload.kind || "")}`;
    let backlog = backlogs.get(key);
    if (!backlog) { backlog = new Map(); backlogs.set(key, backlog); }
    backlog.set(id, payload);
    const ownedBacklog = backlog;
    const previous = pipelines.get(key) || Promise.resolve(true);
    const flight = previous.then(async () => {
      if (disposed) return false;
      try {
        const result = record(await request(`/api/page/${key}/edit`, {
          method: "POST", body: JSON.stringify(payload),
        }));
        if (ownedBacklog.get(id) === payload) ownedBacklog.delete(id);
        errors.delete(key);
        if (matches(identity)) pageChanged(decodePage(result.page));
        return true;
      } catch (error) {
        errors.set(key, error);
        if (matches(identity)) {
          failed(`${error instanceof Error ? error.message : String(error)}. Your edit is still queued locally.`);
        }
        return false;
      }
    });
    pipelines.set(key, flight);
    void flight.then(() => {
      if (pipelines.get(key) === flight) pipelines.delete(key);
      applyClean();
    });
    return flight;
  }
  async function settleEdits(key: string | null) {
    if (!key) return;
    await pipelines.get(key);
    if (disposed) throw new Error("Review ended");
    if (backlogs.get(key)?.size) {
      const retry = [...(backlogs.get(key)?.values() || [])];
      errors.delete(key);
      for (const payload of retry) void persistEdit(key, payload);
      await pipelines.get(key);
    }
    if (backlogs.get(key)?.size) throw errors.get(key) || new Error("An edit could not be saved");
  }
  async function saveHtml(html: string, identity: RenderIdentity, attempts = 0): Promise<boolean> {
    if (!matches(identity) || state.conflict) return false;
    if (!state.baseHash) {
      if (attempts < 10) { await delay(300); return saveHtml(html, identity, attempts + 1); }
      state.status = "failed";
      publish();
      return false;
    }
    try {
      const result = record(await request(`/api/page/${identity.key}/save`, {
        method: "POST",
        body: JSON.stringify({
          html, baseHash: state.baseHash, renderId: identity.renderId,
          generation: identity.generation, sessionId,
        }),
      }));
      if (!matches(identity)) return false;
      if (result.hash != null && typeof result.hash !== "string") {
        throw new Error("The review server returned an invalid source hash.");
      }
      state.baseHash = typeof result.hash === "string" ? result.hash : null;
      if (state.baseHash) sourceHash(state.baseHash);
      state.status = "saved";
      state.savedAt = clock();
      publish();
      return true;
    } catch (error) {
      if (!matches(identity)) return false;
      if (error && typeof error === "object" && "status" in error && error.status === 409) {
        state.baseHash = null;
        state.status = "idle";
        state.conflict = true;
        publish();
        conflict();
        diagnostic("save-conflict");
        return false;
      }
      state.status = "failed";
      publish();
      if (attempts < 2) { await delay(500); return saveHtml(html, identity, attempts + 1); }
      if (!sending()) failed("Couldn't save. Retry before sending feedback; your edits remain on this page.");
      return false;
    }
  }
  function save(html: string) {
    const identity = current();
    const started = ++sequence;
    lastSave = { html, identity };
    pending++;
    state.dirty = true;
    activeSave = activeSave.then(async () => {
      if (!matches(identity) || state.conflict) return false;
      const saved = await saveHtml(html, identity);
      if (saved && sequence === started) state.dirty = false;
      return saved;
    }).finally(() => { pending--; applyClean(); });
    return activeSave;
  }
  async function flushEdits(strict = false) {
    const key = current().key;
    await flush(strict);
    await settleEdits(key);
  }
  async function barrier() {
    const identity = current();
    await flushEdits(true);
    await activeSave;
    if (state.status === "failed" && !state.conflict && lastSave && matches(lastSave.identity)) {
      await save(lastSave.html);
    }
    await settleEdits(identity.key);
    applyClean();
    if (!matches(identity)) throw new Error("The page changed while saving. Retry on the latest page.");
    if (state.conflict) throw new Error("Resolve the save conflict: the source changed outside this review. Reload latest; your comment drafts will be kept.");
    if (state.status === "failed" || (policy() === "writable" && !state.dynamic && state.dirty)) {
      throw new Error("Your page edits have not finished saving. They have not been sent.");
    }
    if (policy() !== "writable" || state.dynamic) state.dirty = false;
  }
  async function captureStable<T>(capture: () => Promise<T>, signal?: AbortSignal) {
    const identity = current();
    const captured = await capture();
    const capturedSequence = sequence;
    const capturedEditSequence = editSequence;
    await activeSave;
    await settleEdits(identity.key);
    applyClean();
    if (signal?.aborted) throw Object.assign(new Error("Capture cancelled"), { code: "CAPTURE_CANCELLED" });
    if (!matches(identity) || state.conflict || state.status === "failed") {
      throw new Error("The page changed or could not be saved during capture. Recapture the latest version.");
    }
    if (sequence !== capturedSequence || editSequence !== capturedEditSequence) {
      throw new Error("The page changed while its captured edits were saving. Recapture the latest version.");
    }
    return captured;
  }

  return {
    get state(): Readonly<SaveState> { return state; },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    save, persistEdit, settleEdits, flush: flushEdits, barrier, captureStable,
    applyClean, queued, cancelRetries,
    async settled() { await activeSave; },
    markEdit() { editSequence++; },
    markSaving() { state.dirty = true; state.status = "saving"; publish(); },
    markDynamic() { state.dynamic = true; publish(); },
    observeClean() { clean = { identity: current(), sequence, editSequence }; applyClean(); },
    baseline(hash: string | null) { state.baseHash = hash; },
    hold() {
      state.baseHash = null;
      cancelRetries();
      if (state.dirty) state.conflict = true;
      send({ type: "eh:abortSave" });
    },
    markConflict() { state.conflict = true; },
    reset() {
      cancelRetries();
      clean = null;
      lastSave = null;
      sequence++;
      Object.assign(state, { status: "idle", savedAt: "", baseHash: null, conflict: false, dirty: false, dynamic: false });
    },
    async revert() {
      const identity = current();
      send({ type: "eh:abortSave" });
      cancelRetries();
      await activeSave;
      try { await settleEdits(identity.key); }
      catch (error) {
        if (disposed) throw error;
        diagnostic("revert-discards-unpersisted-edits");
      }
      if (!matches(identity)) throw new Error("The page changed before reverting. Retry on the current page.");
      const backlog = identity.key ? backlogs.get(identity.key) : undefined;
      const discarded = new Map(backlog);
      const result = record(await request(`/api/page/${identity.key}/revert`, {
        method: "POST",
        body: JSON.stringify({
          sessionId, renderId: identity.renderId, generation: identity.generation, baseHash: state.baseHash,
        }),
      }));
      // The server can reload the frame before confirming the successful revert.
      for (const [id, payload] of discarded) {
        if (backlog?.get(id) === payload) backlog.delete(id);
      }
      if (identity.key && !backlogs.get(identity.key)?.size) errors.delete(identity.key);
      if (!matches(identity)) return;
      state.status = "idle";
      state.savedAt = "";
      pageChanged(decodePage(result.page));
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelRetries();
      listeners.clear();
    },
  };
}
