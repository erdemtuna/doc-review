import { ApiError, record } from "./chrome-api.js";
import { normalizeView } from "./view-identity.js";

export type ResultCaptureScope = {
  reviewId: string; entryKey: string; submissionId: string; pageKey: string;
  sessionId: string; renderId: string; generation: number; sourceHash: string | null;
  view: ReturnType<typeof normalizeView>;
};
export type ResultCaptureFailure = { scope: ResultCaptureScope; message: string };

export function resultCaptureKey(scope: ResultCaptureScope) {
  const view = normalizeView(scope.view);
  return JSON.stringify([scope.reviewId, scope.entryKey, scope.submissionId, scope.pageKey,
    scope.sessionId, scope.renderId, scope.generation, scope.sourceHash,
    view.status, view.tabs.map(({ groupId, tabId, panelId }: { groupId: string; tabId: string; panelId: string }) => [groupId, tabId, panelId])]);
}

export function decodeComparison(value: unknown, mode: "content" | "source") {
  const result = record(value);
  if (typeof result.available !== "boolean" || result.mode !== mode) throw new Error("Invalid comparison response.");
  return result;
}

/** Automatic and explicit captures share one flight for the exact observed scope. */
export function createResultCaptures(options: {
  current(scope: ResultCaptureScope): boolean;
  compare(scope: ResultCaptureScope): Promise<unknown>;
  capture(scope: ResultCaptureScope): Promise<void>;
  refresh(): Promise<unknown>;
  changed(): void;
}) {
  const flights = new Map<string, Promise<void>>();
  const failures = new Map<string, ResultCaptureFailure>();
  const resultKey = (scope: Pick<ResultCaptureScope, "reviewId" | "entryKey" | "submissionId" | "pageKey">) =>
    JSON.stringify([scope.reviewId, scope.entryKey, scope.submissionId, scope.pageKey]);
  const requireCurrent = (scope: ResultCaptureScope) => {
    if (!options.current(scope)) throw new Error("The page or visible view changed during capture. Retry on the current page.");
  };
  const content = async (scope: ResultCaptureScope) => {
    requireCurrent(scope);
    const value = decodeComparison(await options.compare(scope), "content");
    requireCurrent(scope);
    return value;
  };
  function request(scope: ResultCaptureScope): Promise<void> {
    const key = resultCaptureKey(scope), existing = flights.get(key);
    if (existing) return existing;
    const flight = Promise.resolve().then(async () => {
      try {
        let value = await content(scope);
        if (!value.available) {
          try { requireCurrent(scope); await options.capture(scope); }
          catch (error) {
            requireCurrent(scope);
            if (!(error instanceof ApiError && error.status === 409 && error.code === "VERSION_CONFLICT")) throw error;
            value = await content(scope);
            if (!value.available) throw error;
          }
          value = await content(scope);
          requireCurrent(scope);
          await options.refresh();
          requireCurrent(scope);
        }
        if (!value.available) throw new Error(typeof value.reason === "string" ? value.reason : "Rendered Content comparison is unavailable.");
        failures.delete(resultKey(scope));
      } catch (error) {
        if (options.current(scope)) failures.set(resultKey(scope), {
          scope, message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally { options.changed(); }
    }).finally(() => { flights.delete(key); });
    flights.set(key, flight);
    return flight;
  }
  return {
    request,
    confirmContent(scope: Pick<ResultCaptureScope, "reviewId" | "entryKey" | "submissionId" | "pageKey">, value: unknown) {
      if (decodeComparison(value, "content").available && failures.delete(resultKey(scope))) options.changed();
    },
    get failures() { return [...failures.values()]; },
  };
}
