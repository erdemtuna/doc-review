/**
 * Quote-with-context anchoring, in the spirit of the W3C TextQuoteSelector.
 *
 * These functions are pure string maths so they can be unit-tested in Node and
 * shipped verbatim to the browser, where the DOM half of anchoring lives.
 */

export const CONTEXT_PAD = 32;

/** Capture `quote` plus surrounding context so it can be re-found after edits. */
export function buildContext(text, start, end, pad = CONTEXT_PAD) {
  return {
    prefix: text.slice(Math.max(0, start - pad), start),
    quote: text.slice(start, end),
    suffix: text.slice(end, Math.min(text.length, end + pad)),
  };
}

function commonSuffixLength(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
  return n;
}

function commonPrefixLength(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

function occurrences(text, quote) {
  const found = [];
  let at = text.indexOf(quote);
  while (at !== -1) {
    found.push(at);
    at = text.indexOf(quote, at + 1);
  }
  return found;
}

function bestHit(text, hits, quote, prefix, suffix) {
  let best = hits[0];
  let bestScore = -1;
  let candidateCount = 0;
  for (const at of hits) {
    const before = text.slice(Math.max(0, at - prefix.length), at);
    const after = text.slice(at + quote.length, at + quote.length + suffix.length);
    const score = commonSuffixLength(prefix, before) + commonPrefixLength(suffix, after);
    if (score > bestScore) {
      bestScore = score;
      best = at;
      candidateCount = 1;
    } else if (score === bestScore) candidateCount++;
  }
  return { at: best, score: bestScore, candidateCount };
}

const collapse = (s) => String(s || "").replace(/\s+/g, " ");

/** Collapse whitespace runs, keeping a map from each kept char to its original index. */
function collapseWithMap(text) {
  let flat = "";
  const map = [];
  let pendingWs = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (/\s/.test(text[i])) {
      if (pendingWs === -1) pendingWs = i;
      continue;
    }
    if (pendingWs !== -1) {
      flat += " ";
      map.push(pendingWs);
    }
    pendingWs = -1;
    flat += text[i];
    map.push(i);
  }
  if (pendingWs !== -1) {
    flat += " ";
    map.push(pendingWs);
  }
  return { flat, map };
}

/**
 * Locate `ctx.quote` in `text`, using prefix/suffix to disambiguate repeats.
 * Returns a unique match, a missing target, or tied equally plausible candidates.
 */
export function resolveQuote(text, ctx) {
  const quote = ctx && ctx.quote;
  if (!quote) return { state: "missing" };

  // Reformatting (a prettier run, an agent rewrite) reflows whitespace without
  // changing identity. Rank exact and reflowed candidates together so an exact
  // duplicate cannot steal a target whose original whitespace changed.
  const { flat, map } = collapseWithMap(text);
  const flatQuote = collapse(quote).trim();
  if (!flatQuote || !map.length) return { state: "missing" };
  const flatHits = occurrences(flat, flatQuote);
  if (!flatHits.length) return { state: "missing" };
  const prefix = collapse(`${ctx.prefix || ""}${/^\s/.test(quote) ? " " : ""}`);
  const suffix = collapse(`${/\s$/.test(quote) ? " " : ""}${ctx.suffix || ""}`);
  const { at, candidateCount } = bestHit(flat, flatHits, flatQuote, prefix, suffix);
  if (candidateCount > 1) return { state: "ambiguous", candidateCount };
  const start = map[at], end = map[at + flatQuote.length - 1] + 1;
  const exact = occurrences(text, quote).find((offset) => offset <= start && offset + quote.length >= end);
  return exact === undefined ? { state: "found", start, end, exact: false }
    : { state: "found", start: exact, end: exact + quote.length, exact: true };
}

/** Legacy callers cannot distinguish unavailable targets, but must never guess. */
export function findQuote(text, ctx) {
  const result = resolveQuote(text, ctx);
  return result.state === "found" ? { start: result.start, end: result.end, exact: result.exact } : null;
}

/** Collapse runs of whitespace for display in a comment card. */
export function tidy(text, limit = 0) {
  const flat = String(text == null ? "" : text)
    .replace(/\s+/g, " ")
    .trim();
  if (!limit || flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1).trimEnd()}…`;
}

function graphemes(text) {
  if (typeof Intl?.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(text)].map(({ segment }) => segment);
  }
  // Array.from is deterministic and, unlike string slicing, never splits a
  // surrogate pair. Older engines may split a multi-code-point grapheme.
  return Array.from(text);
}

function nearbyHeadBoundary(parts, ideal) {
  for (let index = ideal; index >= Math.max(1, ideal - 8); index -= 1) {
    if (/^\s$/u.test(parts[index - 1])) return index - 1;
  }
  return ideal;
}

function nearbyTailBoundary(parts, ideal) {
  for (let index = ideal; index < Math.min(parts.length - 1, ideal + 8); index += 1) {
    if (/^\s$/u.test(parts[index])) return index + 1;
  }
  return ideal;
}

/**
 * Collapse whitespace and preserve both ends of a long quote. `limit` counts
 * grapheme clusters, including the ellipsis.
 */
export function tidyMiddle(text, limit = 0) {
  const flat = String(text == null ? "" : text)
    .replace(/\s+/g, " ")
    .trim();
  if (!limit) return flat;
  const parts = graphemes(flat);
  if (parts.length <= limit) return flat;
  if (limit <= 1) return "…";

  const available = limit - 1;
  const idealHead = Math.ceil(available * 0.6);
  const idealTailStart = parts.length - (available - idealHead);
  const headEnd = nearbyHeadBoundary(parts, idealHead);
  const tailStart = nearbyTailBoundary(parts, idealTailStart);
  return `${parts.slice(0, headEnd).join("").trimEnd()}…${parts.slice(tailStart).join("").trimStart()}`;
}
