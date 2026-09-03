export const REVIEW_MODES = Object.freeze(["view", "edit"]);

export function normalizeReviewMode(mode) {
  return mode === "edit" ? "edit" : "view";
}

export function savePolicyForPage(page) {
  return page && (page.kind === "url" || page.markdown || page.feedbackOnly)
    ? "feedback-only"
    : "writable";
}

export function reviewConfiguration(page, mode) {
  return {
    mode: normalizeReviewMode(mode),
    savePolicy: savePolicyForPage(page),
  };
}

export function applyBodyReviewMode(body, mode) {
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
export function keepBodyInReviewMode(body, initialMode = "view") {
  let mode = normalizeReviewMode(initialMode);
  let applying = false;
  const enforce = () => {
    if (applying) return;
    applying = true;
    applyBodyReviewMode(body, mode);
    applying = false;
  };
  const Observer = body.ownerDocument.defaultView.MutationObserver;
  const observer = new Observer(enforce);
  observer.observe(body, { attributes: true, attributeFilter: ["contenteditable", "spellcheck"] });
  enforce();
  return {
    get mode() {
      return mode;
    },
    setMode(nextMode) {
      mode = normalizeReviewMode(nextMode);
      enforce();
      return mode;
    },
    disconnect() {
      observer.disconnect();
    },
  };
}
