const text = (value, limit) => typeof value === "string" ? value.slice(0, limit) : "";

export function normalizeCommentAnchor(kind, anchor) {
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return null;
  if (kind === "element") {
    const selector = text(anchor.selector, 2000);
    if (!selector) return null;
    return {
      selector,
      ...(text(anchor.label, 500) ? { label: text(anchor.label, 500) } : {}),
    };
  }

  const quote = text(anchor.quote, 4000);
  if (!quote) return null;
  return {
    quote,
    ...(text(anchor.prefix, 1000) ? { prefix: text(anchor.prefix, 1000) } : {}),
    ...(text(anchor.suffix, 1000) ? { suffix: text(anchor.suffix, 1000) } : {}),
    ...(text(anchor.selector, 2000) ? { selector: text(anchor.selector, 2000) } : {}),
  };
}
