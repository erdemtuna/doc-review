import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { atomicWrite, Store, resolveAsset } from "./state.js";
import { injectSdk, stripSdk } from "./html-transform.js";
import { isMarkdown, renderMarkdownPage } from "./markdown.js";
import { canonicalTarget, ensureStateDir, localUrl, SERVER_PROTOCOL, serverPath } from "./paths.js";
import { acquireServerLock, releaseServerLock, removeOwnedServerRecord } from "./server-lock.js";
import { invocation } from "./setup.js";
import { agentHandoff } from "./agent-handoff.js";
import { createConversationCapture, HistoryRequestError, historyErrorStatus } from "./history-server.js";
import { documentExecutionPolicy, transformInteractiveHtml } from "./document-execution.js";
import { interactiveFileCsp } from "./frame-policy.js";
import { createConversationController, conversationFailure } from "./conversation-server.js";
import { ContractError } from "./contracts/validation.js";
import { stagedRoot as conversationStagedRoot } from "./conversation-save.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const MAX_BODY = 24 * 1024 * 1024;
const POLL_HEARTBEAT_MS = 15000;
const WATCH_INTERVAL_MS = 400;
const IDLE_SHUTDOWN_MS = Number(process.env.DOC_REVIEW_IDLE_MS || 45 * 60 * 1000);
/** A window with no live connection this long is treated as closed for good. */
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_LOCAL_REDIRECTS = 5;
const RENDER_TTL_MS = 60 * 1000;
/** Generous enough for a dev server's cold compile, but a wedged one can't hang us forever. */
const LOCAL_FETCH_TIMEOUT_MS = 30000;
const MAX_LOCAL_PAGE_BYTES = 24 * 1024 * 1024;

/**
 * File reviews may contain agent-generated or otherwise untrusted JavaScript.
 * Static and recovery frames execute only the nonce-bearing Doc Review SDK;
 * authored scripts and inline event handlers remain inert.
 */
const fileReviewCsp = (nonce) =>
  `script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'self'`;

const hash = (text) => crypto.createHash("sha1").update(text).digest("hex");

