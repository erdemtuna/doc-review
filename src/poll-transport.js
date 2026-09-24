import http from "node:http";
import { performance } from "node:perf_hooks";
import { acceptedMutationSchema } from "./contracts/feedback.js";
import { pollResponseSchema } from "./contracts/page-boundary.js";
import { ContractError, failureSchema } from "./contracts/validation.js";

export const DEFAULT_POLL_SECONDS = 12 * 60 * 60;
const MAX_TIMER_MS = 2 ** 31 - 1;
const clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

export function createDeadline(seconds = DEFAULT_POLL_SECONDS, time = clock) {
  const end = time.now() + seconds * 1000;
  const remaining = () => Math.max(0, end - time.now());
  const check = () => {
    if (remaining() <= 0) throw codedError("Polling deadline reached.", "POLL_DEADLINE");
  };
  return {
    seconds,
    time,
    remaining,
    check,
    async sleep(ms) {
      check();
      await new Promise((resolve) => time.setTimeout(resolve, Math.min(ms, remaining(), MAX_TIMER_MS)));
      check();
    },
  };
}

export function isRecoverableTransportError(err) {
  return new Set([
    "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH",
    "ENETUNREACH", "ENETDOWN", "ECONNABORTED", "ERR_STREAM_PREMATURE_CLOSE",
    "SERVER_START_PENDING",
  ]).has(err?.code);
}

/**
 * An absolute response deadline, not a socket-idle timeout: heartbeats and
 * partially received JSON must not extend the caller's waiting budget.
 */
