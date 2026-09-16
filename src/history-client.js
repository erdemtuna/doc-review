/** A capture is valid only for the exact frame that answered the request. */
export function sameRender(a, b) {
  return !!a && !!b && a.key === b.key && a.renderId === b.renderId &&
    a.generation === b.generation && !!a.renderId;
}

export function createCaptureRequests({ send, current, timeout = 6000 }) {
  const pending = new Map();
  let sequence = 0;
  return {
    request() {
      const identity = { ...current() };
      if (!identity.renderId || identity.loading) return Promise.reject(new Error("The page is not ready to capture"));
      const requestId = `capture-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("The page did not confirm a stable capture. Recapture when it is ready."));
        }, timeout);
        pending.set(requestId, { identity, resolve, reject, timer });
        send({ type: "eh:captureSnapshot", requestId, requireStable: true });
      });
    },
    receive(message) {
      const request = pending.get(message.requestId);
      if (!request) return false;
      pending.delete(message.requestId);
      clearTimeout(request.timer);
      if (!sameRender(request.identity, current())) request.reject(new Error("The page changed during capture. Recapture the latest version."));
      else if (message.error || !message.snapshot) request.reject(new Error(message.error?.message || message.error || "Semantic capture is unavailable"));
      else request.resolve({
        ...request.identity, semantic: message.snapshot, sourceHash: message.sourceHash,
        semanticCapturedAt: Number.isFinite(message.capturedAt) ? message.capturedAt : undefined,
        view: message.view,
      });
      return true;
    },
    cancel(reason = "The page changed during capture") {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(reason));
      }
      pending.clear();
    },
    get size() { return pending.size; },
  };
}

export function draftCount({ compose, commentUi }, note = "") {
  return Number(!!compose) + Number(!!commentUi?.edit) + Number(!!note.trim());
}

export function excerpt(value) {
  if (typeof value === "string") return value;
  if (!value) return "";
  return String(value.text ?? value.excerpt ?? value.content ?? value.label ?? "");
}

export function changeKind(item) {
  const kind = String(item.kind || item.type || "").toLowerCase();
  return kind === "added" || kind === "removed" ? kind : "modified";
}

export function pendingCaptureTarget(round, key, readyAt) {
  if (round?.feedbackStatus !== "acknowledged" ||
      !(readyAt > new Date(round.sentAt ?? round.createdAt).getTime())) return null;
  return round.targets?.find((target) => target.key === key && !target.resultRevisionId &&
    ["pending", "failed"].includes(target.capture?.status || target.captureStatus || "pending")) || null;
}

export function defaultHistoryRound(rounds) {
  return rounds.find((round) => round.completedAt || round.captureStatus === "ready" ||
    ["complete", "completed"].includes(round.status)) || rounds[0] || null;
}

export function comparisonFreshness(comparison, targetKey, current) {
  if (targetKey !== current.key) return "Different page: this saved comparison does not describe the page open in Latest version.";
  if (!current.ready || current.pendingReload || current.dirty) return "Latest version is unverified: reload or finish saving before comparing it with this captured result.";
  if (current.kind === "url") {
    return comparison.capturedSessionId === current.sessionId && comparison.capturedGeneration === current.generation
      ? "Same live render generation; the current DOM is not verified against the captured result. Live content may have changed."
      : "Latest live render is different or unverified. This historical comparison cannot identify exact targets on the live page.";
  }
  if (!comparison.sourceHash || !current.sourceHash) return "Latest source is unverified against this captured result.";
  return comparison.sourceHash === current.sourceHash
    ? "Latest file source matches the captured result. Runtime DOM changes are not verified by a source match."
    : "Latest source is newer or different from the captured result. You are viewing a historical comparison.";
}

export function canJumpToCurrent(item, result, current) {
  return item.confidence === "exact" && !!item.navigation?.selector && !item.unresolved && changeKind(item) !== "removed" &&
    !!result?.renderId && sameRender(result, current);
}
