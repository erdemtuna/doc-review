import { agentHandoffSchema, agentReferenceSchema } from "./contracts/agent.js";
import { shellQuote } from "./setup.js";

export const AGENT_INSTRUCTIONS = "Handle only this durable review and submission. Discuss means answer without source edits. " +
  "Request-change permits, but does not require, source changes for that message only; the overall note has its own independent intent. " +
  "Return one inline response per submitted message, one exact-version outcome per direct edit, and one independent resultNote. " +
  "Answer, clarify or defer when appropriate. Already-saved edits have server evidence; do not apply them again. " +
  "Carry complete pending human text, formatting, moves, deletions and assets to the true source, not rendered Markdown/scripted HTML/URL output. " +
  "Never apply truncated content. Missing or ambiguous targets require safe source identification or clarification, not guessed edits. " +
  "Write a complete respond JSON file with this reviewId, entryKey, submissionId, delivered expectedVersion and a stable requestId. " +
  "Retry only that same file/request after an uncertain response; never repeat source edits because a connection was lost. " +
  "End does not cancel accepted work. Abandoned work cannot be completed and does not imply the external agent stopped. " +
  "After an accepted response, poll this same review; stop on ended. Delivery is not agent liveness. " +
  "One cooperating handler is assumed; receipts do not provide filesystem exactly-once or worker leases.";

export function agentHandoff(reference, threads = [], command = "doc-review") {
  const { reviewId, entryKey } = agentReferenceSchema.parse(reference);
  const scope = `--review ${shellQuote(reviewId)} --entry ${shellQuote(entryKey)}`;
  return agentHandoffSchema.parse({
    pollCommand: `${command} poll ${scope} --timeout 600`,
    statusCommand: `${command} status ${scope}`,
    responseCommand: `${command} respond ${scope} --response-file response.json --timeout 600`,
    contextCommands: [...new Set(threads)].map((threadId) => ({
      threadId, command: `${command} context ${scope} --thread ${shellQuote(threadId)}`,
    })),
    instructions: AGENT_INSTRUCTIONS,
  });
}
