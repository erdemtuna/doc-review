import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse, parseFragment, serialize, serializeOuter } from "parse5";
import { documentExecutionPolicy } from "./document-execution.js";
import { isMarkdown } from "./markdown.js";
import { stripSdk } from "./html-transform.js";
import { stateDir } from "./paths.js";
import { reject } from "./contracts/validation.js";
import { REVISION_LIMITS } from "./revision-schema.js";

export const sourceHash = (text) => crypto.createHash("sha1").update(text).digest("hex");
export const stagedRoot = (key) => path.join(stateDir(), "conversation-pasted", key);

export function readSource(page) {
  if (page.kind === "url") return { text: null, hash: null, writable: false };
  try {
    if (fs.statSync(page.file).size > REVISION_LIMITS.sourceBytes) reject("SNAPSHOT_TOO_LARGE", "Source exceeds snapshot safety bound.");
    const text = fs.readFileSync(page.file, "utf8");
    if (Buffer.byteLength(text) > REVISION_LIMITS.sourceBytes) reject("SNAPSHOT_TOO_LARGE", "Source exceeds snapshot safety bound.");
    const policy = documentExecutionPolicy({ ...page, markdown: isMarkdown(page.file) }, text);
    return { text, hash: sourceHash(text), writable: policy.savePolicy === "writable" };
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) {
      return { text: null, hash: null, writable: false };
    }
    throw error;
  }
}

const textOf = (node) => node.nodeName === "#text" ? node.value : (node.childNodes || []).map(textOf).join("");
function elements(root) {
  const out = [];
  const visit = (node) => {
    if (node.tagName && !["html", "head", "body"].includes(node.tagName)) out.push(node);
    for (const child of node.childNodes || []) visit(child);
  };
  visit(root);
  return out;
}
function matches(root, html, text) {
  if (html !== undefined) {
    const expected = serialize(parseFragment(html));
    return elements(root).filter((node) => serializeOuter(node) === expected);
  }
  // Prefer the innermost exact block; ambiguity is rejected rather than guessed.
  const candidates = elements(root).filter((node) => textOf(node) === text);
  return candidates.filter((node) => !candidates.some((other) => other.parentNode === node));
}
function one(root, html, text) {
  const found = matches(root, html, text);
  if (found.length !== 1) reject("SAVE_EVIDENCE_CONFLICT", "Edit source is absent or ambiguous; preserve it as source-pending.");
  return found[0];
}
const conflict = (message) => reject("SAVE_EVIDENCE_CONFLICT", message);
function neighborMatches(node, label) {
  const text = textOf(node || {});
  const flat = text.replace(/\s+/g, " ").trim();
  const summary = flat.length > 90 ? `${flat.slice(0, 89).trimEnd()}\u2026` : flat;
  return text === label || summary === label;
}
function neighbor(parent, label) {
  if (!label) return null;
  const found = parent.childNodes.filter((node) => node.tagName && neighborMatches(node, label));
  if (found.length !== 1) conflict("Move boundary is absent or ambiguous.");
  return found[0];
}

/** Prove a single recorded transition, not a client assertion that HTML was saved. */
function applyEdit(document, edit, priorContent) {
  if (edit.truncated) conflict("Truncated edits cannot be saved as complete source.");
  for (const content of [edit, ...(priorContent ? [priorContent] : [])]) {
    for (const field of ["before", "after"]) {
      if (content[field] !== undefined && content[`${field}_html`] !== undefined &&
          textOf(parseFragment(content[`${field}_html`])) !== content[field]) {
        conflict("HTML and text must describe the same exact edit.");
      }
    }
  }
  const before = priorContent || edit;
  const node = one(document, priorContent ? before.after_html : before.before_html,
    priorContent ? before.after : before.before);
  const parent = node.parentNode;
  const index = parent.childNodes.indexOf(node);
  if (edit.kind === "deleted") parent.childNodes.splice(index, 1);
  else if (edit.kind === "moved") {
    parent.childNodes.splice(index, 1);
    const after = neighbor(parent, edit.moved_after);
    const next = neighbor(parent, edit.moved_before);
    if ((!after && !next) || (after && after.parentNode !== parent) || (next && next.parentNode !== parent)) {
      conflict("Move requires exact sibling boundaries.");
    }

    const position = after ? parent.childNodes.indexOf(after) + 1 : parent.childNodes.indexOf(next);
    if (next && parent.childNodes.slice(position, parent.childNodes.indexOf(next)).some((item) => item.tagName)) {
      conflict("Move boundaries disagree.");
    }
    parent.childNodes.splice(position, 0, node);
  } else if (edit.after_html !== undefined) {
    const replacements = parseFragment(parent, edit.after_html).childNodes;
    for (const replacement of replacements) replacement.parentNode = parent;
    parent.childNodes.splice(index, 1, ...replacements);
  } else {
    node.childNodes = [{ nodeName: "#text", value: edit.after, parentNode: node }];
  }
}

/** Every saved delta must be explained by exact, recorded transitions. */
export function proveSave(current, candidate, transitions) {
  if (Buffer.byteLength(candidate) > REVISION_LIMITS.sourceBytes) reject("SNAPSHOT_TOO_LARGE", "Saved source exceeds snapshot safety bound.");
  if (candidate !== stripSdk(candidate)) conflict("Injected review markup cannot be saved as source.");
  if (documentExecutionPolicy({ kind: "file", markdown: false }, candidate).savePolicy !== "writable") {
    conflict("This change introduces executable content; retain it as source-pending for source-directed handling.");
  }
  const document = parse(current);
  for (const { content, priorContent } of transitions) applyEdit(document, content, priorContent);
  if (serialize(document) !== serialize(parse(candidate))) {
    conflict("Saved HTML must contain exactly the recorded transitions; record other edits separately.");
  }
}

export function sourceEditContent(edit) {
  const content = { ...edit.content };
  for (const field of ["before_html", "after_html"]) {
    if (content[field] === undefined) continue;
    for (const asset of edit.assets) content[field] = content[field].replaceAll(asset.preview_src, `assets/${asset.id}`);
  }
  return content;
}

export function editIncluded(text, content) {
  const document = parse(text);
  if (content.kind === "deleted") return matches(document, content.before_html, content.before).length === 0;
  const found = matches(document, content.after_html ?? content.before_html, content.after ?? content.before);
  if (found.length !== 1) return false;
  if (content.kind !== "moved") return true;
  const siblings = found[0].parentNode.childNodes.filter((node) => node.tagName);
  const index = siblings.indexOf(found[0]);
  return (!content.moved_after || neighborMatches(siblings[index - 1], content.moved_after)) &&
    (!content.moved_before || neighborMatches(siblings[index + 1], content.moved_before));
}

export function resolveEditAssets(key, content) {
  return content.staged_assets.map(({ id, preview_src }) => {
    if (path.basename(id) !== id || /[\\/:]/.test(id) || id === "." || id === "..") reject("INVALID_INPUT", "Invalid staged asset identity.");
    const root = stagedRoot(key);
    const file = path.join(root, id);
    let real;
    try { real = fs.realpathSync(file); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      reject("NOT_FOUND", "Staged asset is missing.");
    }
    if (path.dirname(real) !== fs.realpathSync(root) || !fs.statSync(real).isFile() ||
        preview_src !== `__doc_review_paste__/${id}`) reject("SCOPE_MISMATCH", "Asset is outside this page.");
    return { id, path: real, preview_src };
  });
}
