import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { launchBrief, rolloutNotes, roadmap } from "../test/fixtures/migration-review.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const work = await mkdtemp(path.join(root, ".shell-preview-"));
const smoke = process.argv.includes("--smoke");
let review;
let browser;
let landing;
let stopping;

async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    if (landing) await new Promise((resolve, reject) => landing.close((error) => error ? reject(error) : resolve()));
    await browser?.close();
    await review?.dispose();
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  })();
  return stopping;
}

try {
  await cp(path.join(root, "lib"), path.join(work, "lib"), { recursive: true });
  const target = path.join(work, "launch-brief.html");
  const notesTarget = path.join(work, "notes.md");
  await writeFile(target, launchBrief(0));
  await writeFile(notesTarget, rolloutNotes(0));
  await writeFile(path.join(work, "roadmap.svg"), roadmap);
  process.env.DOC_REVIEW_STATE_DIR = path.join(work, "state");
  const { start } = await import(pathToFileURL(path.join(work, "lib", "server.js")).href);
  review = await start();
  const base = `http://127.0.0.1:${review.port}`;
  async function request(route, body) {
    const response = await fetch(`${base}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-doc-review-token": review.token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`Review example ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  }
  async function comment(key, selector, quote, feedback) {
    return request(`/api/page/${key}/comment`, { kind: "element", anchor: { selector, label: quote }, quote, feedback });
  }
  async function acknowledge(file, batchId) {
    const response = await fetch(`${base}/api/poll?target=${encodeURIComponent(file)}&ack=${batchId}`, {
      headers: { "x-doc-review-token": review.token },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Demo acknowledgement failed: ${response.status}`);
    await response.body.cancel();
  }
  async function send(page, note) {
    await page.locator("#commentsButton").click();
    await page.getByLabel("Overall note").fill(note);
    const completed = page.waitForResponse((response) =>
      response.request().method() === "POST" && /\/api\/page\/[^/]+\/send$/.test(new URL(response.url()).pathname));
    await page.locator("#send").click();
    const response = await completed;
    const sent = await response.json();
    if (!response.ok() || !sent.roundId) throw new Error(`Example Send failed: ${JSON.stringify(sent)}`);
    await expect(page.getByLabel("Overall note")).toHaveValue("");
    await page.locator("#drawerClose").click();
    return sent.roundId;
  }
  async function resultReady(session, roundId) {
    await expect.poll(async () => {
      const result = await request(`/api/session/${session.sessionId}/history/${roundId}`);
      const round = result.round || result;
      return round.targets.find((target) => target.key === session.key)?.captureStatus;
    }, { timeout: 30_000, message: "The seeded round must have a real SDK result capture" }).toBe("ready");
  }
  async function open(page, session) {
    await page.goto(`${base}${session.path}`);
    await page.locator('#frame[data-sdk-ready="true"]').waitFor({ timeout: 15_000 });
  }

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const session = await request("/api/session", { target });
  const notesPage = await request(`/api/session/${session.sessionId}/navigate`, { href: "notes.md" });
  await comment(notesPage.key, "h1", "Rollout notes", "Narrow the audience and keep a clear checklist.");
  await request(`/api/session/${session.sessionId}/goto`, { key: session.key });
  await comment(session.key, "#intro", "Ship the new workspace to everyone on Friday.", "Use a staged rollout and explain the exit criteria.");
  await open(page, session);
  const firstRound = await send(page, "Round 1: staged rollout and audience. The other page intentionally has Source-only baseline coverage.");
  const firstBatch = await request(`/api/poll?target=${encodeURIComponent(target)}`);
  await writeFile(target, launchBrief(1));
  await writeFile(notesTarget, rolloutNotes(1));
  await acknowledge(target, firstBatch.batch_id);
  await resultReady(session, firstRound);
  await request(`/api/session/${session.sessionId}/history/${firstRound}/capture`, {
    key: notesPage.key, manual: true, finalUnavailable: true,
  });
  await page.locator('#frame[data-sdk-ready="true"]').waitFor();
  await comment(session.key, "#decision", "Confirm the owners and review the rollout criteria.", "Assign the owner and make expansion conditional on cohort feedback.");
  await page.reload();
  await page.locator('#frame[data-sdk-ready="true"]').waitFor();
  const secondRound = await send(page, "Round 2: clarify ownership, change inline wording, and retain long unchanged context.");
  const secondBatch = await request(`/api/poll?target=${encodeURIComponent(target)}`);
  await writeFile(target, launchBrief(2));
  await acknowledge(target, secondBatch.batch_id);
  await resultReady(session, secondRound);

  const markdown = await request("/api/session", { target: notesTarget });
  await open(page, markdown);
  const markdownRound = await send(page, "Review the Markdown checklist and keyboard outcome.");
  const markdownBatch = await request(`/api/poll?target=${encodeURIComponent(notesTarget)}`);
  await writeFile(notesTarget, rolloutNotes(2));
  await acknowledge(notesTarget, markdownBatch.batch_id);
  await resultReady(markdown, markdownRound);
  await comment(markdown.key, "h1", "Rollout notes", "Try feedback-only editing; the Markdown source must remain Markdown.");

  await open(page, session);
  const current = await request(`/api/session/${session.sessionId}/page`);
  const raw = await request(`/api/page/${session.key}/raw`);
  const renderId = new URL(await page.locator("#frame").getAttribute("src")).pathname.split("/")[2];
  const before = await page.frameLocator("#frame").locator("#demo-title").innerText();
  const after = `${before} - reviewer draft`;
  const originalHeading = `<h1 id="demo-title">${before}</h1>`;
  if (!raw.html.includes(originalHeading)) throw new Error("The example title no longer matches its saved source.");
  const identity = { sessionId: session.sessionId, renderId, generation: current.generation };
  await request(`/api/page/${session.key}/edit`, {
    ...identity, label: "Launch brief title", kind: "edited", before, after, savePolicy: "writable",
  });
  await request(`/api/page/${session.key}/save`, {
    ...identity, baseHash: raw.hash, html: raw.html.replace(originalHeading, `<h1 id="demo-title">${after}</h1>`),
  });
  await open(page, session);
  await page.locator("#commentsButton").click();
  await expect(page.locator("#editCount")).toHaveText("1");
  await expect(page.locator("#saveText")).toContainText("Saved to");
  await expect.poll(async () => (await readFile(target, "utf8")).includes("reviewer draft"),
    { timeout: 15_000, message: "The example edit must be saved to its disposable HTML file" }).toBe(true);
  await page.locator("#drawerClose").click();
  await comment(session.key, "#intro", "Start with the internal team", "Keep this summary concise. Try Edit or Delete, then Cancel.");
  await comment(session.key, "#nested", "Open a comment here and scroll this panel.", "Check the composer while scrolling and use Back to selection.");
  if (errors.length) throw new Error(`Example browser errors: ${errors.join("; ")}`);

  const emptyTarget = path.join(work, "empty-review.html");
  await writeFile(emptyTarget, "<!doctype html><html lang=\"en\"><title>Empty review</title><body><h1>Start a fresh review</h1><p>Select this paragraph to add the first comment. Changes has no rounds yet.</p></body></html>");
  const empty = await request("/api/session", { target: emptyTarget });
  const comparisons = await Promise.all([
    request(`/api/session/${session.sessionId}/history/${secondRound}/compare?key=${session.key}&mode=content`),
    request(`/api/session/${session.sessionId}/history/${secondRound}/compare?key=${session.key}&mode=source`),
    request(`/api/session/${session.sessionId}/history/${firstRound}/compare?key=${notesPage.key}&mode=source`),
    request(`/api/session/${markdown.sessionId}/history/${markdownRound}/compare?key=${markdown.key}&mode=content`),
  ]);
  if (comparisons.some((comparison) => !comparison.available || !comparison.changes.length)) {
    throw new Error("The seeded example must contain meaningful Content, Source and Markdown comparisons.");
  }
  const htmlUrl = `${base}${session.path}`;
  const markdownUrl = `${base}${markdown.path}`;
  const emptyUrl = `${base}${empty.path}`;
  await browser.close();
  browser = null;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>React shell migration review</title><style>
    body{margin:0;background:#f5f7fa;color:#253247;font:16px/1.65 system-ui,sans-serif}main{max-width:850px;margin:auto;padding:32px 24px}h1{line-height:1.2}section{margin:20px 0;padding:20px;background:white;border:1px solid #cdd6e0;border-radius:10px}a{color:#174f92}li{margin:8px 0}code{background:#eaf0f5;padding:2px 5px}small{color:#52657a}
    </style></head><body><main><small>SEEDED, DISPOSABLE EXAMPLES / REAL BUILT RUNTIME SNAPSHOT</small><h1>Review the complete React shell</h1><p>These examples contain real saved feedback rounds and SDK captures, not mocked history. All files are disposable copies. End review, Send, Delete and Revert affect only this example.</p>
    <section><h2><a href="${htmlUrl}">1. HTML: complete review workspace</a></h2><p>Two completed rounds, two reviewed pages, two saved comments and one real saved edit.</p><ol><li>Open <strong>Feedback</strong>: collapse Comments and Edits independently, inspect icon actions and the overall note, then try the End-left/Send-right footer. An active comment edit keeps Comments expanded until Save or Cancel. Try Cancel in the Revert/End confirmations.</li><li>Open <strong>Changes</strong>: Round 2 has Content and Source. Inspect inline words, table cells, code, long context, Previous/Next and Jump to change.</li><li>Choose <strong>Round 1</strong> and <strong>notes.md</strong>: inspect honest Source-only coverage and Comparison details, including line endings.</li><li>Return to Review: select text to comment; scroll the nested panel; change the page-owned input; switch views/themes and confirm the iframe and drafts stay intact.</li><li>Send disposable feedback to see the no-agent handoff. No agent is connected to this example.</li></ol></section>
    <section><h2><a href="${markdownUrl}">2. Markdown: feedback-only editing</a></h2><p>One completed round with Content and Source, plus a saved comment. Edit the rendered text, keep an overall note, and compare the saved result. The source remains Markdown.</p></section>
    <section><h2><a href="${emptyUrl}">3. Empty states</a></h2><p>No comments, edits or rounds. Inspect Feedback, disabled Send and empty Changes before adding the first comment.</p></section>
    <section><h2>Visual and keyboard pass</h2><p>Try light/dark at 1440, 768, 390 and 320 pixels. Tab through controls, Escape one surface at a time, check the textarea focus outline does not touch its hints, and verify sticky primary Send controls remain reachable while long inventory/handoff content scrolls.</p><p>For detailed checks and limitations, see <code>docs/migration-review.md</code>. Restart <code>npm run preview:review</code> for fresh data. Stop this launcher with Ctrl+C to remove these copies.</p></section>
    </main></body></html>`;
  landing = http.createServer((req, res) => {
    if (req.url !== "/" || req.method !== "GET") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    });
    res.end(html);
  });
  await new Promise((resolve, reject) => {
    landing.once("error", reject);
    landing.listen(0, "127.0.0.1", resolve);
  });
  const address = landing.address();
  const url = `http://127.0.0.1:${address.port}/`;
  console.log(`Migration review guide: ${url}`);
  console.log(`HTML (two rounds, multi-page): ${htmlUrl}`);
  console.log(`Markdown (completed round): ${markdownUrl}`);
  console.log(`Empty review: ${emptyUrl}`);
  if (smoke) {
    const response = await fetch(url);
    if (!response.ok || !(await response.text()).includes(htmlUrl)) throw new Error("Review guide is not responsive.");
    console.log("Seeded migration review smoke passed.");
    await stop();
  } else {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => { stop().catch((error) => { console.error(error); process.exitCode = 1; }); });
    }
  }
} catch (error) {
  await stop();
  throw error;
}
