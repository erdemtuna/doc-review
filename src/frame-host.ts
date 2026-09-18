export interface HostPolicy {
  sandbox: string;
  incomingOrigin: string;
  targetOrigin: string;
}

export type HostExecution = Pick<RenderExecution, "executionMode" | "savePolicy" | "executionNotice">;

export function createFrameHost(initial: HTMLIFrameElement, artifactOrigin: string) {
  let current = initial;
  let previous: HTMLIFrameElement | null = null;
  let disposed = false;
  const loadListeners = new Set<() => void>();
  const focusListeners = new Set<() => void>();
  const removalListeners = new Set<() => void>();
  const detach = new Map<HTMLIFrameElement, () => void>();
  const paintFrames = new Set<number>();
  function paint(callback: () => void) {
    const id = requestAnimationFrame(() => {
      paintFrames.delete(id);
      if (!disposed) callback();
    });
    paintFrames.add(id);
  }

  function attach(frame: HTMLIFrameElement) {
    const loaded = () => {
      if (!disposed && frame === current) for (const listener of loadListeners) listener();
    };
    const focused = () => {
      if (!disposed && frame === current) for (const listener of focusListeners) listener();
    };
    frame.addEventListener("load", loaded);
    frame.addEventListener("focus", focused);
    detach.set(frame, () => {
      frame.removeEventListener("load", loaded);
      frame.removeEventListener("focus", focused);
      detach.delete(frame);
    });
  }

  function remove(frame: HTMLIFrameElement) {
    detach.get(frame)?.();
    frame.remove();
  }

  attach(initial);
  return {
    get current() { return current; },
    get previous() { return previous; },
    get currentWindow() { return current.contentWindow; },
    get previousWindow() { return previous?.contentWindow || null; },
    onPreviousRemoved(listener: () => void) {
      removalListeners.add(listener);
      return () => { removalListeners.delete(listener); };
    },
    get visibleExecution(): HostExecution | null {
      const visible = previous || current;
      const savePolicy = visible.dataset.savePolicy;
      const executionMode = visible.dataset.executionMode;
      if ((savePolicy !== "writable" && savePolicy !== "feedback-only") ||
        (executionMode !== "static" && executionMode !== "interactive" && executionMode !== "application")) return null;
      return {
        executionMode,
        savePolicy,
        executionNotice: visible.dataset.executionNotice || null,
      };
    },
    onLoad(listener: () => void) {
      loadListeners.add(listener);
      return () => { loadListeners.delete(listener); };
    },
    onFocus(listener: () => void) {
      focusListeners.add(listener);
      return () => { focusListeners.delete(listener); };
    },
    setPolicy(policy: HostPolicy) { current.setAttribute("sandbox", policy.sandbox); },
    navigate(path: string, replacing: boolean) {
      if (disposed) return;
      const url = `${artifactOrigin}${path}`;
      if (replacing && current.hasAttribute("src")) {
        const next = current.cloneNode(false);
        const Frame = current.ownerDocument.defaultView?.HTMLIFrameElement;
        if (!Frame || !(next instanceof Frame)) throw new Error("Invalid review iframe.");
        next.src = url;
        next.removeAttribute("data-sdk-ready");
        delete next.dataset.executionMode;
        delete next.dataset.savePolicy;
        delete next.dataset.executionNotice;
        if (previous) remove(current);
        else {
          previous = current;
          previous.id = "previousFrame";
          previous.inert = true;
          previous.setAttribute("aria-hidden", "true");
          previous.tabIndex = -1;
        }
        current = next;
        current.dataset.replacing = "true";
        attach(current);
        previous.after(current);
      }
      if (current.src !== url) current.src = url;
    },
    finishReplacement() {
      if (previous) remove(previous);
      previous = null;
      for (const listener of removalListeners) listener();
      delete current.dataset.replacing;
    },
    suspend() { current.removeAttribute("data-sdk-ready"); },
    ready(execution: HostExecution) {
      current.dataset.sdkReady = "true";
      current.dataset.executionMode = execution.executionMode;
      current.dataset.savePolicy = execution.savePolicy;
      current.dataset.executionNotice = execution.executionNotice || "";
    },
    send(message: unknown, origin: string) {
      current.contentWindow?.postMessage(message, origin);
    },
    acceptsSource(source: MessageEventSource | null) {
      return !!current.contentWindow && source === current.contentWindow;
    },
    afterPaint(callback: () => void) {
      const target = current;
      paint(() => paint(() => {
        if (!disposed && target === current) callback();
      }));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const stop of [...detach.values()]) stop();
      for (const id of paintFrames) cancelAnimationFrame(id);
      paintFrames.clear();
      loadListeners.clear();
      focusListeners.clear();
      removalListeners.clear();
    },
  };
}

export type FrameHost = ReturnType<typeof createFrameHost>;
import type { RenderExecution } from "./contracts/page.js";
