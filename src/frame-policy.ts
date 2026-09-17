const BASE_SANDBOX = "allow-scripts allow-forms allow-modals";
const LOCALHOST_SANDBOX = `${BASE_SANDBOX} allow-popups allow-downloads allow-same-origin`;

// Exact immutable review modules, not the artifact directory or whole origin.
// Do not add strict-dynamic or a nonce: either would let authored code authorize
// mutable external scripts. The capability in the SDK tag is correlation only.
export const TRUSTED_SDK_MODULE_PATHS = Object.freeze([
  "/sdk.js", "/anchor-text.js", "/click-target.js", "/comment-target.js",
  "/editing.js", "/frame-channel.js", "/icons.js", "/review-mode.js",
  "/semantic-snapshot.js", "/serialize.js", "/positioning.js",
  "/revision-schema.js", "/view-identity.js",
]);

export function interactiveFileCsp(sdkOrigin: string | URL): string {
  const origin = new URL(sdkOrigin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash) {
    throw new TypeError("The SDK origin must be an HTTP origin without a path or credentials.");
  }

  const modules = TRUSTED_SDK_MODULE_PATHS.map((route) => `${origin.origin}${route}`).join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${modules}`,
    "script-src-attr 'unsafe-inline'",
    "worker-src 'none'",
    "child-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "style-src 'unsafe-inline' http: https: data:",
    "img-src http: https: data: blob:",
    "font-src http: https: data:",
    "media-src http: https: data: blob:",
  ].join("; ");
}

export const trustedFileCsp = interactiveFileCsp;

/**
 * Localhost apps need their real origin so their routing and JavaScript work.
 * Files and rendered Markdown do not: An opaque iframe origin prevents them
 * from reading sibling files served by the artifact route.
 */
export function framePolicy(page: unknown, artifactOrigin: string) {
  const keepsOrigin = page !== null && (typeof page === "object" || typeof page === "function") &&
    "kind" in page && page.kind === "url";
  return {
    sandbox: keepsOrigin ? LOCALHOST_SANDBOX : BASE_SANDBOX,
    incomingOrigin: keepsOrigin ? artifactOrigin : "null",
    targetOrigin: keepsOrigin ? artifactOrigin : "*",
  };
}
