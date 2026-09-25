// Match only the tag itself: injection adds no whitespace, so stripping must
// not eat any either, or open→save would not round-trip byte-identically.
const SDK_TAG_RE = /<script[^>]*\bdata-eh-sdk\b[^>]*\bdata-eh-bootstrap\b[^>]*><\/script>/gi;
const SDK_BASE_RE = /<base[^>]*\bdata-eh-sdk\b[^>]*>/gi;
const SDK_ROUTE_RE = /<script[^>]*\bdata-eh-route\b[^>]*>[\s\S]*?<\/script>/gi;
const ASSET_TAG_RE = /<(script|link|img|source|video|audio|iframe|embed|object)\b[^>]*>/gi;
const ASSET_ATTR_RE = /(\s)(src|href|poster|data)=(['"])(.*?)\3/gi;

function absolutizeAssets(html, baseHref) {
  return String(html).replace(ASSET_TAG_RE, (tag) =>
    tag.replace(ASSET_ATTR_RE, (attribute, space, name, quote, value) => {
      if (!value || /^(?:data|blob|javascript):/i.test(value) || value.startsWith("#")) return attribute;
      const absolute = new URL(value, baseHref).href;
      return `${space}${name}=${quote}${absolute}${quote}`;
    })
  );
}

/**
 * Add the review bootstrap tags. Everything else about the artifact is left
 * byte-identical, so the saved file renders the same standalone.
 */
export function injectSdk(
  html,
  key,
  { src = "/sdk.js", baseHref = "", nonce = "", generation = 0, pageKey = key } = {}
) {
  const clean = stripSdk(html);
  const escapedSrc = String(src).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const escapedNonce = String(nonce).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const escapedPageKey = String(pageKey).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const nonceAttr = escapedNonce ? ` nonce="${escapedNonce}"` : "";
  const tag =
    `<script data-eh-sdk data-eh-bootstrap type="module"${nonceAttr}` +
    ` data-generation="${Number(generation)}" data-page-key="${escapedPageKey}" src="${escapedSrc}"></script>`;
  let prepared = clean;
  if (baseHref) {
    const url = new URL(baseHref);
    const route = JSON.stringify(`${url.pathname}${url.search}${url.hash}`).replace(/</g, "\\u003c");
    const restoreRoute = `<script data-eh-route>history.replaceState(null,"",location.origin+${route})</script>`;
    prepared = absolutizeAssets(prepared, baseHref);
    prepared = /<head(?:\s[^>]*)?>/i.test(prepared)
      ? prepared.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${restoreRoute}`)
      : `${restoreRoute}${prepared}`;
  }
  // Consume only the document's safe opening prefix. Inserting before <html>
  // invents an implicit head and redistributes authored whitespace into it.
  // Never search ahead for <head>: it could be inside unclosed raw text.
  const doctype = /^(\uFEFF?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>)/i.exec(prepared);
  let at = doctype ? doctype[0].length : 0;
  const trivia = () => {
    const match = /^(?:[\t\n\f\r ]|<!--[\s\S]*?-->)+/.exec(prepared.slice(at));
    if (match) at += match[0].length;
  };
  const opening = (name) => {
    const match = new RegExp(`^<${name}(?=[\\t\\n\\f\\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*>`, "i").exec(prepared.slice(at));
    if (match) at += match[0].length;
    return !!match;
  };
  trivia();
  if (opening("html")) trivia();
  opening("head");
  return `${prepared.slice(0, at)}${tag}${prepared.slice(at)}`;
}

/** Remove any injected tag, so a file saved with one never keeps it. */
export function stripSdk(html) {
  return String(html).replace(SDK_TAG_RE, "").replace(SDK_BASE_RE, "").replace(SDK_ROUTE_RE, "");
}

export function hasSdk(html) {
  SDK_TAG_RE.lastIndex = 0;
  return SDK_TAG_RE.test(String(html));
}
