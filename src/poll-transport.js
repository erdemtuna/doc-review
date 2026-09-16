import http from "node:http";
import { performance } from "node:perf_hooks";

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

export async function pollOnce(server, target, ackId, deadline) {
  deadline.check();
  const query = `target=${encodeURIComponent(target)}${ackId ? `&ack=${encodeURIComponent(ackId)}` : ""}`;
  const response = await requestRaw(server, {
    method: "GET",
    path: `/api/poll?${query}`,
  }, undefined, {
    timeoutMs: deadline.remaining(),
    time: deadline.time,
    timeoutCode: "POLL_DEADLINE",
  });
  // Graceful server disposal ends the space heartbeats without a JSON payload.
  // HTTP is complete, but this poll was interrupted just like a dropped socket.
  if (response.status === 200 && /^ +$/.test(response.raw)) {
    throw codedError("The server ended the poll before sending feedback.", "ERR_STREAM_PREMATURE_CLOSE");
  }
  const batch = parseServerResponse(response);
  if (!["feedback", "closed", "timeout"].includes(batch.status) ||
      (batch.status === "feedback" && (typeof batch.batch_id !== "string" || !batch.batch_id || !Array.isArray(batch.pages)))) {
    throw codedError("Malformed polling response from the doc-review server.", "SERVER_RESPONSE_INVALID");
  }
  return batch;
}

export async function pollUntilDeadline({
  target,
  ackId = "",
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
      // An uncertain send must repeat the supplied receipt, never a newer ID.
      const batch = await poll(server, target, ackId, deadline);
      deadline.check();
      return batch;
    } catch (err) {
      if (err.code === "POLL_DEADLINE" || deadline.remaining() <= 0) {
        return {
          status: "timeout",
          waited_seconds: deadline.seconds,
          next_step: "No feedback yet. Run the same poll command again to keep waiting, or `doc-review status <target>` to check without blocking.",
        };
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
