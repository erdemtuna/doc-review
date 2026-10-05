import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { unzipSync, zipSync } from "fflate";

const privateKey = /^(?:data-)?(?:token|capability|nonce|authorization|cookie|set-cookie|x-doc-review-token|password|secret|localStorage|sessionStorage|storageState|cookies)$/i;
export function sanitizeText(text) {
  return text.replace(/((?:data-token|nonce|capability)\s*=\s*["'])[^"']*(["'])/gi, "$1REDACTED$2")
    .replace(/'nonce-[^']*'/g, "'nonce-REDACTED'")
    .replace(/("(?:token|capability|nonce|authorization|cookie|set-cookie|x-doc-review-token|password|secret)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"REDACTED"')
    .replace(/^(\s*(?:authorization|cookie|set-cookie|x-doc-review-token)\s*:\s*).*$/gim, "$1REDACTED")
    .replace(/([?&](?:token|capability|nonce|password|secret)=)[^&#\s"']*/gi, "$1REDACTED");
}
export function sanitizeValue(value) {
  if (typeof value === "string") {
    if (/^\s*[\[{]/.test(value)) {
      try { return JSON.stringify(sanitizeValue(JSON.parse(value))); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    return sanitizeText(value);
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== "object") return value;
  const header = typeof value.name === "string" && privateKey.test(value.name);
  const serializedCredential = typeof value.k === "string" && privateKey.test(value.k) &&
    value.v && typeof value.v === "object";
  const serializedHeader = Array.isArray(value.o) && privateKey.test(value.o.find(pair => pair?.k === "name")?.v?.s ?? "");
  return Object.fromEntries(Object.entries(value).map(([key, child]) =>
    [key, privateKey.test(key) || header && key === "value" ? "REDACTED"
      : serializedCredential && key === "v" ? { s: "REDACTED" }
      : serializedHeader && key === "o" ? child.map(pair => pair?.k === "value" ? { ...pair, v: { s: "REDACTED" } } : sanitizeValue(pair))
      : sanitizeValue(child)]));
}
function sanitizeBytes(bytes, name) {
  if (/\.(png|jpg|jpeg|gif|webp|woff2?|ttf)$/i.test(name)) return bytes;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) {
    if (/\.(json|jsonl|trace|network|log|txt|html)$/i.test(name)) throw error;
    return bytes;
  }
  if (name.endsWith(".json")) return Buffer.from(JSON.stringify(sanitizeValue(JSON.parse(text))));
  if (/\.(trace|network|jsonl)$/.test(name)) {
    return Buffer.from(text.split("\n").map(line => line ? JSON.stringify(sanitizeValue(JSON.parse(line))) : "").join("\n"));
  }
  if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
    try { return Buffer.from(JSON.stringify(sanitizeValue(JSON.parse(text)))); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  return Buffer.from(sanitizeText(text));
}
export function sanitizeDirectory(directory) {
  const root = fs.realpathSync(directory);
  let count = 0;
  for (const name of fs.readdirSync(root, { recursive: true })) {
    const file = path.join(root, name), stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink(), "Diagnostic evidence cannot contain links");
    if (!stat.isFile() || name.endsWith(".tgz")) continue;
    if (name.endsWith(".zip")) {
      const entries = unzipSync(fs.readFileSync(file)), sanitized = [];
      for (const [entry, bytes] of Object.entries(entries)) {
        assert(!entry.startsWith("/") && !entry.includes("\\") && !/^[A-Za-z]:/.test(entry) &&
          !entry.split("/").includes(".."), "Unsafe trace entry");
        sanitized.push([entry, sanitizeBytes(bytes, entry)]);
      }
      fs.writeFileSync(file, zipSync(Object.fromEntries(sanitized)));
    } else fs.writeFileSync(file, sanitizeBytes(fs.readFileSync(file), name));
    count++;
  }
  return count;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert(process.argv.length > 2, "Provide diagnostic evidence directories");
  for (const directory of process.argv.slice(2)) {
    if (!fs.existsSync(directory)) { console.log(`No stage evidence yet: ${directory}`); continue; }
    console.log(`Sanitized ${sanitizeDirectory(directory)} diagnostic files.`);
  }
}
