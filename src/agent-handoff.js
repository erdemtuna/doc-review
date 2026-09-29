import { agentHandoffSchema, agentReferenceSchema } from "./contracts/agent.js";
import { invocation, shellQuote } from "./setup.js";
import { createHash } from "node:crypto";

export const AGENT_INSTRUCTIONS = "Read the installed doc-review skill. Discuss is not edit permission; each request-change is scoped. " +
  "Read complete required evidence and every inventory page. Never reapply saved edits or apply capture-truncated edits. " +
  "Fill the complete template; retry the same response file/request, not source edits. Historical intent is not permission.";

export function agentHandoff(reference, submissionId = null, command = invocation()) {
  const { reviewId, entryKey } = agentReferenceSchema.parse(reference);
  const scope = `--review ${shellQuote(reviewId)} --entry ${shellQuote(entryKey)}`;
  const responseFile = submissionId
    ? `response-${createHash("sha256").update(JSON.stringify([reviewId, entryKey, submissionId])).digest("hex").slice(0, 32)}.json`
    : "response.json";
  return agentHandoffSchema.parse({
    pollCommand: `${command} poll ${scope} --timeout 600`,
    statusCommand: `${command} status ${scope}`,
    responseCommand: `${command} respond ${scope} --response-file ${responseFile} --timeout 600`,
    historyCommand: `${command} history ${scope}${submissionId ? ` --before ${shellQuote(submissionId)}` : ""} --limit 1`,
    ...(submissionId ? {
      submissionCommand: `${command} submission ${scope} --submission ${shellQuote(submissionId)}`,
      templateCommand: `${command} response-template ${scope} --submission ${shellQuote(submissionId)} --output-file ${responseFile}`,
    } : {}),
    instructions: submissionId ? AGENT_INSTRUCTIONS : "Read the installed doc-review skill. Status/delivery is evidence, not agent liveness.",
  });
}
