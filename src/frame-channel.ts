import type { FrameIdentity } from "./contracts/frame.js";

let channel: FrameIdentity | null = null;

export function initializeChannel(capability: unknown, generation: unknown, pageKey: unknown): void {
  if (channel) throw new Error("Doc Review frame channel is already initialized.");
  channel = {
    capability: String(capability),
    generation: Number(generation),
    pageKey: String(pageKey),
  };
}

export function initializeChannelFromDocument(): void {
  const script = document.querySelector<HTMLScriptElement>("script[data-eh-sdk][data-eh-bootstrap]");
  if (!script) throw new Error("Doc Review frame bootstrap is missing.");
  const capability = script.nonce;
  const generation = Number(script.dataset.generation);
  const pageKey = String(script.dataset.pageKey || "");
  script.remove();
  if (!capability || !Number.isSafeInteger(generation) || !pageKey) {
    throw new Error("Doc Review frame bootstrap is invalid.");
  }
  initializeChannel(capability, generation, pageKey);
}

export function frameMessage<Type>(type: Type, payload?: undefined): { type: Type } & FrameIdentity;
export function frameMessage<Type, Payload extends object>(
  type: Type,
  payload: Payload,
): Omit<Payload, "type" | keyof FrameIdentity> & { type: Type } & FrameIdentity;
export function frameMessage(type: unknown, payload: object = {}) {
  if (!channel) throw new Error("Doc Review frame channel is not initialized.");
  return {
    ...payload,
    type,
    capability: channel.capability,
    generation: channel.generation,
    pageKey: channel.pageKey,
  };
}

export function matchesFrameMessage(message: unknown): boolean {
  return !!(
    channel &&
    message && (typeof message === "object" || typeof message === "function") &&
    "capability" in message && "generation" in message && "pageKey" in message &&
    message.capability === channel.capability &&
    message.generation === channel.generation &&
    message.pageKey === channel.pageKey
  );
}
