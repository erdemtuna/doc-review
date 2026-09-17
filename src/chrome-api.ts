export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly targets: unknown[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The review server returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

export type Decoder<T> = (value: unknown) => T;
export function createReviewApi({
  token, fetch: request = globalThis.fetch,
}: { token: string; fetch?: typeof globalThis.fetch }) {
  const pending = new Set<AbortController>();
  let disposed = false;

  async function send(path: string, options: RequestInit = {}): Promise<unknown> {
    if (disposed) throw new Error("The review connection is closed.");
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    pending.add(controller);
    try {
      const headers = new Headers(options.headers);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      headers.set("x-doc-review-token", token);
      const response = await request(path, { ...options, headers, signal: controller.signal });
      if (!response.ok) {
        let detail: Record<string, unknown> = {};
        try { detail = record(await response.json()); }
        catch (error) {
          if (controller.signal.aborted) throw error;
          // Preserve the HTTP failure even when the error body is not JSON.
        }
        throw new ApiError(
          typeof detail.error === "string" ? detail.error : `Request failed (${response.status})`,
          response.status,
          typeof detail.code === "string" ? detail.code : undefined,
          Array.isArray(detail.targets) ? detail.targets : [],
        );
      }
      return await response.json();
    } finally {
      pending.delete(controller);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  function requestJson(path: string, options?: RequestInit): Promise<unknown>;
  function requestJson<T>(path: string, options: RequestInit | undefined, decode: Decoder<T>): Promise<T>;
  async function requestJson<T>(path: string, options?: RequestInit, decode?: Decoder<T>) {
    const value = await send(path, options);
    return decode ? decode(value) : value;
  }

  return {
    request: requestJson,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of pending) controller.abort(new Error("Review ended"));
      pending.clear();
    },
  };
}
import { isPageResponse, type PageResponse } from "./contracts/page.js";

export function decodePage(value: unknown): PageResponse {
  if (!isPageResponse(value)) throw new Error("The review server returned an invalid page response.");
  return value;
}
