/**
 * Capture the reviewed, live DOM as inert descriptors, never historical HTML.
 * Keep this function self-contained: the SDK can inject its toString() source.
 * Limits fail the entire capture rather than publish a truncated baseline.
 */
export function captureSemanticSnapshot(document) {
  const limits = {
    blocks: 2000, nodes: 30000, text: 1000000, blockText: 100000,
    runs: 1000, depth: 64, attribute: 4096, milliseconds: 1500,
  };
  const started = Date.now();
  let visited = 0;
  let characters = 0;
  const blocks = [];
  const limitations = new Set([
    "hidden-or-virtualized-content", "closed-shadow-roots",
    "cross-origin-frames", "canvas-content", "same-url-image-bytes",
  ]);
  const fail = (reason) => {
    const error = new Error(`Semantic capture unavailable: ${reason}`);
    error.code = "SEMANTIC_CAPTURE_LIMIT";
    error.reason = reason;
    throw error;
  };
  if (!document?.body || !document.defaultView) {
    const error = new Error("Semantic capture requires a live document");
    error.code = "SEMANTIC_CAPTURE_UNAVAILABLE";
    throw error;
  }
  const excluded = new Set([
    "script", "style", "noscript", "template", "head", "input", "textarea",
    "select", "option", "datalist", "output", "embed", "object",
  ]);
  const blockTags = new Set([
    "address", "article", "aside", "blockquote", "body", "button", "caption", "dd",
    "details", "dialog", "div", "dl", "dt", "fieldset", "figcaption", "figure",
    "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "img",
    "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table",
    "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
  ]);
  const structural = new Set([
    "blockquote", "caption", "dd", "details", "dl", "dt", "figcaption",
    "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "li",
    "ol", "pre", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
  ]);
  const markNames = {
    b: "strong", strong: "strong", i: "em", em: "em", u: "underline",
    s: "strike", del: "delete", ins: "insert", code: "code", kbd: "kbd",
    samp: "samp", sub: "sub", sup: "sup", mark: "mark",
  };
  const attributeNames = [
    "id", "href", "src", "alt", "title", "start", "reversed", "value",
    "rowspan", "colspan", "scope", "headers", "type",
  ];
  const tick = (depth) => {
    if (++visited > limits.nodes) fail("nodes");
    if (depth > limits.depth) fail("depth");
    if (visited % 32 === 0 && Date.now() - started > limits.milliseconds) fail("time");
  };
  const bounded = (value) => {
    if (value.length > limits.attribute) fail("attribute");
    characters += value.length;
    if (characters > limits.text) fail("text");
    return value;
  };
  const urlValue = (value) => {
    // References are inert strings, but do not retain inline payloads or credentials.
    if (/^\s*(?:javascript|vbscript|data|blob):/i.test(value)) {
      limitations.add("unsafe-or-inline-url");
      return null;
    }
    try {
      const url = new URL(value, document.baseURI);
      if (["javascript:", "vbscript:", "data:", "blob:"].includes(url.protocol)) {
        limitations.add("unsafe-or-inline-url");
        return null;
      }
      if (url.username || url.password) {
        limitations.add("credentialed-url");
        return null;
      }
    } catch {
      limitations.add("invalid-url");
      return null;
    }
    return bounded(value);
  };
  const preservedRuns = new WeakSet();
  const attributesFor = (element) => {
    const attrs = {};
    for (const key of attributeNames) {
      if (key === "value" && element.localName !== "li") continue;
      if (key === "type" && element.localName !== "button") continue;
      if (!element.hasAttribute(key)) continue;
      const value = element.getAttribute(key);
      const safe = key === "href" || key === "src" ? urlValue(value) : bounded(value);
      if (safe !== null) attrs[key] = safe;
    }
    return attrs;
  };
  const escapeString = (value) => value.replace(/[\\"\n\r\f]/g, (c) => `\\${c.codePointAt(0).toString(16)} `);
  const visibleStyle = (element) => {
    if (element.hasAttribute("hidden") || element.hasAttribute("inert") ||
        element.getAttribute("aria-hidden") === "true") return null;
    const style = document.defaultView.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" &&
      style.visibility !== "collapse" && style.contentVisibility !== "hidden" &&
      style.opacity !== "0" ? style : null;
  };
  const addRun = (block, text, marks, href, preserve) => {
    if (!text) return;
    if (!preserve) {
      text = text.replace(/[\t\n\r\f ]+/g, " ");
      if (/[ \t\r\n\f]$/.test(block.text)) text = text.replace(/^ /, "");
    }
    if (!text) return;
    characters += text.length;
    if (characters > limits.text) fail("text");
    if (block.text.length + text.length > limits.blockText) fail("block-text");
    const previous = block.runs.at(-1);
    if (previous && previous.href === href &&
        previous.marks.length === marks.length && previous.marks.every((m, i) => m === marks[i])) {
      previous.text += text;
      if (preserve) preservedRuns.add(previous);
    } else {
      if (block.runs.length >= limits.runs) fail("runs");
      const run = { text, marks: [...marks], ...(href === undefined ? {} : { href }) };
      if (preserve) preservedRuns.add(run);
      block.runs.push(run);
    }
    block.text += text;
  };
  const walk = (node, context, depth, selector, path, marks, href, preserve) => {
    tick(depth);
    if (node.nodeType === 3) {
      if (context) addRun(context, node.nodeValue, marks, href, preserve);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.localName.toLowerCase();
    if (excluded.has(tag) || node.hasAttribute("data-eh-ui") ||
        node.hasAttribute("data-eh-sdk") || node.hasAttribute("data-eh-route")) return;
    const style = visibleStyle(node);
    if (!style) return;
    if (tag === "iframe") {
      limitations.add("embedded-documents");
      return;
    }
    if (tag === "canvas") return;
    if (tag === "svg" || tag === "video" || tag === "audio") {
      limitations.add("non-text-media");
      return;
    }
    if (node.shadowRoot) limitations.add("open-shadow-roots");
    const reviewMark = tag === "mark" && node.hasAttribute("data-eh-mark");
    let block = context;
    const isBlock = blockTags.has(tag);
    if (isBlock) {
      if (blocks.length >= limits.blocks) fail("blocks");
      const attributes = attributesFor(node);
      // An authored ID is useful evidence, not a globally stable revision ID.
      const ownSelector = attributes.id
        ? `${selector}[id="${escapeString(attributes.id)}"]`
        : selector;
      if (ownSelector.length > limits.attribute) fail("selector");
      block = {
        id: `b${blocks.length + 1}`, tag, selector: ownSelector, text: "",
        attributes, runs: [], path: [...path],
      };
      blocks.push(block);
      const pathEntry = attributes.id ? `${tag}#${attributes.id}` : tag;
      if (pathEntry.length > limits.attribute) fail("path");
      path = [...path, pathEntry];
    }
    const nextMarks = [...marks];
    if (!reviewMark && markNames[tag]) nextMarks.push(markNames[tag]);
    if (style.fontWeight === "bold" || Number(style.fontWeight) >= 600) nextMarks.push("strong");
    if (/^(italic|oblique)/.test(style.fontStyle)) nextMarks.push("em");
    if (style.textDecorationLine?.includes("underline")) nextMarks.push("underline");
    if (style.textDecorationLine?.includes("line-through")) nextMarks.push("strike");
    const normalizedMarks = [...new Set(nextMarks)].sort();
    let nextHref = href;
    if (tag === "a" && node.hasAttribute("href")) {
      const safe = urlValue(node.getAttribute("href"));
      nextHref = safe === null ? undefined : safe;
    }
    const codeWhitespace = preserve || tag === "pre" || tag === "code" ||
      /^(pre|pre-wrap|break-spaces)$/.test(style.whiteSpace);
    if (tag === "br" && block) addRun(block, "\n", normalizedMarks, nextHref, true);
    const siblings = new Map();
    for (const child of node.childNodes) {
      let childSelector = selector;
      if (child.nodeType === 1) {
        const name = child.localName.toLowerCase();
        const index = (siblings.get(name) || 0) + 1;
        siblings.set(name, index);
        childSelector = `${selector} > ${name}:nth-of-type(${index})`;
      }
      // Closed <details> expose only the summary; never capture concealed answers.
      if (tag === "details" && !node.hasAttribute("open") &&
          !(child.nodeType === 1 && child.localName === "summary")) continue;
      walk(child, block, depth + 1, childSelector, path, normalizedMarks, nextHref, codeWhitespace);
    }
    if (isBlock && !codeWhitespace) {
      while (block.runs.length && !block.runs[0].text.trim() &&
             !preservedRuns.has(block.runs[0])) block.runs.shift();
      while (block.runs.length && !block.runs.at(-1).text.trim() &&
             !preservedRuns.has(block.runs.at(-1))) block.runs.pop();
      if (block.runs.length) {
        if (!preservedRuns.has(block.runs[0])) {
          block.runs[0].text = block.runs[0].text.replace(/^[\t\n\r\f ]+/, "");
        }
        if (!preservedRuns.has(block.runs.at(-1))) {
          block.runs.at(-1).text = block.runs.at(-1).text.replace(/[\t\n\r\f ]+$/, "");
        }
      }
      block.text = block.runs.map((run) => run.text).join("");
    }
  };
  walk(document.body, null, 0, "body", [], [], undefined, false);
  if (Date.now() - started > limits.milliseconds) fail("time");
  return {
    version: 1,
    blocks: blocks.filter((block) => block.text || structural.has(block.tag) ||
      block.attributes.id || block.attributes.title),
    limitations: [...limitations].sort(),
  };
}

export const SEMANTIC_SNAPSHOT_SOURCE = `(${captureSemanticSnapshot.toString()})`;