/** Read an HTML response with a hard size cap, since text() is unbounded. */
async function readCapped(response, url) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_LOCAL_PAGE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`The page at ${url} is larger than ${MAX_LOCAL_PAGE_BYTES / (1024 * 1024)}MB.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchLocalPage(target, redirects = 0) {
  const url = localUrl(target);
  if (!url) throw new Error("Localhost redirects must use HTTP or HTTPS.");
  let response;
  try {
    response = await fetch(url, {
      redirect: "manual",
      headers: { accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(LOCAL_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new Error(`Localhost did not answer within ${LOCAL_FETCH_TIMEOUT_MS / 1000}s for ${url}`);
    }
    throw err;
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error(`Localhost returned redirect ${response.status} without a location.`);
    if (redirects >= MAX_LOCAL_REDIRECTS) throw new Error("Too many redirects while loading the localhost page.");
    return fetchLocalPage(new URL(location, url).href, redirects + 1);
  }
  if (!response.ok) throw new Error(`Localhost returned ${response.status} for ${url}`);
  const contentType = response.headers.get("content-type") || "";
  if (!/html|xhtml/i.test(contentType)) {
    throw new Error(`Expected an HTML page from localhost, but received ${contentType || "an unknown content type"}.`);
  }
  return { html: await readCapped(response, url), resolvedUrl: response.url || url };
}

export function createServer({ store: suppliedStore, storeOptions, owner = null, renderTtlMs = RENDER_TTL_MS } = {}) {
  const store = suppliedStore || new Store(storeOptions);
  const cliInvocation = invocation();
  const instanceId = owner?.instance_id || crypto.randomBytes(16).toString("hex");

  /**
   * Random per-run secret. Every /api route requires it, so a malicious web
   * page firing blind cross-origin POSTs at 127.0.0.1 cannot write files.
   * The CLI reads it from server.json; the chrome page gets it injected.
   */
  const token = crypto.randomBytes(16).toString("hex");

  /** Browser windows. Ephemeral — nothing durable lives here. */
  const sessions = new Map(); // sessionId -> { id, entryKey, activeKey, generation, renderId, visited, clients:Set<res>, lastSeen }
  const renders = new Map(); // renderId -> current artifact/bootstrap record
  const sseResponses = new Map(); // res -> heartbeat timer
  const watched = new Map(); // key -> { file }
  const lastWritten = new Map(); // key -> content hash doc-review itself wrote
  const sockets = new Set();
  let everListened = false;
  let serverClosed = false;

  let lastActivity = Date.now();
  const touch = () => {
    lastActivity = Date.now();
  };
  const seen = (session) => {
    if (session) session.lastSeen = Date.now();
  };

  // ---------------------------------------------------------------- helpers

  function sessionsForKey(key) {
    return [...sessions.values()].filter((s) => s.activeKey === key);
  }

  function expireRender(renderId) {
    if (!renderId) return;
    const render = renders.get(renderId);
    renders.delete(renderId);
    const session = render ? sessions.get(render.sessionId) : null;
    if (session?.renderId === renderId) session.renderId = null;
  }

  function invalidateSessionRender(session) {
    if (session?.renderId) expireRender(session.renderId);
  }

  function currentRender(renderId) {
    const render = renders.get(renderId);
    if (!render) return null;
    const session = sessions.get(render.sessionId);
    if (
      !session ||
      session.renderId !== renderId ||
      session.activeKey !== render.pageKey ||
      session.generation !== render.generation
    ) {
      expireRender(renderId);
      return null;
    }
    if (Date.now() - render.createdAt > renderTtlMs) {
      if (render.documentState !== "served") {
        expireRender(renderId);
        return null;
      }
      render.capability = null;
    }
    return render;
  }

  function emit(session, event, data) {
    for (const res of session.clients) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`);
    }
  }

  // ------------------------------------------------------------- file watch

  function watchPage(key) {
    if (watched.has(key)) return;
    const page = store.page(key);
    if (!page || page.kind === "url") return;
    watched.set(key, { file: page.file });

    fs.watchFile(page.file, { interval: WATCH_INTERVAL_MS }, () => {
      let html = "";
      try {
        html = fs.readFileSync(page.file, "utf8");
      } catch {
        return;
      }
      const current = hash(html);
      // Our own autosave must never bounce back as a reload.
      if (lastWritten.get(key) === current) return;
      try {
        store.setPristine(key, html, { keepEdits: true });
      } catch (err) {
        console.error(`Could not refresh review baseline for ${page.file}: ${err.message}`);
        return;
      }
      lastWritten.set(key, current);
      for (const session of sessionsForKey(key)) {
        if (session.renderId && currentRender(session.renderId)?.sourceHash === current) continue;
        invalidateSessionRender(session);
        emit(session, "reload", { key });
      }
    });
  }

  // ----------------------------------------------------------------- routes

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("invalid json"));
        }
      });
      req.on("error", reject);
    });
  }

  /** Binary request body (pasted images), capped like readBody. */
  function readRawBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  const json = (res, code, payload) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  };

  const opaqueModuleCors = (req) =>
    req.headers.origin === "null"
      ? { "access-control-allow-origin": "null", vary: "Origin" }
      : {};

  function serveFile(res, file, extraHeaders) {
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
        return;
      }

      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(extraHeaders || {}),
      });
      res.end(buf);
    });
  }

  function pageState(key, session) {
    const page = store.page(key);
    if (!page) return null;
    const currentTarget = page.kind === "url" ? page.url : page.file;
    const policy = sourcePolicy(page, undefined, session);
    return {
      key: page.key,
      kind: page.kind === "url" ? "url" : "file",
      file: currentTarget,
      ...(page.kind === "url" ? { url: page.url } : {}),
      filename: page.kind === "url" ? new URL(page.url).pathname || page.url : path.basename(page.file),
      markdown: page.kind !== "url" && isMarkdown(page.file),
      ...policy,
      ...(page.kind !== "url" && !isMarkdown(page.file)
        ? { executionPreference: session?.executionPreferences?.get(key) || "auto" } : {}),
      comments: [],
      edits: [],
      canRevert: policy.savePolicy === "writable" && typeof page.pristine === "string" && page.pristine.length > 0,
      pollCommand: session?.reviewId
        ? agentHandoff({ reviewId: session.reviewId, entryKey: session.entryKey }, [], cliInvocation).pollCommand
        : "",
      historySupported: true,
    };
  }

  function sourcePolicy(page, bytes, session) {
    const markdown = page.kind !== "url" && isMarkdown(page.file);
    const source = page.kind === "url" || markdown ? undefined : bytes ?? fs.readFileSync(page.file);
    return documentExecutionPolicy({ ...page, markdown }, source, session?.executionPreferences?.get(page.key) || "auto");
  }

  const history = createConversationCapture({ store, currentRender });
  const conversations = createConversationController({
    store, sessions, watchPage, json, emit, currentRender, captureObservation: history.captureObservation,
    sourceWritten(key) {
      lastWritten.set(key, store.data.conversations.writes[key]?.hash ?? null);
    },
  });

  const server = http.createServer(async (req, res) => {
    touch();
    const url = new URL(req.url, "http://127.0.0.1");
    const route = url.pathname;

    try {
      // A request that arrived via a DNS-rebound hostname carries that hostname
      // in Host. Refusing it means a malicious page can never speak to us as if
      // it were same-origin.
      const host = String(req.headers.host || "");
      const port = req.socket.localPort;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        res.writeHead(403, { "content-type": "text/plain" });
        return res.end("Forbidden");
      }

      if (route === "/health") {
        return json(res, 200, { ok: true, pid: process.pid, instance_id: instanceId, protocol: SERVER_PROTOCOL });
      }

      // Every API route needs the per-run token; static assets and the
      // unguessable /s/<id> chrome page do not.
      // Header only — a token in a query string would leak into logs and
      // history. Constant-time compare, so timing can't narrow the secret.
      if (route.startsWith("/api/")) {
        const provided = Buffer.from(String(req.headers["x-doc-review-token"] || ""));
        const expected = Buffer.from(token);
        const ok = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
        if (!ok) return json(res, 401, route.startsWith("/api/conversation")
          ? conversationFailure(new ContractError("UNAUTHORIZED", "Missing or invalid token."))
          : { error: "missing or invalid token" });
      }
      if (await conversations.handle(req, res, url)) return undefined;

      if (route === "/api/session" || route === "/api/poll" || route === "/api/status" ||
          /^\/api\/page\/[^/]+\/(comment|edit|asset|save|revert|send)(\/|$)/.test(route) ||
          /^\/api\/session\/[^/]+\/(end|navigate|history)(\/|$)/.test(route)) {
        return json(res, 410, conversationFailure(new ContractError("WORKFLOW_REMOVED",
          "This workflow has been removed. Open a durable /r/ review with the current doc-review CLI; use /api/conversation and a complete response, never acknowledgement.")));
      }
      if (route.startsWith("/s/")) {
        res.writeHead(410, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        return res.end("This temporary session link is obsolete. Open the target again with the current doc-review CLI.");
      }

      // --- static chrome assets
      if (route === "/chrome.css") return serveFile(res, path.join(here, "ui", "chrome.css"));
      if (route === "/chrome.js") return serveFile(res, path.join(here, "ui", "chrome.js"));
      if (route === "/chrome-session.js") return serveFile(res, path.join(here, "chrome-session.js"));
      if (route === "/chrome-api.js") return serveFile(res, path.join(here, "chrome-api.js"));
      if (route === "/contracts/page.js") return serveFile(res, path.join(here, "contracts", "page.js"));
      if (route === "/frame-host.js") return serveFile(res, path.join(here, "frame-host.js"));
      if (route === "/frame-controller.js") return serveFile(res, path.join(here, "frame-controller.js"));
      if (route === "/save-controller.js") return serveFile(res, path.join(here, "save-controller.js"));
      if (route === "/feedback-controller.js") return serveFile(res, path.join(here, "feedback-controller.js"));
      if (route === "/controller-store.js") return serveFile(res, path.join(here, "controller-store.js"));
      if (route === "/review-controller.js") return serveFile(res, path.join(here, "review-controller.js"));
      if (route === "/icons.js") return serveFile(res, path.join(here, "icons.js"), opaqueModuleCors(req));
      if (route === "/positioning.js") return serveFile(res, path.join(here, "positioning.js"), opaqueModuleCors(req));
      if (route === "/review-mode.js") return serveFile(res, path.join(here, "review-mode.js"), opaqueModuleCors(req));
      if (route === "/comment-target.js") return serveFile(res, path.join(here, "comment-target.js"), opaqueModuleCors(req));
      if (route === "/sdk.js") return serveFile(res, path.join(here, "sdk.js"), opaqueModuleCors(req));
      if (route === "/editing.js") return serveFile(res, path.join(here, "editing.js"), opaqueModuleCors(req));
      if (route === "/anchor-text.js") return serveFile(res, path.join(here, "anchor-text.js"), opaqueModuleCors(req));
      if (route === "/frame-policy.js") return serveFile(res, path.join(here, "frame-policy.js"));
      if (route === "/click-target.js") return serveFile(res, path.join(here, "click-target.js"), opaqueModuleCors(req));
      if (route === "/serialize.js") return serveFile(res, path.join(here, "serialize.js"), opaqueModuleCors(req));
      if (route === "/frame-channel.js") return serveFile(res, path.join(here, "frame-channel.js"), opaqueModuleCors(req));
      if (route === "/thread-anchor-controller.js") return serveFile(res, path.join(here, "thread-anchor-controller.js"), opaqueModuleCors(req));
      if (["/contracts/frame.js", "/contracts/feedback.js", "/contracts/validation.js"].includes(route)) {
        return serveFile(res, path.join(here, ...route.slice(1).split("/")), opaqueModuleCors(req));
      }
      if (route === "/semantic-snapshot.js") return serveFile(res, path.join(here, "semantic-snapshot.js"), opaqueModuleCors(req));
      if (route === "/revision-schema.js") return serveFile(res, path.join(here, "revision-schema.js"), opaqueModuleCors(req));
      if (route === "/history-client.js") return serveFile(res, path.join(here, "history-client.js"));
      if (route === "/view-identity.js") return serveFile(res, path.join(here, "view-identity.js"), opaqueModuleCors(req));
      if (route === "/history-coordinator.js") return serveFile(res, path.join(here, "history-coordinator.js"));
      if (route === "/execution-client.js") return serveFile(res, path.join(here, "execution-client.js"));

      const trustMatch = route.match(/^\/api\/session\/([^/]+)\/trust$/);
      if (trustMatch) {
        return json(res, 410, { error: "Version approvals are no longer used.", code: "trust_workflow_removed" });
      }

      const executionMatch = route.match(/^\/api\/session\/([^/]+)\/execution$/);
      if (executionMatch) {
        if (req.method !== "POST") return json(res, 405, { error: "Method not allowed.", code: "method_not_allowed" });
        const session = sessions.get(executionMatch[1]);
        if (!session) return json(res, 404, { error: "Unknown session.", code: "execution_target_missing" });
        let body;
        try { body = await readBody(req); } catch {
          return json(res, 400, { error: "Invalid execution request.", code: "invalid_execution_request" });
        }
        if (!body || typeof body !== "object" || Array.isArray(body) ||
            typeof body.key !== "string" || !body.key || !["auto", "static"].includes(body.preference)) {
          return json(res, 400, { error: "Expected an HTML page key and auto or static preference.", code: "invalid_execution_request" });
        }
        if (!store.page(body.key)) return json(res, 404, { error: "Unknown page.", code: "execution_target_missing" });
        if (body.key !== session.activeKey) return json(res, 409, { error: "The reviewed target changed.", code: "execution_target_changed" });
        const page = store.page(session.activeKey);
        if (!page || page.kind === "url" || isMarkdown(page.file)) {
          return json(res, 400, { error: "Execution preferences apply only to local HTML.", code: "invalid_execution_request" });
        }
        sourcePolicy(page);
        seen(session);
        const reloadRequired = (session.executionPreferences.get(page.key) || "auto") !== body.preference;
        session.executionPreferences.set(page.key, body.preference);
        if (reloadRequired) {
          invalidateSessionRender(session);
          emit(session, "reload", { key: page.key, reason: "execution-preference-changed" });
        }
        return json(res, 200, { ok: true, page: pageState(page.key, session), reloadRequired });
      }

      // --- the chrome page
      if (route.startsWith("/r/")) {
        let id = route.slice(3);
        if (route.startsWith("/r/")) {
          const record = Object.hasOwn(store.data.conversations.reviews, id) ? store.data.conversations.reviews[id] : null;
          if (!record) return json(res, 404, conversationFailure(new ContractError("NOT_FOUND", "Unknown durable review link.")));
          id = conversations.attach({ reviewId: id, entryKey: record.review.entryKey }).sessionId;
        }
        if (!sessions.has(id)) {
          res.writeHead(404, { "content-type": "text/plain" });
          return res.end("This review session has ended. Run doc-review <target> again.");
        }
        seen(sessions.get(id));
        const shell = fs.readFileSync(path.join(here, "chrome.html"), "utf8");
        res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
        const session = sessions.get(id);
        return res.end(shell.replace("__SESSION_ID__", id).replace("__TOKEN__", token).replace("<body",
          session.reviewId ? `<body data-review="${encodeURIComponent(session.reviewId)}" data-entry="${encodeURIComponent(session.entryKey)}"` : "<body"));
      }

      const renderMatch = route.match(/^\/api\/session\/(\w+)\/render$/);
      if (renderMatch && req.method === "POST") {
        const session = sessions.get(renderMatch[1]);
        if (!session) return json(res, 404, { error: "unknown session" });
        seen(session);
        const body = await readBody(req);
        const generation = Number(body.generation);
        const pageKey = String(body.key || "");
        if (!Number.isSafeInteger(generation) || generation <= session.generation) {
          return json(res, 409, { error: "stale render generation", generation: session.generation });
        }
        if (pageKey !== session.activeKey || !store.page(pageKey)) {
          return json(res, 409, { error: "render page is no longer current" });
        }
        invalidateSessionRender(session);
        const renderId = `r_${crypto.randomBytes(24).toString("hex")}`;
        const capability = crypto.randomBytes(32).toString("base64url");
        const render = {
          renderId,
          capability,
          sessionId: session.id,
          pageKey,
          generation,
          createdAt: Date.now(),
          documentState: "registered",
        };
        session.generation = generation;
        session.renderId = renderId;
        renders.set(renderId, render);
        return json(res, 200, {
          renderId,
          capability,
          generation,
          pageKey,
          path: `/artifact/${renderId}/index.html`,
        });
      }

      const readyMatch = route.match(/^\/api\/session\/(\w+)\/render\/(r_[a-f0-9]+)\/ready$/);
      if (readyMatch && req.method === "POST") {
        const session = sessions.get(readyMatch[1]);
        const render = currentRender(readyMatch[2]);
        if (!session || !render || render.sessionId !== session.id) {
          return json(res, 409, { error: "render is no longer current" });
        }
        const body = await readBody(req);
        const provided = Buffer.from(String(body.capability || ""));
        const expected = Buffer.from(String(render.capability || ""));
        const capabilityMatches = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
        if (
          !capabilityMatches ||
          body.generation !== render.generation ||
          body.pageKey !== render.pageKey
        ) {
          return json(res, 403, { error: "invalid render capability" });
        }
        if (render.documentState !== "served") return json(res, 409, { error: "render has not been served" });
        render.capability = null;
        return json(res, 200, {
          ok: true,
          sourceHash: render.sourceHash ?? null,
          sourceCapturedAt: render.sourceCapturedAt ?? null,
          executionMode: render.executionMode,
          savePolicy: render.savePolicy,
          feedbackOnly: render.savePolicy === "feedback-only",
          executionNotice: render.executionNotice || null,
        });
      }

      // --- the reviewed page itself, plus sibling assets for its render
      if (route.startsWith("/artifact/")) {
        const rest = route.slice("/artifact/".length);
        const slash = rest.indexOf("/");
        const renderId = slash === -1 ? rest : rest.slice(0, slash);
        const asset = slash === -1 ? "" : rest.slice(slash + 1);
        const render = currentRender(renderId);
        const page = render ? store.page(render.pageKey) : null;
        if (!render || !page) {
          res.writeHead(410, { "content-type": "text/plain", "cache-control": "no-store", "referrer-policy": "no-referrer" });
          return res.end("Render expired");
        }
        if (!asset || asset === "index.html") {
          if (render.documentState !== "registered") {
            res.writeHead(410, { "content-type": "text/plain", "cache-control": "no-store", "referrer-policy": "no-referrer" });
            return res.end("Render document already consumed");
          }
          render.documentState = "loading";
          let html = "";
          let sdkOptions = {};
          let extraHeaders = {};
          if (page.kind === "url") {
            Object.assign(render, sourcePolicy(page));
            try {
              const fetched = await fetchLocalPage(page.url);
              html = fetched.html;
              sdkOptions = {
                baseHref: fetched.resolvedUrl,
                nonce: render.capability,
                generation: render.generation,
                pageKey: render.pageKey,
                src: `http://${host}/sdk.js`,
              };
            } catch (err) {
              render.documentState = "registered";
              res.writeHead(502, {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
              });
              return res.end(`Could not load ${page.url}: ${err.message}`);
            }
          } else {
            let originalBytes;
            try {
              originalBytes = fs.readFileSync(page.file);
              html = originalBytes.toString("utf8");
            } catch (error) {
              render.documentState = "registered";
              res.writeHead(error.code === "ENOENT" ? 404 : 500, {
                "content-type": "text/plain",
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
              });
              return res.end(`Could not read document: ${error.message}`);
            }
            render.sourceHash = hash(stripSdk(html));
            render.sourceCapturedAt = new Date().toISOString();
            Object.assign(render, sourcePolicy(page, originalBytes, sessions.get(render.sessionId)));
            // Markdown reviews render on the fly; the source file stays untouched.
            if (isMarkdown(page.file)) html = renderMarkdownPage(html, page.file);
            sdkOptions = {
              nonce: render.capability,
              generation: render.generation,
              pageKey: render.pageKey,
              src: `http://${host}/sdk.js`,
            };
            if (!isMarkdown(page.file) && render.savePolicy === "feedback-only") {
              const transformed = transformInteractiveHtml(html);
              html = transformed.html;
              render.executionNotice = render.executionMode === "static"
                ? transformed.notice.replace("Inline page interactions run automatically.", "Page interactions are disabled for this review.")
                : transformed.notice;
              extraHeaders = { "content-security-policy": render.executionMode === "static"
                ? fileReviewCsp(render.capability) : interactiveFileCsp(`http://${host}`) };
            } else extraHeaders = { "content-security-policy": fileReviewCsp(render.capability) };
          }
          res.writeHead(200, {
            "content-type": MIME[".html"],
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            ...extraHeaders,
          });
          render.documentState = "served";
          return res.end(injectSdk(html, renderId, sdkOptions));
        }
        const stagedPrefix = "__doc_review_paste__/";
        if (asset.startsWith(stagedPrefix)) {
          const name = asset.slice(stagedPrefix.length);
          if (!name || !/^[\w-]+\.(png|jpg|gif|webp)$/.test(name) || path.basename(name) !== name) {
            res.writeHead(403, { "content-type": "text/plain" });
            return res.end("Forbidden");
          }
          // Keep staged previews reachable across source-policy changes.
          return serveFile(res, path.join(conversationStagedRoot(render.pageKey), name));
        }
        const target = resolveAsset(page.file, asset.split("?")[0]);
        if (!target) {
          res.writeHead(403, { "content-type": "text/plain" });
          return res.end("Forbidden");
        }
        return serveFile(res, target);
      }

      // --- page data
      const pageMatch = route.match(/^\/api\/page\/([a-f0-9]+)(?:\/(\w+))?(?:\/(.+))?$/);
      if (pageMatch) {
        const [, key, action, tail] = pageMatch;
        if (!store.page(key)) return json(res, 404, { error: "unknown page" });

        if (!action && req.method === "GET") {
          const sid = url.searchParams.get("session");
          const session = sid ? sessions.get(sid) : null;
          seen(session);
          const body = pageState(key, session);
          if (session) body.others = [];
          return json(res, 200, body);
        }

        // The file as it sits on disk, so the SDK can tell whether the page's
        // own scripts have already rewritten the live DOM.
        if (action === "raw" && req.method === "GET") {
          if (store.page(key).kind === "url") {
            return json(res, 400, { error: "localhost pages do not have a writable raw file" });
          }
          let html = "";
          try {
            html = fs.readFileSync(store.page(key).file, "utf8");
          } catch {
            return json(res, 404, { error: "file is gone" });
          }
          const clean = stripSdk(html);
          // The hash is the save precondition: a later save must name the
          // version it was based on, or it loses to a concurrent rewrite.
          return json(res, 200, { html: clean, hash: hash(clean) });
        }

      }

      // --- which page a window is currently showing
      const bootMatch = route.match(/^\/api\/session\/(\w+)\/page$/);
      if (bootMatch && req.method === "GET") {
        const session = sessions.get(bootMatch[1]);
        if (!session) return json(res, 404, { error: "unknown session" });
        seen(session);
        return json(res, 200, {
          key: session.activeKey,
          generation: session.generation,
          page: pageState(session.activeKey, session),
          others: [],
          ...(session.reviewId ? { review: store.conversations.read({
            operation: "read-review", reviewId: session.reviewId, entryKey: session.entryKey,
          }) } : {}),
        });
      }

      // --- jump straight to a page already in this window
      const gotoMatch = route.match(/^\/api\/session\/(\w+)\/goto$/);
      if (gotoMatch && req.method === "POST") {
        const session = sessions.get(gotoMatch[1]);
        if (!session) return json(res, 404, { error: "unknown session" });
        seen(session);
        const body = await readBody(req);
        if (session.reviewId && !Object.hasOwn(store.data.conversations.reviews[session.reviewId].pages, body.key)) {
          throw new ContractError("SCOPE_MISMATCH", "Join the page through the versioned review before navigating.");
        }
        if (!store.page(body.key)) return json(res, 404, { error: "unknown page" });
        invalidateSessionRender(session);
        session.activeKey = body.key;
        session.visited.add(body.key);
        return json(res, 200, { key: body.key });
      }

      // --- navigation between local files or localhost routes in one window
      const navMatch = route.match(/^\/api\/session\/(\w+)\/(navigate|resolve-target)$/);
      if (navMatch && req.method === "POST") {
        const session = sessions.get(navMatch[1]);
        if (!session) return json(res, 404, { error: "unknown session" });
        const resolveOnly = navMatch[2] === "resolve-target";
        if (session.reviewId && !resolveOnly) throw new ContractError("INVALID_INPUT", "Use versioned join-page followed by goto.");
        seen(session);
        const body = await readBody(req);
        if (resolveOnly && (typeof body.href !== "string" || Object.keys(body).some((key) => key !== "href"))) {
          throw new ContractError("INVALID_INPUT", "Navigation resolution requires only href.");
        }
        const from = store.page(session.activeKey);
        if (!from) return json(res, 404, { error: "unknown page" });
        if (from.kind === "url") {
          const nextUrl = new URL(String(body.href || ""), from.url).href;
          const target = canonicalTarget(nextUrl);
          if (target.kind !== "url") return json(res, 400, { error: "not a localhost route" });
          if (resolveOnly) return json(res, 200, { target: target.value });
          await fetchLocalPage(target.value);
          const page = store.openUrl(target.value);
          invalidateSessionRender(session);
          session.activeKey = page.key;
          session.visited.add(page.key);
          return json(res, 200, { key: page.key, page: pageState(page.key, session) });
        }
        const targetFile = resolveAsset(from.file, String(body.href || "").split(/[?#]/)[0]);
        if (!targetFile || !fs.existsSync(targetFile) || !/\.(x?html?|md|markdown)$/i.test(targetFile)) {
          return json(res, 400, { error: "not a local html or markdown page" });
        }
        if (resolveOnly) return json(res, 200, { target: targetFile });
        const html = fs.readFileSync(targetFile, "utf8");
        const page = store.openPage(targetFile, stripSdk(html));
        lastWritten.set(page.key, hash(stripSdk(html)));
        watchPage(page.key);
        invalidateSessionRender(session);
        session.activeKey = page.key;
        session.visited.add(page.key);
        return json(res, 200, { key: page.key, page: pageState(page.key, session) });
      }

      // --- server-sent events for one window
      if (route.startsWith("/events/")) {
        const session = sessions.get(route.slice("/events/".length));
        if (!session) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(": open\n\n");
        session.clients.add(res);
        seen(session);
        emit(session, "invalidate", { reviewId: session.reviewId });
        const beat = setInterval(() => res.write(": beat\n\n"), POLL_HEARTBEAT_MS);
        sseResponses.set(res, beat);
        req.on("close", () => {
          clearInterval(beat);
          sseResponses.delete(res);
          session.clients.delete(res);
          seen(session);
        });
        return undefined;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found");
    } catch (err) {
      if (err instanceof ContractError) return json(res, err.status, conversationFailure(err));
      if (err instanceof HistoryRequestError) {
        return json(res, err.status, { error: err.message, code: err.code, targets: err.targets });
      }
      return json(res, historyErrorStatus(err), { error: String(err.message || err), ...(err.code ? { code: err.code } : {}) });
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("listening", () => {
    everListened = true;
    serverClosed = false;
  });
  server.on("close", () => {
    serverClosed = true;
  });

  function collectHistoryGarbage() {
    try {
      const removed = store.collectHistoryGarbage();
      if (removed.revisions || removed.blobs) console.info("[doc-review]", { event: "history-pruned", ...removed });
    } catch (error) {
      console.error("[doc-review]", { event: "history-prune-failed", code: error.code || "history_storage_failed" });
    }
  }
  collectHistoryGarbage();

  const sweep = setInterval(() => {
    const now = Date.now();
    collectHistoryGarbage();

    // A window with no SSE client for a while is closed; forget its session.
    for (const [id, session] of sessions) {
      if (session.clients.size === 0 && now - session.lastSeen > SESSION_TTL_MS) {
        invalidateSessionRender(session);
        sessions.delete(id);
      }
    }

    for (const [renderId, render] of renders) {
      if (now - render.createdAt <= renderTtlMs) continue;
      if (render.documentState !== "served") expireRender(renderId);
      else render.capability = null;
    }

    // Stop watching files no remaining session can see.
    for (const [key, entry] of watched) {
      const referenced = [...sessions.values()].some((s) => s.visited.has(key));
      if (!referenced) {
        fs.unwatchFile(entry.file);
        watched.delete(key);
        lastWritten.delete(key);
      }
    }

    // Busy means a connected browser or a listening agent — a session record
    // alone must not keep the process alive forever.
    const busy = [...sessions.values()].some((s) => s.clients.size > 0);
    if (!busy && now - lastActivity > IDLE_SHUTDOWN_MS) {
      void dispose().catch((err) => {
        console.error(`doc-review server shutdown failed: ${err.message}`);
        process.exitCode = 1;
      });
    }
  }, 60000);
  sweep.unref();

  let disposePromise = null;
  const dispose = () => {
    if (disposePromise) return disposePromise;
    disposePromise = (async () => {
      clearInterval(sweep);
      for (const entry of watched.values()) fs.unwatchFile(entry.file);
      watched.clear();
      lastWritten.clear();

      for (const [res, timer] of sseResponses) {
        clearInterval(timer);
        if (!res.writableEnded) res.end();
      }
      sseResponses.clear();
      for (const session of sessions.values()) session.clients.clear();
      sessions.clear();
      renders.clear();

      try {
        // A caller may dispose immediately after server.listen(), before the
        // listening event flips server.listening. Give that pending transition
        // one turn so it can be closed instead of escaping cleanup.
        if (!server.listening && !everListened) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        if (server.listening) {
          const closed = new Promise((resolve, reject) => {
            server.close((err) => {
              if (err && err.code !== "ERR_SERVER_NOT_RUNNING") reject(err);
              else resolve();
            });
          });
          server.closeIdleConnections?.();
          for (const socket of sockets) socket.end();
          server.closeAllConnections?.();
          await closed;
        } else {
          for (const socket of sockets) socket.destroy();
          if (everListened && !serverClosed) {
            await new Promise((resolve) => server.once("close", resolve));
          }
        }
      } finally {
        sockets.clear();
        if (owner) {
          removeOwnedServerRecord(owner);
          releaseServerLock(owner);
        }
      }
    })();
    return disposePromise;
  };

  return { server, store, token, instanceId, dispose };
}

export async function start(port = 0, options = {}) {
  const owner = acquireServerLock(options.lock);
  let review;
  try {
    review = createServer({
      store: options.store,
      storeOptions: options.storeOptions,
      owner,
      renderTtlMs: options.renderTtlMs,
    });
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      review.server.once("error", onError);
      review.server.listen(port, "127.0.0.1", () => {
        review.server.off("error", onError);
        resolve();
      });
    });
    const actual = review.server.address().port;
    ensureStateDir();
    atomicWrite(
      serverPath(),
      JSON.stringify({
        port: actual,
        pid: process.pid,
        instance_id: owner.instance_id,
        token: review.token,
        protocol: SERVER_PROTOCOL,
      })
    );
    try {
      fs.chmodSync(serverPath(), 0o600);
    } catch (err) {
      if (process.platform !== "win32") throw err;
    }
    return { ...review, port: actual };
  } catch (err) {
    if (review) await review.dispose();
    else releaseServerLock(owner);
    throw err;
  }
}
