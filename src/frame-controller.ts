import { record } from "./chrome-api.js";
import type { FrameHost, HostPolicy } from "./frame-host.js";
import type { FrameRenderState, RenderExecution, ReviewMode, SavePolicy } from "./contracts/page.js";
export type RenderIdentity = FrameRenderState;
export type { RenderExecution } from "./contracts/page.js";

type Phase =
  | { kind: "loading" | "confirming" | "ready" | "suspended" }
  | { kind: "failed"; message: string }
  | { kind: "disposed" };

interface FrameState {
  key: string | null;
  generation: number;
  renderId: string | null;
  capability: string | null;
  sourceHash: string | null;
  execution: RenderExecution | null;
  policy: HostPolicy | null;
  phase: Phase;
  readyAt: number;
  configurationGeneration: number | null;
  pendingReload: boolean;
  reloading: boolean;
}

interface Options {
  sessionId: string;
  host: Pick<FrameHost, "onLoad" | "navigate" | "finishReplacement" | "suspend" |
    "ready" | "send" | "acceptsSource" | "setPolicy" | "afterPaint" | "dispose"> &
    { readonly previous: unknown };
  request: (path: string, options?: RequestInit) => Promise<unknown>;
  suspended: () => void;
  transitioning?: () => void;
  failed: (message: string) => void;
  now?: () => number;
  setTimer?: typeof globalThis.setTimeout;
  clearTimer?: typeof globalThis.clearTimeout;
}

