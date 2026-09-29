import { createHash } from "node:crypto";
import {
  AGENT_OUTPUT_BYTES, agentReadRequestSchema, agentReadResponseSchema,
} from "./contracts/agent.js";
import { canonicalJson, reject } from "./contracts/validation.js";
import { agentHandoff } from "./agent-handoff.js";
import { shellQuote } from "./setup.js";

export const serializeAgent = (value) => {
  const output = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(output) > AGENT_OUTPUT_BYTES) {
    reject("INPUT_TOO_LARGE", "Agent envelope exceeds 16 KiB; use scoped content/export for oversized metadata.");
  }
  return output;
};
const bytes = (value) => Buffer.byteLength(`${JSON.stringify(value)}\n`);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const integrity = (text) => ({ utf8Bytes: Buffer.byteLength(text), sha256: hash(text) });
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function cursor(raw, binding, total) {
  if (raw === undefined) return 0;
  let decoded;
  try { decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); }
  catch { reject("INVALID_CURSOR", "Malformed continuation."); }
  if (decoded.binding !== binding || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0 || decoded.offset > total) {
    reject("INVALID_CURSOR", "Continuation belongs to different scope, content or version.");
  }
  return decoded.offset;
}
const token = (binding, offset, highWater) => encode({ binding, offset, ...(highWater === undefined ? {} : { highWater }) });
const commandScope = (scope) => `--review ${shellQuote(scope.reviewId)} --entry ${shellQuote(scope.entryKey)}`;

export function responseTemplate(submission, requestId) {
  if (submission.state !== "delivered") reject("RESPONSE_COVERAGE", "Templates require delivered work.");
  return {
    operation: "respond", reviewId: submission.reviewId, entryKey: submission.entryKey,
    submissionId: submission.submissionId, expectedVersion: submission.version, requestId,
    responses: submission.messages.map(({ message }) => ({
      threadId: message.threadId, messageId: message.messageId, messageVersion: message.version, body: "", outcome: "",
    })),
    editOutcomes: submission.edits.map((edit) => ({ editId: edit.editId, editVersion: edit.version, outcome: "", reason: "" })),
    ...(submission.overallNote ? { overallOutcome: "" } : {}), resultNote: "",
  };
}

