import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium, expect } from "@playwright/test";
import { fieldNotes, summaryFeedback, actionFeedback, overallNote } from "../test/fixtures/readme-review.js";
import { responseFor } from "../test/fixtures/agent-loop.js";
import { readmeCover } from "./readme-cover.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: { output: { type: "string", default: "output/readme" } } });
const output = path.resolve(root, values.output);
const work = await mkdtemp(path.join(root, ".shell-preview-media-"));
let browser;
let review;
try {
  await cp(path.join(root, "lib"), path.join(work, "lib"), { recursive: true });
  await mkdir(output, { recursive: true });
  const target = path.join(work, "landing-page.html");
  await writeFile(target, fieldNotes());
  process.env.DOC_REVIEW_STATE_DIR = path.join(work, "state");
  const { start } = await import(pathToFileURL(path.join(work, "lib", "server.js")).href);
  const contracts = await import(pathToFileURL(path.join(work, "lib", "contracts", "index.js")).href);
  review = await start();
  const base = `http://127.0.0.1:${review.port}`;
  async function request(body, route = "/api/conversation") {
    const response = await fetch(`${base}${route}`, { method: "POST",
      headers: { "x-doc-review-token": review.token, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const result = await response.json();
    assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  }
  const { receipt: opened } = contracts.acceptedMutationSchema.parse(await request({ operation: "open", requestId: randomUUID(), target }));
  const reference = { reviewId: opened.reviewId, entryKey: opened.entryKey };
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1120, height: 800 }, deviceScaleFactor: 1.5,
    locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" });
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem("doc-review:theme", "light"); });
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/r/${reference.reviewId}`);
  await page.locator('#frame[data-sdk-ready="true"]').waitFor();
  const frame = page.frameLocator("#frame");
  const captures = [];
  async function mode(name) {
    await page.locator("#modeButton").click();
    await page.getByRole("menuitemradio", { name: new RegExp(`^${name}`) }).click();
    await expect(page.locator("#modeLabel")).toHaveText(name);
  }
  async function capture(name) {
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator(".conversation-lifecycle")).toHaveText("Reviewing");
    await expect(page.getByRole("img", { name: "Doc Review", exact: true })).toBeVisible();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, name), animations: "disabled" });
    captures.push({ name, toolbar: await page.locator(".shell-toolbar").boundingBox(),
      lifecycle: await page.locator(".conversation-lifecycle").boundingBox() });
  }
  async function comment(selector, text, change) {
    await frame.locator(selector).evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await frame.locator("#commentAction").click();
    const editor = page.getByRole("textbox", { name: "New message", exact: true });
    await editor.fill(text);
    const composer = editor.locator("..");
    await expect(composer.getByLabel("Request a change")).not.toBeChecked();
    if (change) await composer.getByLabel("Request a change").check();
    await composer.getByRole("button", { name: "Save message", exact: true }).click();
    await expect(editor).toHaveCount(0);
  }
  await mode("Edit");
  await expect(frame.locator("body")).toHaveAttribute("contenteditable", "true");
  await frame.locator("#headline").click();
  await frame.locator("#headline").evaluate((element) => {
    const range = document.createRange(); range.setStart(element.firstChild, "Your next".length); range.collapse(true);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.type(" good");
  await expect.poll(() => readFile(target, "utf8")).toContain('id="headline">Your next good idea starts here.</h1>');
  await mode("View");
  await comment("#summary", summaryFeedback, true);
  if (await page.getByRole("complementary", { name: "Feedback", exact: true }).isVisible()) {
    await page.getByRole("complementary", { name: "Feedback", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  }
  await frame.locator('mark[data-eh-mark]').first().click();
  await expect(page.getByRole("button", { name: "Close conversation" })).toBeVisible();
  await capture("doc-review.png");
  await page.getByRole("button", { name: "Close conversation" }).click();
  await comment("#action", actionFeedback, true);
  if (!await page.getByRole("complementary", { name: "Feedback", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "Feedback", exact: true }).click();
  }
  await page.getByLabel("Overall note", { exact: true }).fill(overallNote);
  await expect(page.locator('[data-composer="note"]').getByLabel("Request a change")).not.toBeChecked();
  await capture("doc-review-feedback.png");
  await page.locator("#send").click();
  await expect(page.getByText("Queued; not received", { exact: true })).toBeVisible();
  const delivered = contracts.pollResponseSchema.parse(await request({ operation: "poll", ...reference }));
  assert.equal(delivered.state, "work");
  await writeFile(target, fieldNotes({ edited: true, revised: true }));
  const response = responseFor(delivered.submission, {
    responses: delivered.submission.messages.map(({ message }) => ({
      threadId: message.threadId, messageId: message.messageId, messageVersion: message.version,
      outcome: "applied", body: "Updated this copy to describe the concrete benefit and action.",
    })),
    resultNote: "Made the benefit and next step concrete. Kept your headline edit.",
  });
  contracts.acceptedMutationSchema.parse(await request(response));
  await expect.poll(async () => (await request({ ...reference, submissionId: delivered.submission.submissionId,
    pageKey: reference.entryKey, mode: "content" }, "/api/conversation/comparison")).available, { timeout: 30_000 }).toBe(true);
  await page.locator("#seeChanges").click();
  const comparison = page.getByRole("region", { name: "Saved comparison" });
  await expect(comparison).toContainText("Start a collection");
  await expect(comparison).toContainText("Keep your notes and links");
  await capture("doc-review-changes.png");
  assert.deepEqual(errors, []);
  const cover = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  await cover.setContent(readmeCover((await readFile(path.join(output, "doc-review.png"))).toString("base64")));
  await cover.locator("img").evaluate((image) => image.decode());
  await cover.evaluate(() => document.fonts.ready);
  await cover.screenshot({ path: path.join(output, "doc-review-social.png") });
  for (const name of ["doc-review", "doc-review-feedback", "doc-review-changes", "doc-review-social"]) {
    const png = await readFile(path.join(output, `${name}.png`));
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], name === "doc-review-social" ? [1280, 640] : [1680, 1200]);
    assert.ok(png.length < 1_000_000, `${name} must stay below 1 MB.`);
    console.log(`${name}.png: ${Math.ceil(png.length / 1024)} KiB`);
  }
  console.log(`Durable conversation example captured in ${output}`);
  await writeFile(path.join(output, "capture-evidence.json"), JSON.stringify({ captures, errors, source: "built runtime; actual UI save and source write" }, null, 2));
} finally {
  try { await browser?.close(); }
  finally {
    try { await review?.dispose(); }
    finally { await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
}
