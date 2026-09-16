import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse, serialize } from "parse5";
import { atomicWrite } from "./atomic-write.js";

export const TRUST_POLICY_VERSION = 1;
export const TRUSTED_FILE_NOTICE = "Trusted HTML runs this exact saved version's inline scripts and event handlers. Editing is feedback-only. External scripts, application imports, workers, and embedded applications are unsupported; use localhost for those applications. Only the currently visible view is captured.";

const hash = (value) => createHash("sha256").update(value).digest("hex");

/** Hash original file bytes, never a decoded, normalized, or SDK-injected string. */
export function documentSourceHash(originalBytes) {
  if (!(originalBytes instanceof Uint8Array)) throw new TypeError("Original file bytes are required.");
  return hash(originalBytes);
}

function canonicalFile(target) {
  if (typeof target !== "string" || !target || /^https?:/i.test(target)) {
    throw new TypeError("Trust requires an existing local file target.");
  }
  const canonical = fs.realpathSync(path.resolve(target));
  if (!fs.statSync(canonical).isFile()) throw new TypeError("Trust requires a regular file.");
  return canonical;
}

/**
 * This store does not read document contents: callers must pass the exact bytes
 * they serve, and reread the file before approving a previously displayed hash.
 * Separate decision files avoid lost updates between independent documents.
 */
export class DocumentTrustStore {
  constructor({ rootStateDir, policyVersion = TRUST_POLICY_VERSION } = {}) {
    if (typeof rootStateDir !== "string" || !rootStateDir) throw new TypeError("rootStateDir is required.");
    if (!Number.isSafeInteger(policyVersion) || policyVersion < 1) throw new TypeError("Invalid trust policy version.");
    this.directory = path.join(path.resolve(rootStateDir), "document-trust");
    this.policyVersion = policyVersion;
  }

  identity(target, originalBytes) {
    return {
      canonicalTarget: canonicalFile(target),
      sourceHash: documentSourceHash(originalBytes),
      policyVersion: this.policyVersion,
    };
  }

  decisionPath(identity) {
    return path.join(this.directory, `${hash(JSON.stringify(identity))}.json`);
  }

  status(target, originalBytes) {
    const identity = this.identity(target, originalBytes);
    let trusted = false;
    let unavailable;
    try {
      const decision = JSON.parse(fs.readFileSync(this.decisionPath(identity), "utf8"));
      trusted = decision.trusted === true &&
        decision.canonicalTarget === identity.canonicalTarget &&
        decision.sourceHash === identity.sourceHash &&
        decision.policyVersion === identity.policyVersion;
    } catch (error) {
      if (error.code !== "ENOENT") {
        unavailable = "The saved trust decision could not be read. Scripts remain blocked; approve this version again only if you trust it.";
        console.error("[doc-review]", { event: "document-trust-read-failed", code: error.code || "invalid_trust_record" });
      }
    }
    return {
      ...identity,
      trusted,
      trustMode: trusted ? "trusted-file" : "script-blocked",
      savePolicy: trusted ? "feedback-only" : "writable",
      ...(unavailable ? { unavailable } : {}),
    };
  }

  grant(target, originalBytes, expectedSourceHash) {
    const identity = this.identity(target, originalBytes);
    if (expectedSourceHash !== identity.sourceHash) {
      const error = new Error("The saved document changed. Review and approve its current version.");
      error.code = "STALE_TRUST_APPROVAL";
      throw error;
    }
    return this.writeDecision(identity, true);
  }

  revoke(target, originalBytes) {
    return this.writeDecision(this.identity(target, originalBytes), false);
  }

  writeDecision(identity, trusted) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    atomicWrite(this.decisionPath(identity), JSON.stringify({ ...identity, trusted, decidedAt: Date.now() }));
    return {
      ...identity, trusted,
      trustMode: trusted ? "trusted-file" : "script-blocked",
      savePolicy: trusted ? "feedback-only" : "writable",
    };
  }
}

const attr = (node, name) => node.attrs?.find((item) => item.name === name)?.value;

/**
 * Parse before injecting the real SDK. This is a bounded document transform,
 * not a sanitizer: authored inline code is explicitly trusted. The response CSP
 * remains authoritative for dependencies created dynamically by that code.
 */
export function transformTrustedHtml(html) {
  const document = parse(String(html));
  const unsupportedDependencies = [];
  let omitted = 0;
  const report = (kind, source = "") => {
    if (unsupportedDependencies.length < 100) {
      unsupportedDependencies.push({ kind, source: String(source).slice(0, 512) });
    } else omitted += 1;
  };
  const visit = (parent) => {
    parent.childNodes = (parent.childNodes || []).filter((node) => {
      const tag = node.tagName;
      const scriptSource = attr(node, "src") ?? attr(node, "href");
      if (tag === "script" && scriptSource !== undefined) {
        report("external-script", scriptSource);
        return false;
      }
      if (tag === "script" && ["importmap", "speculationrules"].includes((attr(node, "type") || "").trim().toLowerCase())) {
        report("application-import-map");
        return false;
      }
      if (["iframe", "frame", "object", "embed"].includes(tag)) {
        report("embedded-application", attr(node, "src") || attr(node, "data"));
        return false;
      }
      if (tag === "link") {
        const rel = (attr(node, "rel") || "").toLowerCase().split(/\s+/);
        if (rel.includes("modulepreload") || (rel.includes("preload") && ["script", "worker"].includes((attr(node, "as") || "").toLowerCase()))) {
          report("script-preload", attr(node, "href"));
          return false;
        }
      }
      // The reviewed document cannot replace the server's base or script policy.
      if (tag === "base") return false;
      if (tag === "meta" && ["content-security-policy", "refresh"].includes((attr(node, "http-equiv") || "").trim().toLowerCase())) return false;
      if (node.childNodes) visit(node);
      if (node.content) visit(node.content);
      return true;
    });
  };
  visit(document);
  if (omitted) unsupportedDependencies.push({ kind: "additional-dependencies", count: omitted });
  // The review chrome owns policy explanations, never the authored document.
  const notice = TRUSTED_FILE_NOTICE + (unsupportedDependencies.length ? " Unsupported dependency elements were removed." : "");
  const root = document.childNodes.find((node) => node.tagName === "html");
  let body = root.childNodes.find((node) => node.tagName === "body");
  if (!body) {
    body = { nodeName: "body", tagName: "body", attrs: [], namespaceURI: "http://www.w3.org/1999/xhtml", childNodes: [], parentNode: root };
    root.childNodes = root.childNodes.filter((node) => node.tagName !== "frameset");
    root.childNodes.push(body);
  }
  return { html: serialize(document), unsupportedDependencies, notice };
}
