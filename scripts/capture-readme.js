import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium, expect } from "@playwright/test";
import { fieldNotes, summaryFeedback, actionFeedback, overallNote } from "../test/fixtures/readme-review.js";
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
    assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  }
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1120, height: 800 }, deviceScaleFactor: 1.5,
    locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce",
  });
  await page.addInitScript(() => {
    if (window === window.top) localStorage.setItem("doc-review:theme", "light");
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const session = await request("/api/session", { target });
  const frame = page.frameLocator("#frame");
  async function open() {
    await page.goto(`${base}${session.path}`);
    await page.locator('#frame[data-sdk-ready="true"]').waitFor();
    await frame.locator("#headline").waitFor();
  }
  async function capture(name) {
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);
    await frame.locator("body").evaluate(() => document.fonts.ready);
    await expect(page.locator("body")).not.toContainText(work);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, name), animations: "disabled" });
  }
  async function comment(selector, text, count) {
    await frame.locator(selector).evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await frame.locator("#commentAction").click();
    await page.locator("#composeText").fill(text);
    await page.locator("#composeAdd").click();
    await expect(page.locator("#compose")).toBeHidden();
    await expect(page.locator("#toolbarCount")).toHaveText(String(count));
  }
  await open();
  await page.locator("#modeButton").click();
  await page.getByRole("menuitemradio", { name: /^Edit/ }).click();
  await expect(frame.locator("body")).toHaveAttribute("contenteditable", "true");
  await frame.locator("#headline").click();
  await frame.locator("#headline").evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild, "Your next".length);
    range.collapse(true);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.type(" good");
  await expect.poll(() => readFile(target, "utf8")).toContain('id="headline">Your next good idea starts here.</h1>');
  await page.locator("#modeButton").click();
  await page.getByRole("menuitemradio", { name: /^View/ }).click();
  await comment("#summary", summaryFeedback, 1);
  await frame.locator("mark[data-eh-mark]").first().click();
  await expect(page.locator("#alignedCard")).toContainText(summaryFeedback);
  await capture("doc-review.png");
  await page.locator("#alignedCard").getByRole("button", { name: "Close comment card" }).click();
  await comment("#action", actionFeedback, 2);
  await page.locator("#commentsButton").click();
  await expect(page.locator("#cards .comment")).toHaveCount(2);
  await expect(page.locator("#editCount")).toHaveText("1");
  await expect(page.locator("#saveText")).toContainText("Saved to landing-page.html");
  await page.getByLabel("Overall note").fill(overallNote);
  await expect(page.locator("#send")).toBeEnabled();
  await page.getByRole("heading", { name: "Your edits" }).click();
  await capture("doc-review-feedback.png");

  const sent = page.waitForResponse((response) =>
    response.request().method() === "POST" && /\/api\/page\/[^/]+\/send$/.test(new URL(response.url()).pathname));
  await page.locator("#send").click();
  const response = await sent;
  const result = await response.json();
  assert.ok(response.ok() && result.roundId, "Send must create an actual review round.");
  await expect(page.getByLabel("Overall note")).toHaveValue("");
  await page.locator("#drawerClose").click();
  const batch = await request(`/api/poll?target=${encodeURIComponent(target)}`);
  assert.ok(batch.batch_id, "The captured feedback must be delivered as a real batch.");
  await writeFile(target, fieldNotes({ edited: true, revised: true }));
  const acknowledged = await fetch(`${base}/api/poll?target=${encodeURIComponent(target)}&ack=${encodeURIComponent(batch.batch_id)}`, {
    headers: { "x-doc-review-token": review.token }, signal: AbortSignal.timeout(15_000),
  });
  assert.ok(acknowledged.ok, `Acknowledgment failed: ${acknowledged.status}`);
  await acknowledged.body.cancel();
  await expect.poll(async () => {
    const history = await request(`/api/session/${session.sessionId}/history/${result.roundId}`);
    return (history.round || history).targets.find((item) => item.key === session.key)?.captureStatus;
  }, { timeout: 30_000 }).toBe("ready");
  await page.locator("#seeChanges").click();
  await expect(page.locator("#roundPicker")).toHaveAttribute("data-value", result.roundId);
  await expect(page.locator("#changeDetail")).toContainText("Start a collection");
  await expect(page.locator("#changeDetail")).toContainText("Keep your notes and links");
  await expect(page.locator("#changePosition")).toHaveText("1 of 2");
  await expect(page.locator("#historyStatus")).toHaveClass("sr-only");
  await expect(page.locator("#historyStatus")).toHaveCSS("clip-path", "inset(50%)");
  const centered = await page.locator("#changeNavigation").evaluate((element) => {
    const nav = element.getBoundingClientRect();
    const toolbar = element.closest(".changes-toolbar").getBoundingClientRect();
    return Math.abs(nav.left + nav.width / 2 - toolbar.left - toolbar.width / 2);
  });
  assert.ok(centered <= 1, "Navigation must be centered on the full toolbar.");
  await capture("doc-review-changes.png");
  assert.deepEqual(errors, [], "Capture must not contain browser errors.");

  const cover = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  await cover.setContent(readmeCover((await readFile(path.join(output, "doc-review.png"))).toString("base64")));
  await cover.locator("img").evaluate((image) => image.decode());
  await cover.evaluate(() => document.fonts.ready);
  await cover.screenshot({ path: path.join(output, "doc-review-social.png") });
  for (const name of ["doc-review", "doc-review-feedback", "doc-review-changes", "doc-review-social"]) {
    const png = await readFile(path.join(output, `${name}.png`));
    const dimensions = [png.readUInt32BE(16), png.readUInt32BE(20)];
    assert.deepEqual(dimensions, name === "doc-review-social" ? [1280, 640] : [1680, 1200]);
    assert.ok(png.length < 1_000_000, `${name} must stay below 1 MB.`);
    console.log(`${name}.png: ${dimensions.join(" x ")}; ${Math.ceil(png.length / 1024)} KiB`);
  }
  console.log(`Scripted example captured successfully in ${output}`);
} finally {
  try { await browser?.close(); }
  finally {
    try { await review?.dispose(); }
    finally { await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
}
