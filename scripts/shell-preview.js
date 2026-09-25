import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fieldNotes, summaryFeedback, actionFeedback } from "../test/fixtures/readme-review.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const supported = new Set(["--smoke", "--recovery", "--comments", "--contextual", "--feedback"]);
for (const argument of process.argv.slice(2)) if (!supported.has(argument)) throw new Error(`Unknown preview option: ${argument}`);
const work = await mkdtemp(path.join(root, ".shell-preview-"));
let review;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await review?.dispose();
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
try {
  await cp(path.join(root, "lib"), path.join(work, "lib"), { recursive: true });
  const target = path.join(work, "field-notes.html");
  await writeFile(target, fieldNotes());
  process.env.DOC_REVIEW_STATE_DIR = path.join(work, "state");
  const { start } = await import(pathToFileURL(path.join(work, "lib", "server.js")).href);
  const { acceptedMutationSchema, reviewSchema } = await import(pathToFileURL(path.join(work, "lib", "contracts", "index.js")).href);
  review = await start();
  const base = `http://127.0.0.1:${review.port}`;
  async function post(body) {
    const response = await fetch(`${base}/api/conversation`, {
      method: "POST", headers: { "content-type": "application/json", "x-doc-review-token": review.token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`Preview failed: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  const { receipt: opened } = acceptedMutationSchema.parse(await post({ operation: "open", requestId: randomUUID(), target }));
  const reference = { reviewId: opened.reviewId, entryKey: opened.entryKey };
  for (const [selector, label, body, intent] of [
    ["#summary", "Summary", summaryFeedback, "discuss"],
    ["#action", "Call to action", actionFeedback, "request-change"],
  ]) {
    const current = reviewSchema.parse(await post({ operation: "read-review", ...reference }));
    acceptedMutationSchema.parse(await post({ operation: "create-thread", ...reference, requestId: randomUUID(),
      expectedVersion: current.version, pageKey: reference.entryKey, target: { kind: "element", anchor: { selector, label } }, body, intent }));
  }
  console.log(`Conversation preview: ${base}/r/${reference.reviewId}`);
  console.log(`Isolated source, runtime and state: ${work}`);
  console.log("Feedback, Focus, adjacent conversations and Changes use the same production workflow. Ctrl+C removes this fixture.");
  if (process.argv.includes("--smoke")) await stop();
  else for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    stop().catch((error) => { console.error(error); process.exitCode = 1; });
  });
} catch (error) {
  await stop();
  throw error;
}
