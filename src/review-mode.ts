import type { ReviewConfiguration, ReviewMode, SavePolicy } from "./contracts/page.js";

interface BodyAttributes {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  hasAttribute(name: string): boolean;
  removeAttribute(name: string): void;
}

interface BodyObserver<Body> {
  observe(target: Body, options: { attributes: boolean; attributeFilter: string[] }): void;
  disconnect(): void;
}

interface BodyDocument<Body> {
  defaultView: {
    MutationObserver: new (callback: () => void) => BodyObserver<Body>;
  } | null;
}

export const REVIEW_MODES: readonly ReviewMode[] = Object.freeze(["view", "edit"]);

export function normalizeReviewMode(mode?: unknown): ReviewMode {
  return mode === "edit" ? "edit" : "view";
}

export function savePolicyForPage(page?: unknown): SavePolicy {
  return page && (
    (typeof page === "object" || typeof page === "function") &&
    (("savePolicy" in page && page.savePolicy === "feedback-only") ||
    ("kind" in page && page.kind === "url") ||
    ("markdown" in page && page.markdown) || ("feedbackOnly" in page && page.feedbackOnly)))
    ? "feedback-only"
    : "writable";
}

export function reviewConfiguration(page: unknown, mode: unknown): ReviewConfiguration {
  return {
    mode: normalizeReviewMode(mode),
    savePolicy: savePolicyForPage(page),
  };
}

export function applyBodyReviewMode(body: BodyAttributes, mode: unknown): ReviewMode {
  const normalized = normalizeReviewMode(mode);
  if (normalized === "edit") {
    if (body.getAttribute("contenteditable") !== "true") body.setAttribute("contenteditable", "true");
    if (body.getAttribute("spellcheck") !== "false") body.setAttribute("spellcheck", "false");
  } else {
    if (body.hasAttribute("contenteditable")) body.removeAttribute("contenteditable");
    if (body.hasAttribute("spellcheck")) body.removeAttribute("spellcheck");
  }
  return normalized;
}

/** Keep the active mode intact when an application hydrates and rewrites body attributes. */
export function keepBodyInReviewMode<Body extends BodyAttributes>(
  body: Body & { ownerDocument: BodyDocument<NoInfer<Body>> },
  initialMode: unknown = "view",
) {
  let mode = normalizeReviewMode(initialMode);
  let applying = false;
  const enforce = () => {
    if (applying) return;
    applying = true;
    applyBodyReviewMode(body, mode);
    applying = false;
  };
  const view = body.ownerDocument.defaultView;
  if (!view) throw new TypeError("The review body must belong to a window.");
  const Observer = view.MutationObserver;
  const observer = new Observer(enforce);
  observer.observe(body, { attributes: true, attributeFilter: ["contenteditable", "spellcheck"] });
  enforce();
  return {
    get mode() {
      return mode;
    },
    setMode(nextMode: unknown) {
      mode = normalizeReviewMode(nextMode);
      enforce();
      return mode;
    },
    disconnect() {
      observer.disconnect();
    },
  };
}
