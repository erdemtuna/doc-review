import { defaultHistoryRound } from "./history-client.js";

const idOf = (round) => round?.roundId || round?.id;
const retryDelays = [1000, 2000, 4000];

export function transientCaptureError(error) {
  return ["CAPTURE_TIMEOUT", "CAPTURE_NOT_READY", "CAPTURE_UNSTABLE", "CAPTURE_BUSY", "VIEW_CHANGED"].includes(error?.code) ||
    [408, 429, 502, 503, 504].includes(error?.status) ||
    (error instanceof TypeError && /fetch|network|load failed/i.test(error.message));
}

export function requireCaptureSuccess(result, key) {
  if (result?.ok === true) return result;
  throw Object.assign(new Error(result?.round?.targets?.find((target) => target.key === key)?.capture?.error ||
    "Content capture is unavailable"), { code: "CAPTURE_UNAVAILABLE" });
}

/** One capture at a time; delayed/finished attempts never block other rounds. */
export function createCaptureCoordinator({ candidates, ready, capture, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const attempts = new Map();
  let timer = null;
  let active = null;
  let epoch = 0;
  let stopped = false;
  function tick() {
    clearTimer(timer);
    timer = null;
    if (stopped || active || !ready()) return;
    const jobs = candidates();
    const job = jobs.find(({ id }) => {
      const attempt = attempts.get(id);
      return !attempt || (!attempt.done && attempt.due <= now());
    });
    if (!job) {
      const due = jobs.map(({ id }) => attempts.get(id)).filter((entry) => entry && !entry.done)
        .reduce((next, entry) => Math.min(next, entry.due), Infinity);
      if (Number.isFinite(due)) timer = setTimer(tick, Math.max(0, due - now()));
      return;
    }
    const attempt = attempts.get(job.id) || { count: 0, due: 0, done: false };
    attempts.set(job.id, attempt);
    attempt.count++;
    const controller = new AbortController();
    const started = epoch;
    active = controller;
    Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      return capture(job, controller.signal);
    }).then(() => { attempt.done = true; }, (error) => {
      if (transientCaptureError(error) && attempt.count <= retryDelays.length) {
        attempt.due = now() + retryDelays[attempt.count - 1];
      } else attempt.done = true;
    }).finally(() => {
      if (started !== epoch) return;
      active = null;
      tick();
    });
  }
  return {
    tick,
    reset() {
      epoch++;
      active?.abort();
      active = null;
      clearTimer(timer);
      timer = null;
      attempts.clear();
    },
    stop() {
      this.reset();
      stopped = true;
    },
    get busy() { return !!active; },
  };
}

export function historyPresentation({ loading, error, round, target, comparison = {}, failure }) {
  const modes = ["content", "source"].filter((mode) => comparison[mode]?.available === true);
  if (loading && !round) return { state: "loading", message: "Loading comparison…", modes };
  if (error && !round) return { state: "failed", message: "History could not be loaded. Try again.", modes };
  if (!round) return { state: "empty", message: "No review rounds yet. Send feedback to start.", modes };
  if (modes.length) {
    const partial = modes.length < 2 || !!target?.baselineUnavailable || !!target?.resultUnavailable;
    return { state: partial ? "partial" : "available", modes,
      message: modes.includes("content")
        ? partial ? "Content available; some comparison coverage is missing." : "Comparison ready."
        : "Source available. Content is pending or unavailable." };
  }
  if (failure || error || target?.capture?.status === "failed") {
    return { state: "failed", message: "Content capture failed. Feedback is safe; retry when ready.", modes };
  }
  if (target?.capture?.status === "unavailable" || target?.resultRevisionId) {
    return { state: "partial", message: "Comparison unavailable for these snapshots. Feedback is safe.", modes };
  }
  return { state: "waiting", message: round.feedbackStatus === "acknowledged"
    ? "Waiting for a stable result snapshot. You can keep reviewing."
    : "Waiting for the agent's result.", modes };
}

/** Fetch into local values, then publish atomically so selectors never relabel stale content. */
export function createHistoryController({ request, changed = () => {}, refreshed = () => {} }) {
  const state = {
    rounds: [], selectedId: null, round: null, targetKey: null, mode: "content", preferredMode: null,
    index: 0, loading: false, error: null, captureBusy: false, finalizing: false, failures: new Map(),
  };
  let revision = 0;
  const targets = new Map();
  async function refresh() {
    const current = ++revision;
    state.loading = true;
    state.error = null;
    if (state.round && (idOf(state.round) !== state.selectedId ||
      !state.round.targets?.some((target) => target.key === state.targetKey && target.comparison))) state.round = null;
    changed();
    try {
      const collection = await request("");
      if (current !== revision) return false;
      state.rounds = collection.rounds || [];
      if (!state.rounds.some((round) => idOf(round) === state.selectedId)) {
        state.selectedId = idOf(defaultHistoryRound(state.rounds)) || null;
      }
      const selectedId = state.selectedId;
      let round = null;
      let targetKey = state.targetKey || targets.get(selectedId);
      if (selectedId) {
        const detail = await request(`/${selectedId}`);
        if (current !== revision) return false;
        round = detail.round || detail;
        const summary = state.rounds.find((item) => idOf(item) === selectedId);
        for (const target of round.targets || []) {
          target.filename ||= summary?.targets?.find((item) => item.key === target.key)?.filename;
        }
        const target = round.targets?.find((item) => item.key === targetKey) || round.targets?.[0];
        targetKey = target?.key || null;
        if (target) {
          const results = await Promise.allSettled(["content", "source"].map((mode) =>
            request(`/${selectedId}/compare?key=${encodeURIComponent(target.key)}&mode=${mode}`)));
          if (current !== revision) return false;
          target.comparison = Object.fromEntries(["content", "source"].map((mode, index) =>
            [mode, results[index].status === "fulfilled" ? results[index].value
              : { available: false, counts: null, reason: results[index].reason.message }]));
          if (results.every((result) => result.status === "rejected")) state.error = results[0].reason;
        }
      }
      state.round = round;
      state.targetKey = targetKey;
      if (selectedId) targets.set(selectedId, targetKey);
      state.loading = false;
      changed();
      refreshed();
      return true;
    } catch (error) {
      if (current !== revision) return false;
      state.error = error;
      state.loading = false;
      changed();
      return false;
    }
  }
  return {
    state, refresh,
    selectRound(id) {
      state.selectedId = id;
      state.targetKey = targets.get(id) || null;
      state.index = 0;
      return refresh();
    },
    selectTarget(key) { state.targetKey = key; state.index = 0; return refresh(); },
    cancel() { revision++; state.loading = false; },
  };
}

/** Optional capture cannot veto delivery; a failed refresh cannot masquerade as failed Send. */
export async function deliverFeedback({ save, capture, deliver, committed, refresh }) {
  await save();
  let snapshot = null;
  let captureFailure = null;
  try { snapshot = await capture(); } catch (error) { captureFailure = error; }
  await deliver(snapshot);
  committed();
  let refreshFailure = null;
  try { if (await refresh() === false) refreshFailure = new Error("History could not be refreshed"); }
  catch (error) { refreshFailure = error; }
  return { captureFailure, refreshFailure };
}
