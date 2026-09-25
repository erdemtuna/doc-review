import { test as base, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { responseFor } from "../test/fixtures/agent-loop.js";

const runtime = path.resolve(process.env.DOC_REVIEW_TEST_RUNTIME || "lib");
const { acceptedMutationSchema, contractFailure, ContractError } = await import(pathToFileURL(path.join(runtime, "contracts", "index.js")).href);
export const test = base.extend({
  review: [
    async ({}, use, workerInfo) => {
      const root = path.join(
        process.env.DOC_REVIEW_TEST_ROOT || path.join(process.cwd(), ".playwright-state"),
        `worker-${workerInfo.workerIndex}-${process.pid}`
      );
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
      process.env.DOC_REVIEW_STATE_DIR = path.join(root, "state");
      const { start } = await import(pathToFileURL(path.join(runtime, "server.js")).href);
      let server = await start();
      const fixture = { ...server, root, references: [], async restart() {
        const port = server.port;
        await server.dispose();
        server = await start(port);
        Object.assign(fixture, server);
      } };
      try {
        await use(fixture);
      } finally {
        await server.dispose();
        if (process.env.DOC_REVIEW_TEST_KEEP === "1") fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({
          runtime, root, state: path.join(root, "state"), references: fixture.references,
        }, null, 2));
        if (fixture.failed) console.error(`Failed browser fixture retained: ${root}`);
        else if (process.env.DOC_REVIEW_TEST_KEEP !== "1") fs.rmSync(root, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  retainFailure: [async ({ review }, use, testInfo) => {
    await use();
    if (testInfo.status !== testInfo.expectedStatus) review.failed = true;
  }, { auto: true }],
});

export { expect };

export async function reviewApi(review, route, { method = "GET", body } = {}) {
  const response = await fetch(`http://127.0.0.1:${review.port}${route}`, {
    method,
    headers: {
      "x-doc-review-token": review.token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    raw,
    json: () => JSON.parse(raw),
  };
}

export async function openReview(page, review, target) {
  const opened = await reviewApi(review, "/api/conversation", {
    method: "POST",
    body: { operation: "open", requestId: randomUUID(), target },
  });
  expect(opened.status, opened.raw).toBe(200);
  const { receipt } = acceptedMutationSchema.parse(opened.json());
  const session = { reviewId: receipt.reviewId, entryKey: receipt.entryKey, key: receipt.entryKey,
    path: `/r/${receipt.reviewId}` };
  review.references.push({ target, reviewId: session.reviewId, entryKey: session.entryKey, path: session.path });
  await page.goto(`http://127.0.0.1:${review.port}${session.path}`);
  session.sessionId = await page.locator("body").getAttribute("data-session");
  await expect(page.locator("#frame")).toHaveAttribute("src", /\/artifact\/r_[a-f0-9]+\/index\.html/);
  return session;
}

export async function waitForSdk(page) {
  const frame = page.frameLocator("#frame");
  await expect(page.locator("#frame")).toHaveAttribute("data-sdk-ready", "true");
  return frame;
}

export async function enterEditMode(page) {
  const frame = await waitForSdk(page);
  await selectReviewMode(page, "Edit");
  await expect(frame.locator("body")).toHaveAttribute("contenteditable", "true");
  return frame;
}

export async function selectReviewMode(page, mode) {
  await page.locator("#modeButton").click();
  await page.getByRole("menuitemradio", { name: new RegExp(`^${mode}`) }).click();
  await expect(page.locator("#modeLabel")).toHaveText(mode);
}

export async function expectEditBlocked(page, blocked) {
  const trigger = page.locator("#modeButton");
  if (await trigger.isDisabled()) { expect(blocked).toBe(true); return; }
  await trigger.click();
  if (blocked) await expect(page.getByRole("menuitemradio", { name: /^Edit/ })).toBeDisabled();
  else await expect(page.getByRole("menuitemradio", { name: /^Edit/ })).toBeEnabled();
  await page.keyboard.press("Escape");
}

export async function conversation(review, reference, operation, fields = {}) {
  const { reviewId, entryKey } = reference;
  const result = await reviewApi(review, "/api/conversation", {
    method: "POST", body: { operation, reviewId, entryKey, ...fields },
  });
  expect(result.status, result.raw).toBe(200);
  return result.json();
}

export async function mutate(review, reference, operation, fields = {}) {
  const state = await conversation(review, reference, "read-review");
  return acceptedMutationSchema.parse(await conversation(review, reference, operation, {
    requestId: randomUUID(), expectedVersion: state.version, ...fields,
  })).receipt;
}

export async function feedback(page) {
  if (await page.locator("#commentsButton").getAttribute("aria-expanded") !== "true") await page.locator("#commentsButton").click();
  await expect(page.getByRole("complementary", { name: "Feedback" })).toBeVisible();
}

export async function message(page, text, change = false) {
  await feedback(page);
  await page.getByRole("button", { name: "New message", exact: true }).click();
  await compose(page, text, change);
}

export async function compose(page, text, change = false) {
  const composer = page.locator('[data-composer="new"]');
  await composer.getByRole("textbox").fill(text);
  await composer.getByLabel("Request a change").setChecked(change);
  await composer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(composer).toHaveCount(0);
}

export async function selectText(frame, selector) {
  await frame.locator(selector).evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

export async function selectionMessage(page, frame, selector, text, change = false) {
  await selectText(frame, selector);
  await frame.locator("#commentAction").click();
  await compose(page, text, change);
  await feedback(page);
}

export async function listed(review, ref, collection, scope = {}, query = {}) {
  const result = await reviewApi(review, "/api/conversation", { method: "POST", body: {
    operation: "list", scope: { reviewId: ref.reviewId, entryKey: ref.entryKey, collection,
      pageKey: null, threadId: null, submissionId: null, status: "all", ...scope }, query,
  } });
  expect(result.status, result.raw).toBe(200);
  return result.json();
}

export async function handled(review, ref, fields = {}) {
  const work = (await conversation(review, ref, "poll")).submission;
  expect(work).toBeTruthy();
  const response = responseFor(work, fields);
  const result = await reviewApi(review, "/api/conversation", { method: "POST", body: response });
  expect(result.status, result.raw).toBe(200);
  return { work, response, receipt: acceptedMutationSchema.parse(result.json()).receipt };
}

export async function intercept(page, operation, handler) {
  await page.route("**/api/conversation", async (route) => {
    if (route.request().postDataJSON().operation === operation) await handler(route);
    else await route.fallback();
  });
}

export function failure(route, message, code = "STATE_PERSIST_FAILED") {
  const json = contractFailure(new ContractError(code, message));
  return route.fulfill({ status: json.error.status, json });
}

export async function seedThread(review, ref, body, target = { kind: "element", anchor: { selector: "#copy", label: "Paragraph" } }) {
  return (await mutate(review, ref, "create-thread", { pageKey: ref.key, target, body, intent: "discuss" })).value;
}

export async function sendPending(review, ref, overallNote) {
  async function all(collection, scope = {}) {
    const items = [];
    let cursor;
    do {
      const page = await listed(review, ref, collection, scope, { limit: 100, ...(cursor ? { cursor } : {}) });
      items.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    return items;
  }
  const threads = await all("threads");
  const messages = [], pages = new Set(overallNote ? [ref.key] : []);
  for (const { thread } of threads) {
    const context = await all("context", { threadId: thread.threadId });
    const pending = context.filter(({ reviewer }) => reviewer.submissionId === null);
    if (pending.length) pages.add(thread.pageKey);
    messages.push(...pending.map(({ reviewer: { messageId, version } }) => ({ threadId: thread.threadId, messageId, version })));
  }
  const edits = await all("edits");
  edits.forEach((edit) => pages.add(edit.pageKey));
  return mutate(review, ref, "send", { pageKeys: [...pages], messages,
    edits: edits.map(({ editId, pageKey, version }) => ({ editId, pageKey, version })), ...(overallNote ? { overallNote } : {}) });
}

export function writeFile(review, relative, contents) {
  const file = path.join(review.root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}