/** A separate producer projection: browser reads deliberately retain pending messages. */
export function readAgent(conversations, input, command, source = "server") {
  const request = agentReadRequestSchema.parse(input);
  command = request.invocation ?? command;
  const scope = { reviewId: request.reviewId, entryKey: request.entryKey };
  const review = conversations.read({ operation: "read-review", ...scope });
  const record = conversations.store.data.conversations.reviews[review.reviewId];
  const sub = (submissionId) => {
    if (!submissionId) reject("INVALID_INPUT", "This command requires --submission.");
    return conversations.read({ operation: "submission", ...scope, submissionId });
  };
  const cmd = (verb, submissionId) => `${command} ${verb} ${commandScope(scope)}${submissionId ? ` --submission ${shellQuote(submissionId)}` : ""}`;
  const page = (pageKey) => conversations.page(conversations.store.data, record, pageKey).page;
  const roots = new WeakMap();
  const root = (read) => {
    if (!roots.has(read)) roots.set(read, { ...read, pages: read.submission.pageKeys.map(page) });
    return roots.get(read);
  };
  function valueAt(read, field) {
    if (field === "") return root(read);
    let value = field.startsWith("pages/") ? root(read) : read;
    for (const part of field.split("/")) {
      if (!part || !value || typeof value !== "object" || !Object.hasOwn(value, part)) reject("SCOPE_MISMATCH", "Field is outside this exact submitted artifact.");
      value = value[part];
    }
    return value;
  }
  function contentVersion(read, field) {
    const parts = field.split("/");
    if (parts[0] === "submission" && parts[1] === "edits" && parts.length >= 3) {
      return read.submission.edits[Number(parts[2])]?.version ?? read.submission.version;
    }
    if (parts[0] === "submission" && parts[1] === "messages" && parts.length >= 3) {
      return read.submission.messages[Number(parts[2])]?.message.version ?? read.submission.version;
    }
    // Frozen submission evidence and committed results do not inherit mutable lifecycle versions.
    if ((parts[0] === "submission" && ["messages", "edits", "overallNote", "pageKeys", "createdAt"].includes(parts[1])) ||
        ["result", "receipt"].includes(parts[0])) return 1;
    return read.submission.version;
  }
  function content(read, field, forceReference = false, budget = 2048) {
    const value = valueAt(read, field);
    const isText = typeof value === "string";
    const text = isText ? value : JSON.stringify(value);
    if (!forceReference && bytes(value) <= budget) return isText ? { kind: "inline", text } : { kind: "inline", value };
    const version = contentVersion(read, field);
    return {
      kind: "reference",
      identity: { ...scope, submissionId: read.submission.submissionId, version, field: field || "." },
      encoding: isText ? "utf8" : "json", ...integrity(text),
      command: `${cmd("content", read.submission.submissionId)} --version ${version} --field ${shellQuote(field || ".")}`,
      ...(isText ? { preview: [...text].slice(0, 80).join("") } : {}),
      ...(!isText && value && typeof value === "object" && !Array.isArray(value) ? {
        fields: Object.entries(value).map(([name, data]) => ({
          name, encoding: typeof data === "string" ? "utf8" : "json",
          ...integrity(typeof data === "string" ? data : JSON.stringify(data)),
        })),
      } : {}),
    };
  }
  const lifecycle = (read) => {
    const s = read.submission;
    return {
      submissionId: s.submissionId, version: s.version, state: s.state, createdAt: s.createdAt,
      deliveredAt: s.deliveredAt, completedAt: s.completedAt,
      abandonment: s.abandonment ? content(read, "submission/abandonment") : null,
    };
  };
  const note = (read, small = false) => read.submission.overallNote ? {
    overallNote: { intent: read.submission.overallNote.intent, body: content(read, "submission/overallNote/body", false, small ? 256 : 2048) },
  } : {};
  const result = (read, preview = false, budget = 2048) => read.result ? {
    resultId: read.result.resultId, title: read.result.title, effect: read.result.effect,
    body: content(read, "result/body", preview, budget),
    ...(read.result.overallOutcome ? { overallOutcome: read.result.overallOutcome } : {}),
  } : null;
  function paginate(rows, binding, envelope, build = (row) => row, highWater) {
    const offset = cursor(request.cursor, binding, rows.length);
    const items = [];
    let end = offset;
    const output = () => ({
      ...envelope, totalCount: rows.length, returnedCount: items.length,
      complete: end === rows.length, nextCursor: end < rows.length ? token(binding, end, highWater) : null, items,
    });
    while (end < rows.length && items.length < (request.limit ?? 50)) {
      items.push(build(rows[end]));
      end++;
      if (bytes({ operation: request.operation, value: output() }) > AGENT_OUTPUT_BYTES - 1024) {
        items.pop(); end--; break;
      }
    }
    if (end === offset && end < rows.length) reject("INPUT_TOO_LARGE", "One inventory item exceeds the envelope budget; export the scoped submission artifact.");
    return output();
  }
  let value;
  if (request.operation === "content" || request.operation === "response-template") {
    const read = sub(request.submissionId);
    if (request.operation === "response-template" && !request.requestId) reject("INVALID_INPUT", "Template requires a stable requestId.");
    const field = request.operation === "response-template" ? "response-template" : (request.field === "." ? "" : request.field);
    if (field === undefined) reject("INVALID_INPUT", "content requires --field (or --output-file for the whole artifact).");
    const version = contentVersion(read, field);
    if (request.version !== undefined && request.version !== version) reject("VERSION_CONFLICT", "Content version does not match this field.");
    const data = request.operation === "response-template" ? responseTemplate(read.submission, request.requestId) : valueAt(read, field);
    const text = typeof data === "string" ? data : JSON.stringify(data);
    const identity = { ...scope, submissionId: read.submission.submissionId, version, field: field || "." };
    const info = integrity(text);
    const binding = hash(canonicalJson({ identity, sha256: info.sha256 }));
    const offset = cursor(request.cursor, binding, text.length);
    if (offset && /[\uDC00-\uDFFF]/.test(text[offset]) && /[\uD800-\uDBFF]/.test(text[offset - 1])) reject("INVALID_CURSOR", "Continuation splits a Unicode character.");
    const endAt = (end) => end < text.length && /[\uDC00-\uDFFF]/.test(text[end]) && /[\uD800-\uDBFF]/.test(text[end - 1]) ? end - 1 : end;
    const chunk = (end) => ({
      identity, encoding: typeof data === "string" ? "utf8" : "json", ...info,
      offset: Buffer.byteLength(text.slice(0, offset)), returnedBytes: Buffer.byteLength(text.slice(offset, end)),
      complete: end === text.length, nextCursor: end === text.length ? null : token(binding, end), text: text.slice(offset, end),
    });
    let low = offset, high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (bytes({ operation: request.operation, value: chunk(endAt(mid)) }) <= AGENT_OUTPUT_BYTES) low = mid;
      else high = mid - 1;
    }
    const end = endAt(low);
    if (end === offset && offset < text.length) reject("INPUT_TOO_LARGE", "Content identity exceeds the delivery budget.");
    value = chunk(end);
  } else if (request.operation === "submission") {
    const read = sub(request.submissionId), s = read.submission;
    const items = s.pageKeys.map((pageKey, i) => ({ kind: "page", pageKey, data: content(read, `pages/${i}`) }));
    s.messages.forEach(({ pageKey, message }, i) => items.push({
      kind: "message", pageKey, threadId: message.threadId, messageId: message.messageId, messageVersion: message.version,
      intent: message.intent, target: content(read, `submission/messages/${i}/target`),
      body: content(read, `submission/messages/${i}/message/body`),
      contextCommand: `${cmd("context", s.submissionId)} --thread ${shellQuote(message.threadId)} --limit 1`,
    }));
    s.edits.forEach((edit, i) => items.push({
      kind: "edit", pageKey: edit.pageKey, editId: edit.editId, editVersion: edit.version,
      editKind: edit.content.kind, label: content(read, `submission/edits/${i}/content/label`),
      source: content(read, `submission/edits/${i}/source`), assets: content(read, `submission/edits/${i}/assets`),
      captureTruncated: edit.content.truncated, truncatedFields: edit.content.truncated_fields,
      content: content(read, `submission/edits/${i}/content`),
    }));
    read.result?.responses.forEach((reply, i) => items.push({
      kind: "response", threadId: reply.threadId, messageId: reply.messageId, replyToMessageId: reply.replyToMessageId,
      outcome: reply.outcome, body: content(read, `result/responses/${i}/body`),
    }));
    read.result?.editOutcomes.forEach((outcome, i) => items.push({
      kind: "edit-outcome", editId: outcome.editId, editVersion: outcome.editVersion,
      outcome: outcome.outcome, reason: content(read, `result/editOutcomes/${i}/reason`),
    }));
    const envelope = {
      ...scope, ...lifecycle(read), ...note(read), result: result(read),
      receipt: read.receipt ? content(read, "receipt") : null, handoff: agentHandoff(scope, s.submissionId, command),
    };
    const binding = hash(canonicalJson({ scope, operation: request.operation, submissionId: s.submissionId, version: s.version }));
    // Budget the enclosing manifest as well as the individual inventory page.
    const paged = paginate(items, binding, { manifest: envelope });
    const { manifest, ...inventory } = paged;
    value = { ...manifest, inventory };
  } else if (request.operation === "history" || request.operation === "context") {
    const bound = request.operation === "context" ? sub(request.submissionId).submission :
      request.before ? sub(request.before).submission : null;
    let highWater = bound?.sequence ?? record.sequence;
    if (request.cursor !== undefined) {
      let decoded;
      try { decoded = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")); }
      catch { reject("INVALID_CURSOR", "Malformed continuation."); }
      if (!Number.isSafeInteger(decoded.highWater) || decoded.highWater < 0 || decoded.highWater > highWater ||
          (bound && decoded.highWater !== highWater)) reject("INVALID_CURSOR", "Invalid historical boundary.");
      highWater = decoded.highWater;
    }
    let rows = Object.values(record.submissions).filter((s) => s.sequence <= highWater && (!bound || s.sequence < bound.sequence)).sort((a, b) => b.sequence - a.sequence);
    // Include the immutable IDs in the cursor binding: later submissions cannot leak into continuations.
    const binding = hash(canonicalJson({ scope, operation: request.operation, boundary: bound?.submissionId ?? null, threadId: request.threadId ?? null, highWater }));
    if (request.operation === "context") {
      if (bound.deliveredAt === null) reject("RESPONSE_COVERAGE", "Context requires a delivered submission boundary.");
      if (!request.threadId || !bound.messages.some(({ message }) => message.threadId === request.threadId)) {
        reject("SCOPE_MISMATCH", "Thread is not part of the bound submitted work.");
      }
      rows = rows.flatMap((s) => s.messages.filter(({ message }) => message.threadId === request.threadId)
        .sort((a, b) => b.message.sequence - a.message.sequence).map((item) => ({ s, item })));
      value = paginate(rows, binding, { ...scope, submissionId: bound.submissionId, threadId: request.threadId }, ({ s, item }) => {
        const read = sub(s.submissionId), i = s.messages.indexOf(item);
        const responseIndex = read.result?.responses.findIndex((r) => r.replyToMessageId === item.message.messageId) ?? -1;
        return {
          submissionId: s.submissionId, state: s.state, deliveredAt: s.deliveredAt, completedAt: s.completedAt,
          messageId: item.message.messageId, messageVersion: item.message.version, intent: item.message.intent,
          body: content(read, `submission/messages/${i}/message/body`),
          response: responseIndex < 0 ? null : {
            outcome: read.result.responses[responseIndex].outcome, body: content(read, `result/responses/${responseIndex}/body`),
          },
        };
      }, highWater);
    } else value = paginate(rows, binding, { ...scope, before: request.before ?? null }, (s) => {
      const read = sub(s.submissionId);
      return { ...lifecycle(read), ...note(read), result: result(read, false, 10 * 1024), command: cmd("submission", s.submissionId) };
    }, highWater);
  } else {
    const status = conversations.read({ operation: "status", ...scope });
    const latest = Object.values(record.submissions).sort((a, b) => b.sequence - a.sequence)[0];
    const read = latest ? sub(latest.submissionId) : null;
    const { blockers, ...rest } = status;
    const envelope = {
      source, ...rest, latestSubmission: read ? { ...lifecycle(read), result: result(read, true) } : null,
      handoff: agentHandoff(scope, null, command),
    };
    const binding = hash(canonicalJson({ scope, operation: "status", blockers }));
    const paged = paginate(blockers, binding, { manifest: envelope });
    const { manifest, ...inventory } = paged;
    value = { ...manifest, blockers: inventory };
  }
  const output = agentReadResponseSchema.parse({ operation: request.operation, value });
  serializeAgent(output);
  return output;
}
