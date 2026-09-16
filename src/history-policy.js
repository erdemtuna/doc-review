import { COMPLETED_ROUNDS_TO_KEEP, isRevisionId } from "./revision-schema.js";

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
  return out;
}

export function retainHistory(data) {
  const pinned = unsentRevisionReferences(data);
  let changed = false;
  for (const history of Object.values(data.histories || {})) {
    const completed = history.rounds
      .filter((round) => round.completedAt)
      .sort((a, b) => b.completedAt - a.completedAt || b.ordinal - a.ordinal);
    const keep = new Set(completed.slice(0, COMPLETED_ROUNDS_TO_KEEP).map((round) => round.roundId));
    const rounds = history.rounds.filter((round) =>
      !round.completedAt || keep.has(round.roundId) || [...references(round.targets)].some((id) => pinned.has(id)));
    if (rounds.length !== history.rounds.length) {
      history.rounds = rounds;
      changed = true;
    }
  }
  return changed;
}
