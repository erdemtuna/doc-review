import { parse, serialize } from "parse5";

export const INTERACTIVE_FILE_NOTICE = "Inline page interactions run automatically. Editing is feedback-only. External scripts, application imports, workers, and embedded applications are unsupported; use localhost for those applications. Only the currently visible view is captured.";

const attr = (node, name) => node.attrs?.find((item) => item.name === name)?.value;
const javascriptTypes = new Set([
  "application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
  "text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1",
  "text/javascript1.2", "text/javascript1.3", "text/javascript1.4", "text/javascript1.5",
  "text/jscript", "text/livescript", "text/x-ecmascript", "text/x-javascript",
]);
const urlAttributes = new Set(["href", "src", "action", "formaction", "data", "background"]);

function dependency(node) {
  const tag = node.tagName;
  const source = attr(node, "src") ?? attr(node, "href");
  if (tag === "script" && source !== undefined) return { kind: "external-script", source };
  if (tag === "script" && ["importmap", "speculationrules"].includes((attr(node, "type") || "").trim().toLowerCase())) {
    return { kind: "application-import-map" };
  }
  if (["iframe", "frame", "object", "embed"].includes(tag)) {
    return { kind: "embedded-application", source: attr(node, "src") || attr(node, "data") };
  }
  if (tag === "link") {
    const rel = (attr(node, "rel") || "").toLowerCase().split(/\s+/);
    if (rel.includes("modulepreload") || (rel.includes("preload") && ["script", "worker"].includes((attr(node, "as") || "").toLowerCase()))) {
      return { kind: "script-preload", source: attr(node, "href") };
    }
  }
  return null;
}

/** Analyze authored source, never an injected SDK or a runtime DOM serialization. */
export function analyzeDocumentExecution(source) {
  if (source instanceof Uint8Array) source = Buffer.from(source).toString("utf8");
  if (typeof source !== "string") throw new TypeError("HTML source bytes or text are required.");
  const document = parse(source);
  let active = false;
  let application = false;
  const visit = (node, includeTemplates = false) => {
    if (dependency(node)) active = application = true;
    if (node.tagName === "script") {
      const type = (attr(node, "type") ?? (attr(node, "language") ? `text/${attr(node, "language")}` : "")).trim().toLowerCase();
      if (!type || type === "module" || javascriptTypes.has(type)) active = true;
    }
    for (const attribute of node.attrs || []) {
      const name = attribute.name.toLowerCase();
      if (/^on[a-z]/.test(name) || (urlAttributes.has(name) &&
          /^javascript:/i.test(attribute.value.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+/, "")))) active = true;
    }
    for (const child of node.childNodes || []) visit(child, includeTemplates);
    if (includeTemplates && node.content) visit(node.content, true);
  };
  visit(document);
  // Dormant template content cannot instantiate itself. Once authored execution
  // exists, include its dependencies in the same bounded application policy.
  if (active) visit(document, true);
  return {
    executionMode: application ? "application" : active ? "interactive" : "static",
    savePolicy: active ? "feedback-only" : "writable",
    feedbackOnly: active,
  };
}

export function documentExecutionPolicy(page, source, preference = "auto") {
  if (page.kind === "url") return { executionMode: "application", savePolicy: "feedback-only", feedbackOnly: true };
  if (page.markdown) return { executionMode: "static", savePolicy: "feedback-only", feedbackOnly: true };
  const policy = analyzeDocumentExecution(source);
  return { ...policy, executionMode: preference === "static" ? "static" : policy.executionMode };
}

/** Keep inline interactions; the response CSP bounds dynamically created dependencies. */
export function transformInteractiveHtml(html) {
  const document = parse(String(html));
  const unsupportedDependencies = [];
  let omitted = 0;
  const visit = (parent) => {
    parent.childNodes = (parent.childNodes || []).filter((node) => {
      const unsupported = dependency(node);
      if (unsupported) {
        if (unsupportedDependencies.length < 100) {
          unsupportedDependencies.push({ ...unsupported, source: String(unsupported.source || "").slice(0, 512) });
        } else omitted += 1;
        return false;
      }
      if (node.tagName === "base") return false;
      if (node.tagName === "meta" && ["content-security-policy", "refresh"].includes((attr(node, "http-equiv") || "").trim().toLowerCase())) return false;
      if (node.childNodes) visit(node);
      if (node.content) visit(node.content);
      return true;
    });
  };
  visit(document);
  if (omitted) unsupportedDependencies.push({ kind: "additional-dependencies", count: omitted });
  const notice = INTERACTIVE_FILE_NOTICE + (unsupportedDependencies.length ? " Unsupported dependency elements were removed." : "");
  const root = document.childNodes.find((node) => node.tagName === "html");
  if (!root.childNodes.some((node) => node.tagName === "body")) {
    const body = { nodeName: "body", tagName: "body", attrs: [], namespaceURI: "http://www.w3.org/1999/xhtml", childNodes: [], parentNode: root };
    root.childNodes = root.childNodes.filter((node) => node.tagName !== "frameset");
    root.childNodes.push(body);
  }
  return { html: serialize(document), unsupportedDependencies, notice };
}