export function createFrameController({
  sessionId, host, request, suspended, transitioning = () => {}, failed, now = Date.now,
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
}: Options) {
  const state: FrameState = {
    key: null, generation: 0, renderId: null, capability: null, sourceHash: null,
    execution: null, policy: null, phase: { kind: "loading" }, readyAt: 0,
    configurationGeneration: null, pendingReload: false, reloading: false,
  };
  const listeners = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const flushes = new Map<string, { strict: boolean; settle: (confirmed: boolean) => void }>();
  let readinessTimer: ReturnType<typeof setTimeout> | null = null;
  let configurationTimer: ReturnType<typeof setTimeout> | null = null;
  let readinessRetries = 0;
  let initialLoad = false;
  let readyGeneration: number | null = null;
  let sourceRevision = 0;
  let flushSequence = 0;
  let configuration: {
    mode: string; savePolicy: string; settle: (applied: boolean) => void;
  } | null = null;
  let expectedConfiguration: { mode: string; savePolicy: string } | null = null;
  const alive = () => state.phase.kind !== "disposed";
  const loading = () => state.phase.kind !== "ready";
  const publish = () => { if (alive()) for (const listener of listeners) listener(); };
  const identity = (): RenderIdentity => ({
    key: state.key, renderId: state.renderId, generation: state.generation, loading: loading(),
  });
  const matches = (value: RenderIdentity) => alive() && value.key === state.key &&
    value.generation === state.generation && value.renderId === state.renderId;
  const cancelTimer = (timer: ReturnType<typeof setTimeout> | null) => {
    if (timer !== null) { clearTimer(timer); timers.delete(timer); }
  };
  function later(callback: () => void, delay: number) {
    const timer = setTimer(() => {
      timers.delete(timer);
      if (alive()) callback();
    }, delay);
    timers.add(timer);
    return timer;
  }
  function send(message: Record<string, unknown>) {
    if (!alive() || loading() || !state.capability) return;
    host.send({
      ...message, capability: state.capability, generation: state.generation, pageKey: state.key,
    }, state.policy?.targetOrigin || "*");
  }
  function suspend() {
    if (!alive()) return;
    suspended();
    for (const flush of flushes.values()) flush.settle(false);
    configuration?.settle(false);
    expectedConfiguration = null;
    for (const timer of timers) clearTimer(timer);
    timers.clear();
    readinessTimer = configurationTimer = null;
    state.capability = null;
    state.renderId = null;
    state.execution = null;
    state.phase = { kind: "suspended" };
    readyGeneration = null;
    state.configurationGeneration = null;
    host.suspend();
  }
  function begin(key: string | null = state.key) {
    if (!alive()) throw new Error("Review ended");
    transitioning();
    suspend();
    state.key = key;
    state.generation++;
    state.sourceHash = null;
    sourceRevision++;
    state.readyAt = 0;
    state.phase = { kind: "loading" };
    return state.generation;
  }
  function finishReplacement() {
    cancelTimer(configurationTimer);
    configurationTimer = null;
    host.finishReplacement();
    publish();
  }
  function fail(message: string) {
    if (!alive()) return;
    suspend();
    state.phase = { kind: "failed", message };
    state.pendingReload = true;
    finishReplacement();
    failed(message);
  }
  async function register(key: string | null, generation: number) {
    if (!alive() || !key) throw new Error("No active review page is selected.");
    const value = record(await request(`/api/session/${sessionId}/render`, {
      method: "POST", body: JSON.stringify({ key, generation }),
    }));
    if (!alive() || state.key !== key || state.generation !== generation) return false;
    if (typeof value.renderId !== "string" || typeof value.capability !== "string" ||
      typeof value.path !== "string" || !value.path.startsWith("/artifact/") ||
      (value.sourceHash != null && typeof value.sourceHash !== "string")) {
      throw new Error("The review server returned an invalid frame registration.");
    }
    state.renderId = value.renderId;
    state.capability = value.capability;
    state.sourceHash = typeof value.sourceHash === "string" ? value.sourceHash : null;
    sourceRevision++;
    state.phase = { kind: "loading" };
    initialLoad = true;
    host.navigate(value.path, state.reloading);
    publish();
    readinessTimer = later(() => {
      if (state.key !== key || state.generation !== generation || !loading()) return;
      if (readinessRetries < 1) { readinessRetries++; rotate(); }
      else fail("The reviewed page did not finish loading. Fix the source or local server, then reload.");
    }, 5000);
    return true;
  }
  function rotate() {
    if (!state.key || !alive()) return;
    const key = state.key;
    const generation = begin();
    void register(key, generation).catch((error: unknown) => {
      if (state.key === key && state.generation === generation) {
        fail(error instanceof Error ? error.message : String(error));
      }
    });
  }
  const stopLoad = host.onLoad(() => {
    if (!state.renderId || !state.capability) return;
    if (initialLoad) { initialLoad = false; return; }
    rotate();
  });
  async function ready(): Promise<RenderExecution | null> {
    if (!alive() || !state.renderId || !state.capability || readyGeneration === state.generation) return null;
    cancelTimer(readinessTimer);
    readinessTimer = null;
    readinessRetries = 0;
    readyGeneration = state.generation;
    state.readyAt = now();
    state.phase = { kind: "confirming" };
    const started = identity();
    const revision = sourceRevision;
    try {
      const value = record(await request(`/api/session/${sessionId}/render/${state.renderId}/ready`, {
        method: "POST",
        body: JSON.stringify({ capability: state.capability, generation: state.generation, pageKey: state.key }),
      }));
      if (!matches(started)) return null;
      if ((value.executionMode !== "static" && value.executionMode !== "interactive" && value.executionMode !== "application") ||
        (value.savePolicy !== "writable" && value.savePolicy !== "feedback-only") ||
        (value.sourceHash != null && typeof value.sourceHash !== "string")) {
        throw new Error("The review could not confirm this document's execution policy. Reload before editing.");
      }
      if (revision === sourceRevision) {
        state.sourceHash = typeof value.sourceHash === "string" ? value.sourceHash : null;
      }
      state.execution = {
        executionMode: value.executionMode, savePolicy: value.savePolicy,
        feedbackOnly: value.savePolicy === "feedback-only",
        executionNotice: typeof value.executionNotice === "string" ? value.executionNotice : null,
      };
      state.phase = { kind: "ready" };
      host.ready(state.execution);
      publish();
      return state.execution;
    } catch (error) {
      if (matches(started)) {
        const detail = error instanceof Error ? error.message : String(error);
        const message = "The review could not confirm this document's execution policy. Reload before editing.";
        fail(detail.startsWith(message) ? detail : `${message} ${detail}`);
      }
      return null;
    }
  }
  function configurationTimeout() {
    if (!host.previous) return;
    cancelTimer(configurationTimer);
    const started = identity();
    configurationTimer = later(() => {
      if (matches(started) && host.previous) {
        fail("The page did not confirm its review settings. Reload before continuing.");
      }
    }, 5000);
  }
  function configure(mode: ReviewMode, savePolicy: SavePolicy, wait = true): Promise<boolean> {
    if (loading() || !state.capability || !state.execution) return Promise.resolve(false);
    configuration?.settle(false);
    expectedConfiguration = { mode, savePolicy };
    configurationTimeout();
    if (!wait) {
      send({ type: "eh:configureReview", mode, savePolicy });
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = later(() => settle(false), 3000);
      const settle = (applied: boolean) => {
        if (configuration?.settle !== settle) return;
        configuration = null;
        cancelTimer(timer);
        resolve(applied);
      };
      configuration = { mode, savePolicy, settle };
      send({ type: "eh:configureReview", mode, savePolicy });
    });
  }
  function flush(strict = false): Promise<void> {
    if (loading() || !state.capability) {
      return strict ? Promise.reject(new Error("The page is not ready. Wait for it to load, then retry.")) : Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const requestId = `flush-${++flushSequence}`;
      const timer = later(() => settle(false), strict ? 6000 : 400);
      const settle = (confirmed: boolean) => {
        if (!flushes.delete(requestId)) return;
        cancelTimer(timer);
        if (!confirmed && strict) reject(new Error("The page did not finish saving. Wait for it to load, then retry."));
        else resolve();
      };
      flushes.set(requestId, { strict, settle });
      send({ type: "eh:flush", requestId });
    });
  }

  return {
    get state(): Readonly<FrameState> { return state; },
    get loading() { return loading(); },
    identity, matches, begin, register, suspend, ready, configure, flush, send, fail,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    seedGeneration(generation: number) {
      if (Number.isSafeInteger(generation) && state.renderId === null) state.generation = generation;
    },
    resetRetries() { readinessRetries = 0; },
    setPolicy(policy: HostPolicy) { state.policy = policy; host.setPolicy(policy); },
    setSourceHash(hash: string | null) { state.sourceHash = hash; sourceRevision++; },
    startReload() { state.reloading = true; state.pendingReload = false; },
    restoredScroll() { state.reloading = false; },
    holdReload() { state.pendingReload = true; publish(); },
    accepts(event: Pick<MessageEvent, "source" | "origin" | "data">): event is MessageEvent<Record<string, unknown>> {
      if (!alive() || !host.acceptsSource(event.source) || !state.policy ||
        event.origin !== state.policy.incomingOrigin || !state.capability) return false;
      const value: unknown = event.data;
      if (!value || typeof value !== "object" || !("capability" in value) ||
        !("generation" in value) || !("pageKey" in value) || !("type" in value)) return false;
      return value.capability === state.capability && value.generation === state.generation &&
        value.pageKey === state.key && typeof value.type === "string" &&
        (!loading() || value.type === "eh:ready");
    },
    configured(mode: unknown, savePolicy: unknown) {
      if (!expectedConfiguration || expectedConfiguration.mode !== mode ||
        expectedConfiguration.savePolicy !== savePolicy || loading()) return false;
      // Confirmation is complete even when background tabs pause the visual handoff.
      cancelTimer(configurationTimer);
      configurationTimer = null;
      state.configurationGeneration = state.generation;
      const started = identity();
      const appliedConfiguration = expectedConfiguration;
      if (host.previous) host.afterPaint(() => {
        if (matches(started) && expectedConfiguration === appliedConfiguration && !loading()) finishReplacement();
      });
      if (configuration && configuration.mode === mode && configuration.savePolicy === savePolicy) {
        configuration.settle(true);
      }
      return true;
    },
    flushed(requestId: unknown) {
      if (typeof requestId === "string") flushes.get(requestId)?.settle(true);
      else for (const request of flushes.values()) if (!request.strict) request.settle(true);
    },
    dispose() {
      if (!alive()) return;
      suspend();
      state.phase = { kind: "disposed" };
      stopLoad();
      host.dispose();
      listeners.clear();
    },
  };
}
