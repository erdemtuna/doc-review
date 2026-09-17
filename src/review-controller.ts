import { decodePage, record } from "./chrome-api.js";
import type { PageResponse } from "./contracts/page.js";

interface Options {
  sessionId: string;
  key: () => string | null;
  generation: () => number;
  request: (path: string, options?: RequestInit) => Promise<unknown>;
  refreshPage: (page: PageResponse, acknowledgement: boolean) => void;
  beforeRefresh: () => void;
  load: (key: string) => Promise<void>;
  reload: () => Promise<void>;
  history: () => Promise<unknown>;
  save: () => Promise<void>;
  suspend: () => void;
  hasDrafts: () => boolean;
  agent: (state: string) => void;
  ended: () => void;
  failed: (error: unknown) => void;
  eventSource?: (url: string) => EventSource;
}

export function createReviewController(options: Options) {
  let source: EventSource | null = null;
  let revision = 0;
  let navigationRevision = 0;
  let disposed = false;
  const cleanup = new Set<() => void>();
  const invalidate = () => { revision++; };
  const report = (error: unknown) => { if (!disposed) options.failed(error); };
  async function refresh() {
    const started = ++revision;
    const key = options.key();
    const generation = options.generation();
    options.beforeRefresh();
    const page = await options.request(`/api/page/${key}?session=${encodeURIComponent(options.sessionId)}`);
    if (disposed || started !== revision || key !== options.key() || generation !== options.generation()) return;
    options.refreshPage(decodePage(page), true);
  }
  function connect() {
    if (disposed || source) return;
    source = (options.eventSource || ((url) => new EventSource(url)))(`/events/${options.sessionId}`);
    source.addEventListener("ended", () => { if (!disposed) options.ended(); });
    source.addEventListener("reload", () => {
      if (disposed) return;
      invalidate();
      void options.reload().catch(report);
    });
    source.addEventListener("history", () => { if (!disposed) void options.history().catch(report); });
    source.addEventListener("agent", (event: MessageEvent<string>) => {
      if (disposed) return;
      try {
        const value = record(JSON.parse(event.data));
        if (typeof value.state !== "string") throw new Error("Invalid agent state event.");
        options.agent(value.state);
      } catch (error) { report(error); }
    });
    source.addEventListener("refresh", () => { if (!disposed) void refresh().catch(report); });
    // EventSource owns reconnect/backoff; reconnect errors are not failed mutations.
    source.onerror = () => {};
  }
  async function navigate(body: { href: string } | { key: string }) {
    if (disposed) throw new Error("Review ended");
    if (options.hasDrafts()) throw new Error("Save or cancel open comment drafts before changing pages");
    const started = ++navigationRevision;
    invalidate();
    const key = options.key();
    const generation = options.generation();
    await options.save();
    if (disposed || started !== navigationRevision || key !== options.key() || generation !== options.generation()) {
      throw new Error("The page changed before navigating. Retry on the current page.");
    }
    if ("key" in body) options.suspend();
    const result = record(await options.request(
      `/api/session/${options.sessionId}/${"key" in body ? "goto" : "navigate"}`,
      { method: "POST", body: JSON.stringify(body) },
    ));
    // A source reload does not undo a navigation already accepted by the server.
    if (disposed || started !== navigationRevision) return;
    const next = "key" in body ? body.key : result.key;
    if (typeof next !== "string") throw new Error("The server returned an invalid navigation target.");
    await options.load(next);
  }
  return {
    connect, refresh, navigate, invalidate,
    own(stop: () => void) { cleanup.add(stop); return stop; },
    dispose() {
      if (disposed) return;
      disposed = true;
      revision++;
      navigationRevision++;
      source?.close();
      source = null;
      for (const stop of cleanup) stop();
      cleanup.clear();
    },
  };
}
