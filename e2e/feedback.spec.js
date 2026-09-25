import fs from "node:fs";
import { test, expect, openReview, waitForSdk, enterEditMode, writeFile, feedback, intercept, failure, conversation, seedThread } from "./helpers.js";

async function setup(page, review, name = "feedback.html") {
  const file = writeFile(review, name, "<!doctype html><p id='copy'>Original paragraph</p><input aria-label='Authored input'>");
  const ref = await openReview(page, review, file);
  await waitForSdk(page); await feedback(page);
  return { file, ref };
}
async function edit(page, suffix) {
  await page.getByRole("complementary", { name: "Feedback" }).getByRole("button", { name: "Close", exact: true }).click();
  const frame = await enterEditMode(page);
  await frame.locator("#copy").click(); await page.keyboard.press("End"); await page.keyboard.insertText(suffix);
}
async function actionsFit(page, width, height) {
  for (const id of ["endReview", "send"]) await expect.poll(async () => {
    const box = await page.locator(`#${id}`).boundingBox();
    return box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height;
  }).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const [width, height] of [[320, 480], [320, 560], [390, 560], [768, 560], [1440, 560]]) {
  for (const theme of ["light", "dark"]) {
    test(`note identity, independent inventory and safe shared-End dialog at ${width}x${height} ${theme}`, async ({ page, review }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript((theme) => localStorage.setItem("doc-review:theme", theme), theme);
      const { ref } = await setup(page, review, `footer-${width}-${height}-${theme}.html`);
      for (let i = 0; i < 8; i++) await seedThread(review, ref, `Saved message ${i}`);
      await expect(page.locator(".conversation-thread")).toHaveCount(8);
      await page.getByRole("button", { name: /Overall note \(optional\)/ }).click();
      const note = page.getByRole("textbox", { name: "Overall note" });
      await note.fill("Keep this overall note");
      await note.evaluate((element) => { window.savedNote = element; window.savedFrame = document.querySelector("#frame"); element.setSelectionRange(5, 9); element.dispatchEvent(new Event("select", { bubbles: true })); });
      await page.locator("#theme").click(); await page.locator("#theme").click();
      await page.getByRole("complementary", { name: "Feedback" }).getByRole("button", { name: "Close", exact: true }).click(); await feedback(page);
      expect(await note.evaluate((element) => element === window.savedNote && document.querySelector("#frame") === window.savedFrame)).toBe(true);
      expect(await note.evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual([5, 9]);
      await actionsFit(page, width, height);
      const y = (await page.locator("#send").boundingBox()).y;
      await page.locator(".conversation-inventory").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      expect((await page.locator("#send").boundingBox()).y).toBe(y);
      await page.locator("#endReview").click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("for every tab");
      await expect(dialog).toContainText("not durable");
      await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath(`shared-end-${width}-${height}-${theme}.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden(); await expect(page.locator("#endReview")).toBeFocused();
      await expect(note).toHaveValue("Keep this overall note");
      await page.keyboard.press("Tab"); await expect(page.locator("#send")).toBeFocused();
    });
  }
}

test("uncertain Send preserves newer typing and retries exactly one identity with an exact-review handoff", async ({ page, review }) => {
  const { ref } = await setup(page, review);
  const bodies = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await intercept(page, "send", async (route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) return failure(route, "Send acceptance unknown");
    await gate; await route.continue();
  });
  await page.getByRole("button", { name: /Overall note \(optional\)/ }).click();
  const note = page.getByRole("textbox", { name: "Overall note" });
  await note.fill("First note"); await page.locator("#send").click();
  await expect(page.getByRole("alert")).toContainText("Send acceptance unknown");
  await page.getByRole("button", { name: "Retry same request" }).click();
  await expect(page.locator("#send")).toBeDisabled();
  await note.fill("Newer note"); release();
  await expect(page.getByText("Queued; not received", { exact: true })).toBeVisible();
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
  await expect(note).toHaveValue("Newer note");
  await page.getByText("Agent command", { exact: true }).click();
  await expect(page.locator(".conversation-handoff code")).toContainText(ref.reviewId);
  await expect(page.locator(".conversation-handoff code")).toContainText(ref.entryKey);
  await expect(page.locator(".conversation-handoff code")).not.toContainText("--ack");
});

test("optional capture failure is independent of delivery and never introduces a Send override", async ({ page, review }) => {
  await page.addInitScript(() => {
    if (window === parent) return;
    window.addEventListener("message", (event) => {
      if (event.data?.type !== "eh:captureSnapshot") return;
      event.stopImmediatePropagation();
      parent.postMessage({ ...event.data, type: "eh:snapshot", error: "The page is still changing" }, "*");
    }, true);
  });
  const { ref } = await setup(page, review, "capture-failure.html");
  await page.getByRole("button", { name: /Overall note \(optional\)/ }).click();
  await page.getByRole("textbox", { name: "Overall note" }).fill("Send independently");
  await page.locator("#send").click();
  await expect(page.getByText("Queued; not received", { exact: true })).toBeVisible();
  await expect(page.getByText(/Comparison baseline unavailable/)).toContainText("Feedback delivery is independent");
  expect((await conversation(review, ref, "status")).work.state).toBe("queued");
  await expect(page.getByRole("button", { name: /Send without/ })).toHaveCount(0);
});

test("Revert Cancel preserves edits; confirmation is single-flight and preserves the overall note", async ({ page, review }) => {
  const { file } = await setup(page, review, "revert.html");
  const before = fs.readFileSync(file, "utf8");
  await edit(page, " changed");
  await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("paragraph changed");
  await feedback(page); await page.getByRole("button", { name: /Overall note \(optional\)/ }).click();
  await page.getByRole("textbox", { name: "Overall note" }).fill("Keep note");
  const revert = page.getByRole("button", { name: "Revert", exact: true });
  await revert.click(); await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(revert).toBeFocused(); expect(fs.readFileSync(file, "utf8")).toContain("changed");
  let requests = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  await intercept(page, "revert", async (route) => { requests++; await gate; await route.continue(); });
  await revert.click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Confirm" }).evaluate((button) => { button.click(); button.click(); });
  await expect.poll(() => requests).toBe(1);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
  release(); await expect(dialog).toBeHidden();
  await expect.poll(() => fs.readFileSync(file, "utf8")).toBe(before);
  await expect(page.getByRole("textbox", { name: "Overall note" })).toHaveValue("Keep note");
  await expect(page.getByText("Source pending", { exact: true })).toBeVisible();
});

test("stale End confirmation rejects explicitly without losing drafts; renewed confirmation ends once", async ({ page, review }) => {
  const { ref } = await setup(page, review, "stale-end.html");
  await page.getByRole("button", { name: /Overall note \(optional\)/ }).click();
  await page.getByRole("textbox", { name: "Overall note" }).fill("Unsent draft");
  await page.locator("#endReview").click();
  await seedThread(review, ref, "Concurrent saved work");
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("alert")).toContainText(/version|changed|stale/i);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.locator("#endReview").click();
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".conversation-lifecycle")).toHaveText("Review ended");
  await expect(page.getByRole("textbox", { name: "Overall note" })).toHaveValue("Unsent draft");
  expect((await conversation(review, ref, "read-review")).state).toBe("ended");
});

for (const action of ["Send", "Revert", "End"]) {
  test(`${action} cannot cross a failed exact edit-record barrier or claim source success`, async ({ page, review }) => {
    const { file, ref } = await setup(page, review, `barrier-${action}.html`);
    await edit(page, " first");
    await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("paragraph first");
    await intercept(page, "record-edit", (route) => failure(route, "Exact edit could not be recorded", "VERSION_CONFLICT"));
    await page.frameLocator("#frame").locator("#copy").click(); await page.keyboard.press("End"); await page.keyboard.insertText(" second");
    await expect(page.getByRole("alert")).toContainText("Exact edit could not be recorded");
    await feedback(page); await page.getByRole("button", { name: /Overall note \(optional\)/ }).click();
    await page.getByRole("textbox", { name: "Overall note" }).fill("Preserve this");
    let requests = 0;
    await intercept(page, action.toLowerCase(), async (route) => { requests++; await route.continue(); });
    await page.getByRole("button", { name: action === "End" ? "End review" : action, exact: true }).click();
    if (action !== "Send") await page.getByRole("alertdialog").getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("alert")).toContainText(/record|persist|save|edit/i);
    expect(requests).toBe(0);
    expect((await conversation(review, ref, "read-review")).state).toBe("open");
    expect(fs.readFileSync(file, "utf8")).not.toContain("second");
    if (action !== "Send") await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("textbox", { name: "Overall note" })).toHaveValue("Preserve this");
  });
}
