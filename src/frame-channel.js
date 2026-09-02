let channel = null;

export function initializeChannel(capability, generation, pageKey) {
  if (channel) throw new Error("Human Review frame channel is already initialized.");
  channel = {
    capability: String(capability),
    generation: Number(generation),
    pageKey: String(pageKey),
  };
}

export function initializeChannelFromDocument() {
  const script = document.querySelector("script[data-eh-sdk][data-eh-bootstrap]");
  if (!script) throw new Error("Human Review frame bootstrap is missing.");
  const capability = script.nonce;
  const generation = Number(script.dataset.generation);
  const pageKey = String(script.dataset.pageKey || "");
  script.remove();
  if (!capability || !Number.isSafeInteger(generation) || !pageKey) {
    throw new Error("Human Review frame bootstrap is invalid.");
  }
  initializeChannel(capability, generation, pageKey);
}

export function frameMessage(type, payload = {}) {
  if (!channel) throw new Error("Human Review frame channel is not initialized.");
  return {
    ...payload,
    type,
    capability: channel.capability,
    generation: channel.generation,
    pageKey: channel.pageKey,
  };
}

export function matchesFrameMessage(message) {
  return !!(
    channel &&
    message &&
    message.capability === channel.capability &&
    message.generation === channel.generation &&
    message.pageKey === channel.pageKey
  );
}
