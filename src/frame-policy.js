const BASE_SANDBOX = "allow-scripts allow-forms allow-modals";
const LOCALHOST_SANDBOX = `${BASE_SANDBOX} allow-popups allow-downloads allow-same-origin`;

/**
 * Localhost apps need their real origin so their routing and JavaScript work.
 * Files and rendered Markdown do not: An opaque iframe origin prevents them
 * from reading sibling files served by the artifact route.
 */
export function framePolicy(page, artifactOrigin) {
  const keepsOrigin = page?.kind === "url";
  return {
    sandbox: keepsOrigin ? LOCALHOST_SANDBOX : BASE_SANDBOX,
    incomingOrigin: keepsOrigin ? artifactOrigin : "null",
    targetOrigin: keepsOrigin ? artifactOrigin : "*",
  };
}
