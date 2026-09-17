import { cp, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const recovery = process.argv.includes("--recovery");
const comments = process.argv.includes("--comments");
const contextual = process.argv.includes("--contextual");
const feedback = process.argv.includes("--feedback");
if ([recovery, comments, contextual, feedback].filter(Boolean).length > 1) throw new Error("Choose one shell preview fixture.");
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
  const fixture = feedback ? "feedback-review.html" : contextual ? "contextual-review.html" : comments ? "comments-review.html" : recovery ? "recovery-review.html" : "toolbar-review.html";
  const target = path.join(work, fixture);
  await cp(path.join(root, "test", "fixtures", fixture), target);
  process.env.DOC_REVIEW_STATE_DIR = path.join(work, "state");
  const { start } = await import(pathToFileURL(path.join(work, "lib", "server.js")).href);
  review = await start();
  const base = `http://127.0.0.1:${review.port}`;
  async function post(route, body) {
    const response = await fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-doc-review-token": review.token },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Preview fixture failed: ${response.status} ${await response.text()}`);
    return response.json();
  }
  const session = await post("/api/session", { target });
  for (const [selector, quote, feedback] of [
    ["#intro", "Keep your attention on the document.", "Keep the introduction concise."],
    ["#detail", "Switch between Review and Changes", "Make this next step easier to scan."],
  ]) {
    await post(`/api/page/${session.key}/comment`, {
      kind: "element", anchor: { selector, label: quote }, quote, feedback,
    });
  }
  if (comments) {
    for (let index = 0; index < 18; index++) {
      await post(`/api/page/${session.key}/comment`, {
        kind: "element", anchor: { selector: "#detail", label: "Inventory review instructions" },
        quote: index === 0 ? `Beginning of excerpt. ${"Supporting context. ".repeat(30)}Final excerpt sentence.` : "Switch between Review and Changes",
        feedback: index === 0 ? "Long feedback sample. ".repeat(35) : `Sample ${index + 1}: Make this instruction easier to follow.`,
      });
    }
    const otherName = "another-reviewed-document.html";
    await cp(target, path.join(work, otherName));
    const other = await post(`/api/session/${session.sessionId}/navigate`, { href: otherName });
    await post(`/api/page/${other.key}/comment`, {
      kind: "element", anchor: { selector: "#intro", label: "Introduction" },
      quote: "Keep your attention on the document.", feedback: "Feedback on a different page in this review.",
    });
    await post(`/api/session/${session.sessionId}/goto`, { key: session.key });
    const emptyTarget = path.join(work, "empty-comments-review.html");
    await cp(target, emptyTarget);
    const emptySession = await post("/api/session", { target: emptyTarget });
    console.log(`G4 empty inventory preview: ${base}${emptySession.path}`);
  }
  if (feedback) {
    for (let index = 0; index < 7; index++) {
      await post(`/api/page/${session.key}/edit`, {
        label: `Sample paragraph ${index + 1}`, kind: index === 2 ? "deleted" : "edited",
        before: "Original sample", after: index === 2 ? "" : "Revised sample", feedback_only: true,
      });
    }
  }
  console.log(`${feedback ? "G6 feedback and confirmations" : contextual ? "G5 contextual commenting" : comments ? "G4 comments" : recovery ? "G3 recovery" : "G2 toolbar"} preview: ${base}${session.path}`);
  console.log("Disposable document and isolated runtime snapshot. Other panels are not yet redesigned.");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => { stop().catch((error) => { console.error(error); process.exitCode = 1; }); });
  }
} catch (error) {
  await stop();
  throw error;
}
