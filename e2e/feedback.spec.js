import fs from "node:fs";
import path from "node:path";
import { test, expect, openReview, waitForSdk, enterEditMode, reviewApi, writeFile } from "./helpers.js";

async function setup(page, review, name = "feedback.html") {
  const file = writeFile(review, name, "<!doctype html><h1>Feedback candidate</h1><p id='copy'>Original paragraph</p><label>Authored input <input aria-label='Authored input'></label>");
  const session = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await page.locator("#commentsButton").click();
  return { file, session, frame };
}

test("disposable feedback preview fixture seeds edits and keeps primary Send above supporting scroll", async ({ page, review }) => {
  const target = writeFile(review, "feedback-preview.html", fs.readFileSync(path.join(process.cwd(), "test", "fixtures", "feedback-review.html"), "utf8"));
  const opened = await reviewApi(review, "/api/session", { method: "POST", body: { target } });
  const session = opened.json();
  for (let index = 0; index < 7; index++) {
    const result = await reviewApi(review, `/api/page/${session.key}/edit`, {
      method: "POST", body: { label: `Sample paragraph ${index + 1}`, kind: index === 2 ? "deleted" : "edited", before: "Original sample", after: index === 2 ? "" : "Revised sample", feedback_only: true },
    });
    expect(result.status).toBe(200);
  }
  await page.setViewportSize({ width: 320, height: 480 });
  await page.goto(`http://127.0.0.1:${review.port}${session.path}`);
  await waitForSdk(page);
  await page.locator("#commentsButton").click();
  await expect(page.locator("#editCount")).toHaveText("7");
  await expect(page.locator("#editList li")).toHaveCount(5);
  await page.getByRole("button", { name: "2 more…" }).click();
  await expect(page.locator("#editList li")).toHaveCount(7);
  await page.locator("#send").click();
  await expect(page.locator("#handoff")).toBeVisible({ timeout: 15000 });
  await page.locator(".feedback-secondary").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => page.locator("#send").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight;
  })).toBe(true);
});
for (const width of [320, 390, 768, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`feedback note, short-screen footer and safe dialog ${width} ${theme}`, async ({ page, review }, testInfo) => {
      await page.setViewportSize({ width, height: 560 });
      await page.addInitScript((value) => localStorage.setItem("doc-review:theme", value), theme);
      const { frame } = await setup(page, review, `feedback-${width}-${theme}.html`);
      const note = page.getByLabel("Overall note");
      await note.fill("Keep this overall note");
      await note.evaluate((element) => {
        window.g6Note = element; window.g6Frame = document.getElementById("frame");
        element.setSelectionRange(5, 9);
        element.dispatchEvent(new Event("select", { bubbles: true }));
      });
      await page.getByRole("button", { name: /Switch chrome to/ }).click();
      await page.getByRole("button", { name: /Switch chrome to/ }).click();
      await page.locator("#drawerClose").click();
      await page.locator("#seeChanges").click();
      await page.locator("#latestVersion").click();
      await page.locator("#commentsButton").click();
      await expect(note).toHaveValue("Keep this overall note");
      expect(await note.evaluate((element) => element === window.g6Note && document.getElementById("frame") === window.g6Frame)).toBe(true);
      await expect.poll(() => note.evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual([5, 9]);
      await expect(frame.locator("#copy")).toHaveText("Original paragraph");
      const send = page.locator("#send");
      await expect(send).toBeEnabled();
      await expect.poll(async () => {
        const box = await send.boundingBox();
        return box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 560;
      }).toBe(true);
      await page.locator("#endReview").click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
      await expect(dialog).toContainText("only in this tab");
      await page.screenshot({ path: testInfo.outputPath(`g6-dialog-${width}-${theme}.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(page.locator("#endReview")).toBeFocused();
      await expect(page.locator("#drawer")).toHaveClass(/open/);
      await expect(page.locator("#drawer")).not.toHaveAttribute("aria-hidden", "true");
      await expect(note).toHaveValue("Keep this overall note");
      await page.keyboard.press("Shift+Tab");
      await expect(send).toBeFocused();
      await expect.poll(() => send.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
    });
  }
}

test("send flight preserves new note, reports ambiguous error, retries explicitly and copies handoff", async ({ page, context, review }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { session } = await setup(page, review);
  let attempts = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const bodies = [];
  await page.route("**/api/page/*/send", async (route) => {
    attempts++; bodies.push(route.request().postDataJSON());
    if (attempts === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Service unavailable" }) });
    await pending;
    await route.continue();
  });
  await page.locator("#note").fill("First note");
  await page.locator("#send").click();
  await expect(page.getByRole("alert")).toContainText("No automatic retry");
  await expect(page.locator("#note")).toHaveValue("First note");
  await page.locator("#send").click();
  await expect(page.locator("#send")).toBeDisabled();
  await page.locator("#send").evaluate((element) => element.click());
  await page.locator("#note").fill("A newer note");
  release();
  await expect.poll(() => attempts).toBe(2);
  await expect(page.locator("#note")).toHaveValue("A newer note");
  await expect(page.locator("#send")).toContainText(/Sent|delivered/);
  expect(bodies[1].note).toBe("First note");
  await expect(page.locator("#handoff")).toBeVisible({ timeout: 15000 });
  await page.locator("#handoffCopy").click();
  await expect(page.locator("#handoffCopy")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("--timeout 600");
  const response = await reviewApi(review, `/api/page/${session.key}`);
  expect(response.status).toBe(200);
});

test("optional capture failure presents a notice after sending, never a new gate", async ({ page, review }) => {
  const { frame } = await setup(page, review, "capture-optional.html");
  await frame.locator("body").evaluate(() => {
    window.addEventListener("message", (event) => {
      if (event.data?.type === "eh:captureSnapshot") {
        parent.postMessage({ ...event.data, type: "eh:snapshot", error: "The page is still changing" }, "*");
      }
    });
  });
  let attempts = 0, sent;
  await page.route("**/api/page/*/send", async (route) => {
    attempts++;
    sent = route.request().postDataJSON();
    await route.continue();
  });
  await page.locator("#note").fill("Send despite optional capture");
  await page.locator("#send").click();
  await expect(page.locator("#note")).toHaveValue("");
  await expect(page.locator("#captureNotice")).toContainText("comparison may be incomplete");
  await expect(page.locator("#recaptureBaseline, #sendWithoutComparison")).toHaveCount(0);
  expect(attempts).toBe(1);
  expect(sent.history.allowUnavailable).toBe(true);
  expect(sent.history.semantic).toBeNull();
});

test("Revert cancel keeps edits; pending confirmation submits once, restores source and retains note", async ({ page, review }) => {
  const { file } = await setup(page, review, "revert-feedback.html");
  const source = fs.readFileSync(file, "utf8");
  await page.locator("#drawerClose").click();
  const frame = await enterEditMode(page);
  await frame.locator("#copy").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" changed");
  await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("paragraph changed");
  await page.locator("#commentsButton").click();
  await page.locator("#note").fill("Retain note");
  await expect(page.locator("#saveText")).toContainText("Saved to");
  await page.locator("#revert").click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#revert")).toBeFocused();
  expect(fs.readFileSync(file, "utf8")).toContain("paragraph changed");
  let requests = 0, release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/page/*/revert", async (route) => { requests++; await pending; await route.continue(); });
  await page.locator("#revert").click();
  await dialog.getByRole("button", { name: "Revert all", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Revert all", exact: true }).evaluate((element) => element.click());
  await expect.poll(() => requests).toBe(1);
  release();
  await expect(dialog).toBeHidden();
  await expect.poll(() => fs.readFileSync(file, "utf8")).toBe(source);
  await expect(page.locator("#note")).toHaveValue("Retain note");
});

test("End becomes stale after source reload; failure is explicit and confirm retry is single flight", async ({ page, review }) => {
  const { file } = await setup(page, review, "end-stale.html");
  await page.locator("#note").fill("Unsent draft");
  await page.locator("#endReview").click();
  const dialog = page.getByRole("alertdialog");
  fs.writeFileSync(file, "<h1>New source</h1>");
  // A source transition must never authorize the old confirmation.
  await expect.poll(async () => (await dialog.isVisible()) ? await dialog.getByRole("button", { name: "End review", exact: true }).isDisabled() : true).toBe(true);
  if (await dialog.isVisible()) await dialog.getByRole("button", { name: "Cancel" }).click();
  await waitForSdk(page);
  await page.locator("#endReview").click();
  let attempts = 0;
  await page.route("**/api/session/*/end", async (route) => {
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "End unavailable" }) });
    await route.continue();
  });
  await dialog.getByRole("button", { name: "End review", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("End unavailable");
  await expect(page.locator("#note")).toHaveValue("Unsent draft");
  await dialog.getByRole("button", { name: "End review", exact: true }).click();
  await expect(page.locator(".ended")).toBeVisible();
  expect(attempts).toBe(2);
});

for (const action of ["revert", "end"]) {
  test(`${action} keeps its persistence contract when a later edit cannot be recorded`, async ({ page, review }) => {
    const { file, session } = await setup(page, review, `${action}-failed-edit.html`);
    const source = fs.readFileSync(file, "utf8");
    await page.locator("#drawerClose").click();
    const frame = await enterEditMode(page);
    await frame.locator("#copy").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" first");
    await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("paragraph first");
    await expect.poll(async () => (await reviewApi(review, `/api/page/${session.key}`)).json().edits.length).toBe(1);
    let failedEdits = 0, requests = 0, releaseEdit, releaseAction;
    const retry = new Promise((resolve) => { releaseEdit = resolve; });
    const mutation = new Promise((resolve) => { releaseAction = resolve; });
    const order = [];
    await page.route("**/api/page/*/edit", async (route) => {
      const attempt = ++failedEdits;
      order.push(`edit-${attempt}`);
      if (attempt === 2) await retry;
      await route.fulfill({ status: 503, json: { error: "Queued edit unavailable" } });
      order.push(`failed-${attempt}`);
    });
    await page.route(action === "revert" ? "**/api/page/*/revert" : "**/api/session/*/end", async (route) => {
      requests++;
      order.push(action);
      await mutation;
      await route.continue();
    });
    await page.keyboard.type(" second");
    await expect.poll(() => failedEdits).toBe(1);
    await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("paragraph first second");
    await page.locator("#commentsButton").click();
    await page.locator("#note").fill("Keep this note");
    await page.locator(action === "revert" ? "#revert" : "#endReview").click();
    const dialog = page.getByRole("alertdialog");
    const confirm = dialog.getByRole("button", { name: action === "revert" ? "Revert all" : "End review", exact: true });
    await confirm.click();
    await expect.poll(() => failedEdits).toBe(2);
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    expect(requests).toBe(0);
    await confirm.evaluate((element) => element.click());
    releaseEdit();
    if (action === "revert") {
      await expect.poll(() => requests).toBe(1);
      expect(order).toEqual(["edit-1", "failed-1", "edit-2", "failed-2", "revert"]);
      releaseAction();
      await expect(dialog).toBeHidden();
      await expect.poll(() => fs.readFileSync(file, "utf8")).toBe(source);
      await waitForSdk(page);
      await expect.poll(async () => (await reviewApi(review, `/api/page/${session.key}`)).json().edits.length).toBe(0);
      await expect(page.locator("#editCount")).toHaveText("0");
      expect(requests).toBe(1);
    } else {
      await expect(dialog.getByRole("alert")).toContainText("Queued edit unavailable");
      await expect(confirm).toBeEnabled();
      expect(requests).toBe(0);
      expect(fs.readFileSync(file, "utf8")).toContain("paragraph first second");
      releaseAction();
    }
    await expect(page.locator("#note")).toHaveValue("Keep this note");
  });
}
