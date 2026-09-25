import { isRevisionId } from "./revision-schema.js";

function references(value, out = new Set()) {
  if (isRevisionId(value)) out.add(value);
  else if (Array.isArray(value)) for (const item of value) references(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) references(item, out);
  return out;
}

export function unsentRevisionReferences(data) {
  const out = new Set();
  for (const page of Object.values(data.pages || {})) {
    references(page.comments, out);
    references(page.edits, out);
    references(page.revisionRefs, out);
  }
  return out;
}

export function historyRevisionReferences(data) {
  const out = unsentRevisionReferences(data);
  references(data.histories, out);
  references(data.batches, out);
  references(data.conversations, out);
  return out;
}

export function retainHistory(data) {
  // Referenced comparisons are durable review records, not age/count debris.
  return false;
}