export function requestRaw(server, options, body, {
  timeoutMs = options.timeout,
  time = clock,
  signal,
  timeoutCode = "ETIMEDOUT",
  makeRequest = http.request,
} = {}) {
  return new Promise((resolve, reject) => {
    let req;
    let res;
    let timer;
    let done = false;
    let ended = false;
    let raw = "";
    const expires = timeoutMs == null ? null : time.now() + timeoutMs;
    const premature = () => codedError("The server closed an incomplete response.", "ERR_STREAM_PREMATURE_CLOSE");
    const cleanupResponse = () => {
      res?.removeListener("data", onData);
      res?.removeListener("end", onEnd);
      res?.removeListener("aborted", onAborted);
    };
    const settle = (err, value) => {
      if (done) return;
      done = true;
      time.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      cleanupResponse();
      // Keep error handlers until close: destroying a socket may emit one last
      // error asynchronously. Close removes the remaining owned listeners.
      res?.destroy();
      req?.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const onError = (err) => settle(err);
    const onData = (chunk) => { raw += chunk; };
    const onEnd = () => {
      ended = true;
      if (!res.complete) return settle(premature());
      settle(null, { status: res.statusCode, raw });
    };
    const onAborted = () => settle(premature());
    const onResponseClose = () => {
      if (!ended) settle(premature());
      cleanupResponse();
      res.removeListener("error", onError);
      res.removeListener("close", onResponseClose);
    };
    const onRequestClose = () => {
      if (!done) settle(premature());
      req.removeListener("error", onError);
      req.removeListener("close", onRequestClose);
      req.removeListener("response", onResponse);
    };
    const onAbort = () => settle(codedError("Polling cancelled.", "ABORT_ERR"));
    const armTimer = () => {
      const left = expires - time.now();
      if (left <= 0) return settle(codedError("Polling request timed out.", timeoutCode));
      timer = time.setTimeout(armTimer, Math.min(left, MAX_TIMER_MS));
    };
    const onResponse = (response) => {
      res = response;
      if (done) {
        res.destroy();
        return;
      }
      res.setEncoding("utf8");
      res.on("data", onData);
      res.on("end", onEnd);
      res.on("error", onError);
      res.on("aborted", onAborted);
      res.on("close", onResponseClose);
    };
    try {
      if (signal?.aborted) return onAbort();
      const port = typeof server === "number" ? server : server.port;
      const token = typeof server === "number" ? "" : server.token || "";
      const { timeout: _timeout, ...requestOptions } = options;
      req = makeRequest({
        host: "127.0.0.1",
        port,
        ...requestOptions,
        headers: { ...(token ? { "x-doc-review-token": token } : {}), ...(options.headers || {}) },
      });
      req.on("response", onResponse);
      req.on("error", onError);
      req.on("close", onRequestClose);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (expires !== null) armTimer();
      if (done) return;
      if (body) req.write(JSON.stringify(body));
      req.end();
    } catch (err) {
      settle(err);
    }
  });
}

export function parseServerResponse(response) {
  if (response.status !== 200) {
    let detail = "";
    try { detail = JSON.parse(response.raw).error || ""; } catch { /* HTTP status is sufficient. */ }
    throw codedError(
      `Doc-review server returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
      "SERVER_RESPONSE_ERROR",
    );
  }
  try {
    const parsed = JSON.parse(response.raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw codedError("Malformed response from the doc-review server. End the review and restart the server.", "SERVER_RESPONSE_INVALID");
  }
}

export async function conversationOnce(server, body, decoder, deadline, route = "/api/conversation") {
  deadline.check();
  const response = await requestRaw(server, {
    method: "POST", path: route, headers: { "content-type": "application/json" },
  }, body, {
    timeoutMs: Math.min(15000, deadline.remaining()),
    time: deadline.time,
  });
  let parsed;
  try { parsed = JSON.parse(response.raw); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw codedError("Malformed conversation response.", "SERVER_RESPONSE_INVALID");
  }
  if (response.status !== 200) {
    let failure;
    try { failure = failureSchema.parse(parsed); }
    catch { throw codedError(`Invalid error response (HTTP ${response.status}).`, "SERVER_RESPONSE_INVALID"); }
    if (failure.error.status !== response.status) throw codedError("HTTP and error status disagree.", "SERVER_RESPONSE_INVALID");
    throw new ContractError(failure.error.code, failure.error.message);
  }
  try { return decoder.parse(parsed); }
  catch { throw codedError("Conversation response does not match its schema.", "SERVER_RESPONSE_INVALID"); }
}

export const pollOnce = (server, reference, deadline) =>
  conversationOnce(server, { operation: "poll", ...reference }, pollResponseSchema, deadline);

export async function pollUntilDeadline({
  reference,
  deadline = createDeadline(),
  discover,
  poll = pollOnce,
  diagnostic = () => {},
}) {
  let failures = 0;
  for (;;) {
    try {
      deadline.check();
      const server = await discover(deadline);
      deadline.check();
      const result = await poll(server, reference, deadline);
      if (result.review.reviewId !== reference.reviewId || result.review.entryKey !== reference.entryKey) {
        throw codedError("Polling response belongs to another review.", "SERVER_RESPONSE_INVALID");
      }
      if (result.state !== "waiting") return result;
      failures = 0;
      await deadline.sleep(500);
    } catch (err) {
      if (err.code === "POLL_DEADLINE" || deadline.remaining() <= 0) {
        return { state: "timeout", ...reference };
      }
      if (!isRecoverableTransportError(err)) throw err;
      diagnostic(`Lost the connection (${err.message}); retrying.\n`);
      try {
        await deadline.sleep(Math.min(250 * 2 ** Math.min(failures++, 5), 5000));
      } catch (sleepError) {
        if (sleepError.code !== "POLL_DEADLINE") throw sleepError;
      }
    }
  }
}

/** Retry transport only. This function never opens or edits a reviewed source. */
export async function mutationUntilDeadline({
  body, deadline = createDeadline(60), discover, send = conversationOnce, diagnostic = () => {},
}) {
  const request = structuredClone(body);
  let failures = 0;
  let reason = "unavailable";
  let attempted = false;
  const unknown = (detail = "") => Object.assign(new Error(
    `Acceptance is unknown. Reuse the identical request; do not repeat source edits.${detail ? ` ${detail}` : ""}`,
  ), { code: "TRANSPORT_UNKNOWN", outcome: { state: "unknown", requestId: request.requestId, reason } });
  for (;;) {
    try {
      deadline.check();
      const server = await discover(deadline);
      deadline.check();
      attempted = true;
      const accepted = await send(server, request, acceptedMutationSchema, deadline);
      const receipt = acceptedMutationSchema.parse(accepted).receipt;
      if (receipt.requestId !== request.requestId || receipt.operation !== request.operation ||
          (request.reviewId !== undefined && receipt.reviewId !== request.reviewId) ||
          (request.entryKey !== undefined && receipt.entryKey !== request.entryKey) ||
          (request.submissionId !== undefined && receipt.value.submissionId !== request.submissionId)) {
        throw codedError("Receipt does not match the submitted request.", "SERVER_RESPONSE_INVALID");
      }
      return accepted;
    } catch (error) {
      if (error instanceof ContractError && !["STATE_PERSIST_FAILED", "INTERNAL_ERROR"].includes(error.code)) throw error;
      const recoverable = isRecoverableTransportError(error) || ["SERVER_RESPONSE_INVALID", "STATE_PERSIST_FAILED"].includes(error.code);
      if (!recoverable && error.code !== "POLL_DEADLINE") {
        if (attempted) throw unknown(error.message);
        throw error;
      }
      if (error.code !== "POLL_DEADLINE") reason = error.code === "SERVER_RESPONSE_INVALID" ? "invalid-response" :
        error.code === "ETIMEDOUT" ? "timeout" : error.code === "STATE_PERSIST_FAILED" ? "unavailable" : "disconnected";
      if (error.code === "POLL_DEADLINE" || deadline.remaining() <= 0) {
        throw unknown();
      }
      diagnostic(`Response uncertain (${error.message}); retrying the identical request.\n`);
      try { await deadline.sleep(Math.min(250 * 2 ** Math.min(failures++, 5), 5000)); }
      catch (sleepError) {
        if (sleepError.code !== "POLL_DEADLINE") throw sleepError;
      }
    }
  }
}

export async function readUntilDeadline({ body, decoder, deadline = createDeadline(60), discover, diagnostic = () => {}, route }) {
  let failures = 0;
  for (;;) {
    try {
      deadline.check();
      return await conversationOnce(await discover(deadline), body, decoder, deadline, route);
    } catch (error) {
      if (error.code === "POLL_DEADLINE" || deadline.remaining() <= 0) throw error;
      if (!isRecoverableTransportError(error)) throw error;
      diagnostic(`Read interrupted (${error.message}); retrying.\n`);
      await deadline.sleep(Math.min(250 * 2 ** Math.min(failures++, 5), 5000));
    }
  }
}
