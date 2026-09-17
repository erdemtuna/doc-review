import { record } from "./chrome-api.js";
import { deliverFeedback } from "./history-coordinator.js";
import type { RenderIdentity } from "./frame-controller.js";
import type { createSaveController } from "./save-controller.js";

interface Snapshot {
  semantic?: unknown;
  semanticCapturedAt?: number;
  view?: unknown;
  sourceHash?: string | null;
}
type DeliveryState =
  | { phase: "idle" | "saving" | "delivering" | "delivered" }
  | { phase: "failed" | "uncertain"; message: string };
interface Options {
  sessionId: string;
  current: () => RenderIdentity;
  sourceHash: () => string | null;
  save: ReturnType<typeof createSaveController>;
  policy: () => string;
  capture: () => Promise<Snapshot>;
  refresh: () => Promise<unknown>;
  request: (path: string, options?: RequestInit) => Promise<unknown>;
  note: () => string;
  clearNote: (sent: string) => void;
  pauseCapture: () => void;
  resumeCapture: () => void;
  failed: (message: string) => void;
  warning: (message: string) => void;
  announce: (message: string) => void;
}

export function createFeedbackController(options: Options) {
  const listeners = new Set<() => void>();
  let state: DeliveryState = { phase: "idle" };
  let disposed = false;
  let inFlight = false;
  let sent = false;
  const busy = () => inFlight;
  const publish = () => { if (!disposed) for (const listener of listeners) listener(); };
  const current = (identity: RenderIdentity) => !disposed && !!identity.renderId &&
    identity.key === options.current().key && identity.generation === options.current().generation &&
    identity.renderId === options.current().renderId;

  return {
    get state(): Readonly<DeliveryState> { return state; },
    get sending() { return busy(); },
    get sent() { return sent; },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    clearSent() { sent = false; if (!busy()) state = { phase: "idle" }; },
    async send() {
      if (busy() || disposed) return;
      const identity = options.current();
      const sentNote = options.note();
      inFlight = true;
      state = { phase: "saving" };
      options.pauseCapture();
      publish();
      let delivering = false;
      let delivered = false;
      try {
        const outcome = await deliverFeedback({
          save: () => options.save.barrier(),
          capture: () => options.capture(),
          deliver: async (snapshot: Snapshot | null) => {
            await options.save.settled();
            await options.save.settleEdits(identity.key);
            if (!current(identity)) throw new Error("The page changed before sending. Retry on the current page.");
            if (options.save.state.conflict || options.save.state.status === "failed" ||
              (options.policy() === "writable" && !options.save.state.dynamic && options.save.state.dirty)) {
              throw new Error("Your page edits have not finished saving.");
            }
            delivering = true;
            state = { phase: "delivering" };
            publish();
            const result = record(await options.request(`/api/page/${identity.key}/send`, {
              method: "POST",
              body: JSON.stringify({
                sessionId: options.sessionId, note: sentNote.trim(),
                history: {
                  renderId: identity.renderId, generation: identity.generation,
                  semantic: snapshot?.semantic || null,
                  semanticCapturedAt: snapshot?.semanticCapturedAt, view: snapshot?.view,
                  expectedSourceHash: snapshot?.sourceHash || options.save.state.baseHash || options.sourceHash(),
                  allowUnavailable: true,
                },
              }),
            }));
            if (result.ok === false) {
              throw new Error(typeof result.error === "string" ? result.error : "Feedback delivery was not confirmed");
            }
          },
          committed() {
            delivered = true;
            sent = true;
            state = { phase: "delivered" };
            if (!disposed) options.clearNote(sentNote);
          },
          refresh: () => disposed ? Promise.resolve(false) : options.refresh(),
        });
        if (disposed) return;
        if (outcome.refreshFailure) options.warning("Feedback sent. History could not be refreshed; your feedback does not need to be sent again.");
        else if (outcome.captureFailure) options.announce("Feedback sent. Content comparison may be incomplete.");
      } catch (error) {
        if (disposed) return;
        const detail = error instanceof Error ? error.message : String(error);
        const message = delivered ? "Feedback sent. History is temporarily unavailable; do not send it again."
          : !delivering ? `Feedback not sent: ${detail} Your feedback and drafts are still here.`
            : `Feedback delivery was not confirmed: ${detail} No automatic retry was made. Check the agent before sending again.`;
        state = delivered ? { phase: "delivered" }
          : { phase: delivering ? "uncertain" : "failed", message };
        options.failed(message);
      } finally {
        inFlight = false;
        publish();
        if (!disposed) options.resumeCapture();
      }
    },
    dispose() { disposed = true; listeners.clear(); },
  };
}
