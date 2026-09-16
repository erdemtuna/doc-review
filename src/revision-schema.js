export const REVISION_SCHEMA_VERSION = 1;
export const HISTORY_SCHEMA_VERSION = 1;
export const COMPLETED_ROUNDS_TO_KEEP = 5;
export const CAPTURE_LEASE_MS = 60_000;
export const ROUND_FEEDBACK_STATUSES = Object.freeze(["queued", "delivered", "acknowledged", "superseded"]);
export const ROUND_CAPTURE_STATUSES = Object.freeze(["pending", "ready", "partial", "failed", "cancelled"]);
export const REVISION_LIMITS = Object.freeze({
  sourceBytes: 8 * 1024 * 1024,
  semanticBytes: 4 * 1024 * 1024,
  totalBytes: 12 * 1024 * 1024,
  blocks: 2_000,
  textCharacters: 100_000,
  totalTextCharacters: 1_000_000,
  runsPerBlock: 1_000,
  depth: 64,
  attributeCharacters: 4_096,
  selectorCharacters: 4_096,
});

const encoder = new TextEncoder();
const TAGS = new Set([
  "article", "section", "main", "header", "footer", "aside", "nav", "div",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "blockquote", "pre", "code",
  "ul", "ol", "li", "dl", "dt", "dd", "table", "caption", "thead", "tbody",
  "tfoot", "tr", "th", "td", "figure", "figcaption", "img", "a", "span",
  "strong", "em", "b", "i", "u", "s", "del", "ins", "sub", "sup", "br", "hr",
  "details", "summary", "body", "address", "button", "dialog", "fieldset",
]);
const ATTRIBUTES = new Set([
  "id", "href", "src", "alt", "title", "start", "reversed", "value",
  "colspan", "rowspan", "scope", "headers", "type",
]);
const MARKS = new Set([
  "strong", "em", "underline", "strike", "delete", "insert",
  "code", "kbd", "samp", "sub", "sup", "mark",
]);

export function revisionError(message, code = "INVALID_REVISION") {
  const status = code === "SNAPSHOT_TOO_LARGE" ? 413
    : code === "CAPTURE_CONFLICT" || code === "CAPTURE_FINALIZED" ? 409
      : code === "SNAPSHOT_CORRUPT" ? 500 : 400;
  return Object.assign(new Error(message), { code, status });
}

export function utf8Bytes(value) {
  return encoder.encode(value).byteLength;
}

export function normalizeRevisionLimits(value = {}) {
  object(value, "snapshot limits");
  const limits = { ...REVISION_LIMITS };
  for (const [key, limit] of Object.entries(value)) {
    if (!(key in limits) || !Number.isSafeInteger(limit) || limit < 0) throw revisionError("Invalid snapshot limit.");
    limits[key] = limit;
  }
  return limits;
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw revisionError(`Invalid ${name}.`);
}

function boundedString(value, name, limit, { empty = true } = {}) {
  if (typeof value !== "string" || (!empty && !value)) {
    throw revisionError(`Invalid ${name}.`);
  }
  if (value.length > limit) throw revisionError(`${name} exceeds the size limit.`, "SNAPSHOT_TOO_LARGE");
  return value;
}

function referenceUrl(value) {
  if (/^(?:javascript|vbscript|data|blob):/i.test(value.replace(/[\u0000-\u0020\u007f]+/g, ""))) {
    throw revisionError("Executable or embedded URLs cannot be captured.");
  }
  try {
    const url = new URL(value, "https://doc-review.invalid/");
    if (url.username || url.password) throw revisionError("URL credentials cannot be captured.");
  } catch (error) {
    if (error.code === "INVALID_REVISION") throw error;
    throw revisionError("Invalid semantic URL.");
  }
  return value;
}

export function isRevisionId(value) {
  return typeof value === "string" && /^v_[a-f0-9]{64}$/.test(value);
}

export function normalizeSemanticSnapshot(value, limits = REVISION_LIMITS) {
  limits = normalizeRevisionLimits(limits);
  object(value, "semantic snapshot");
  if (value.version !== REVISION_SCHEMA_VERSION || !Array.isArray(value.blocks)) {
    throw revisionError("Unsupported semantic snapshot schema.");
  }
  if (value.blocks.length > limits.blocks) throw revisionError("Semantic snapshot has too many blocks.", "SNAPSHOT_TOO_LARGE");
  const ids = new Set();
  let totalText = 0;
  const blocks = value.blocks.map((block) => {
    object(block, "semantic block");
    if ("html" in block || "children" in block) throw revisionError("Semantic blocks must be flat and cannot contain HTML.");
    const id = boundedString(block.id, "block id", 200, { empty: false });
    if (ids.has(id)) throw revisionError("Duplicate semantic block id.");
    ids.add(id);
    if (!TAGS.has(block.tag)) throw revisionError("Unsupported semantic block tag.");
    if (block.path !== undefined && typeof block.path !== "string" && !Array.isArray(block.path)) {
      throw revisionError("Invalid block path.");
    }
    const normalized = {
      id,
      tag: block.tag,
      text: boundedString(block.text, "block text", limits.textCharacters),
      path: Array.isArray(block.path)
        ? block.path.map((part) => boundedString(part, "block path entry", limits.selectorCharacters))
        : block.path ? [boundedString(block.path, "block path", limits.selectorCharacters)] : [],
      selector: boundedString(block.selector ?? "", "block selector", limits.selectorCharacters),
      attributes: {},
      runs: [],
    };
    if (Array.isArray(normalized.path) && normalized.path.length > limits.depth) {
      throw revisionError("Semantic path exceeds the depth limit.", "SNAPSHOT_TOO_LARGE");
    }
    totalText += normalized.text.length;
    if (totalText > limits.totalTextCharacters) throw revisionError("Semantic text exceeds the size limit.", "SNAPSHOT_TOO_LARGE");
    if (block.parentId !== undefined && block.parentId !== null) {
      normalized.parentId = boundedString(block.parentId, "parent id", 200, { empty: false });
      if (normalized.parentId === id || !ids.has(normalized.parentId)) {
        throw revisionError("Semantic parents must precede their children.");
      }
    }
    if (block.attrs !== undefined && block.attributes !== undefined) throw revisionError("Ambiguous semantic attributes.");
    const attributes = block.attributes !== undefined ? block.attributes : block.attrs;
    if (attributes !== undefined) {
      object(attributes, "block attributes");
      normalized.attributes = {};
      for (const name of Object.keys(attributes).sort()) {
        if (!ATTRIBUTES.has(name) || (name === "value" && block.tag !== "li") ||
            (name === "type" && block.tag !== "button")) throw revisionError("Unsupported semantic attribute.");
        const attribute = boundedString(attributes[name], "semantic attribute", limits.attributeCharacters);
        normalized.attributes[name] = name === "src" || name === "href" ? referenceUrl(attribute) : attribute;
      }
    }
    if (block.runs !== undefined) {
      if (!Array.isArray(block.runs)) throw revisionError("Invalid inline runs.");
      if (block.runs.length > limits.runsPerBlock) throw revisionError("Too many inline runs.", "SNAPSHOT_TOO_LARGE");
      let runText = 0;
      normalized.runs = block.runs.map((run) => {
        object(run, "inline run");
        if ("html" in run || !Array.isArray(run.marks) || run.marks.length > MARKS.size ||
            run.marks.some((mark) => !MARKS.has(mark))) throw revisionError("Invalid inline formatting.");
        const text = boundedString(run.text, "inline text", limits.textCharacters);
        runText += text.length;
        if (runText > limits.textCharacters) throw revisionError("Inline text exceeds the size limit.", "SNAPSHOT_TOO_LARGE");
        return {
          text,
          marks: [...new Set(run.marks)].sort(),
          ...(run.href !== undefined ? { href: referenceUrl(boundedString(run.href, "inline link", limits.attributeCharacters)) } : {}),
        };
      });
      if (normalized.runs.map((run) => run.text).join("") !== normalized.text) {
        throw revisionError("Inline runs do not match the block text.");
      }
    } else if (normalized.text) normalized.runs = [{ text: normalized.text, marks: [] }];
    return normalized;
  });
  const snapshot = { version: REVISION_SCHEMA_VERSION, blocks, limitations: [] };
  if (value.limitations !== undefined) {
    if (!Array.isArray(value.limitations) || value.limitations.length > 100) throw revisionError("Invalid semantic limitations.");
    snapshot.limitations = [...new Set(value.limitations.map((code) => boundedString(code, "limitation", 500)))];
  }
  if (utf8Bytes(JSON.stringify(snapshot)) > limits.semanticBytes) {
    throw revisionError("Semantic snapshot exceeds the size limit.", "SNAPSHOT_TOO_LARGE");
  }
  return snapshot;
}

export function normalizeCaptureProvenance(value = {}) {
  object(value, "capture provenance");
  const result = {};
  for (const name of ["sessionId", "pageKey", "sourceHash", "sourceRevisionId", "captureId"]) {
    if (value[name] !== undefined) result[name] = boundedString(value[name], name, 200);
  }
  if (value.generation !== undefined) {
    if (!Number.isSafeInteger(value.generation) || value.generation < 0) throw revisionError("Invalid capture generation.");
    result.generation = value.generation;
  }
  if (value.feedbackOnlyEdits !== undefined) result.feedbackOnlyEdits = value.feedbackOnlyEdits === true;
  if (value.trustedInteractive !== undefined) {
    if (typeof value.trustedInteractive !== "boolean") throw revisionError("Invalid trusted capture provenance.");
    result.trustedInteractive = value.trustedInteractive;
  }
  return result;
}

export function normalizeHistoryTargets(targets) {
  if (!Array.isArray(targets) || !targets.length || targets.length > 100) throw revisionError("Invalid history targets.");
  const keys = new Set();
  return targets.map((target) => {
    object(target, "history target");
    const key = boundedString(target.key, "document key", 200, { empty: false });
    if (keys.has(key)) throw revisionError("Duplicate history target.");
    keys.add(key);
    if (target.baselineRevisionId !== undefined && !isRevisionId(target.baselineRevisionId)) {
      throw revisionError("Invalid baseline revision ID.");
    }
    if (!target.baselineRevisionId && !target.baselineUnavailable) {
      throw revisionError("A target needs a baseline or an explicit unavailable reason.");
    }
    if (target.baselineRevisionId && target.baselineUnavailable) throw revisionError("Baseline availability is ambiguous.");
    return {
      key,
      ...(target.ownerSessionId !== undefined ? {
        ownerSessionId: boundedString(target.ownerSessionId, "baseline owner session", 200, { empty: false }),
      } : {}),
      ...(target.baselineRevisionId ? { baselineRevisionId: target.baselineRevisionId } : {
        baselineUnavailable: boundedString(target.baselineUnavailable, "baseline unavailable reason", 500, { empty: false }),
      }),
    };
  });
}
