import { test, expect, openReview, waitForSdk, writeFile, seedThread, feedback, intercept, failure, mutate, listed } from "./helpers.js";
import { threadAction } from "./conversation-actions.js";

const source = `<!doctype html><html><head><style>
body{padding:24px;font:17px/1.6 system-ui;color:#263142;background:white}input{max-width:100%;box-sizing:border-box}
</style></head><body><h1>Conversation inventory</h1><p id="copy">A paragraph for the conversation inventory.</p>
<label>Page draft <input aria-label="Page draft" value="Keep this page-owned input"></label></body></html>`;
async function populated(page, review, count = 2) {
  const ref = await openReview(page, review, writeFile(review, `inventory-${test.info().line}.html`, source));
  for (let i = 0; i < count; i++) await seedThread(review, ref, `Message ${i + 1}: ${i === 0 ? "Long feedback ".repeat(35) : "Make this paragraph clearer."}`);
  const frame = await waitForSdk(page); await feedback(page);
  await expect(page.locator(".conversation-thread")).toHaveCount(count);
  return { ref, frame };
}
const button = (card, name) => card.getByRole("button", { name, exact: true });
const note = (page) => page.getByRole("textbox", { name: "Overall note", exact: true });

test("long inventory and direct actions fit every width without remounting document or note", async ({ page, review }, info) => {
  test.setTimeout(60000);
  const { frame } = await populated(page, review, 24);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#frame").evaluate((element) => { window.originalFrame = element; });
  await note(page).fill("Keep this overall feedback note");
  await note(page).evaluate((element) => {
    window.originalNote = element; element.setSelectionRange(2, 8);
    element.dispatchEvent(new Event("select", { bubbles: true }));
  });
  const inventory = page.locator(".conversation-inventory");
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const bounds = await page.getByRole("complementary", { name: "Feedback" }).boundingBox();
      expect(bounds.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await inventory.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await inventory.evaluate((element) => { element.scrollTop = 0; });
      const first = page.locator(".conversation-thread").first();
      for (const name of ["Show target", "Edit message", "Conversation actions"]) {
        const action = button(first, name);
        await action.focus(); await action.press("Tab"); await page.keyboard.press("Shift+Tab");
        await expect(action).toBeFocused();
        expect(await action.evaluate((element) => {
          const style = getComputedStyle(element);
          return style.boxShadow !== "none" || style.outlineStyle !== "none";
        })).toBe(true);
        const box = await action.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(bounds.x);
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      }
      await (await threadAction(page, first, "Delete thread")).click();
      await expect(button(page.getByRole("alertdialog"), "Cancel")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(button(first, "Conversation actions")).toBeFocused();
      const before = await page.locator("#send").boundingBox();
      await inventory.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      expect((await page.locator("#send").boundingBox()).y).toBe(before.y);
      await expect(page.locator(".conversation-thread").last()).toContainText("Long feedback");
      await page.screenshot({ path: info.outputPath(`inventory-${theme}-${width}.png`), animations: "disabled" });
    }
  }
  expect(await page.locator("#frame").evaluate((element) => element === window.originalFrame)).toBe(true);
  expect(await note(page).evaluate((element) => ({
    same: element === window.originalNote, text: element.value, selection: [element.selectionStart, element.selectionEnd],
  }))).toEqual({ same: true, text: "Keep this overall feedback note", selection: [2, 8] });
  await expect(frame.getByLabel("Page draft")).toHaveValue("Keep this page-owned input");
  expect(errors).toEqual([]);
});

test("textarea and selection survive unrelated updates, a rejected edit, and explicit retry", async ({ page, review }) => {
  const { ref } = await populated(page, review);
  const id = await page.locator(".conversation-thread").first().getAttribute("data-thread");
  const card = page.locator(`[data-thread="${id}"]`);
  await button(card, "Edit message").click();
  const input = card.getByRole("textbox", { name: "Edit message", exact: true });
  await input.fill("Keep the edited draft");
  await input.evaluate((element) => {
    window.originalEditor = element; element.setSelectionRange(3, 9);
    element.dispatchEvent(new Event("select", { bubbles: true }));
  });
  await note(page).fill("Unrelated overall note");
  await seedThread(review, ref, "Another browser saved this");
  await page.locator("#theme").click();
  expect(await input.evaluate((element) => ({ same: element === window.originalEditor, selection: [element.selectionStart, element.selectionEnd] })))
    .toEqual({ same: true, selection: [3, 9] });
  let attempts = 0;
  await intercept(page, "update-message", (route) => ++attempts === 1
    ? failure(route, "Try editing again", "VERSION_CONFLICT") : route.continue());
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Try editing again");
  await expect(input).toHaveValue("Keep the edited draft"); await expect(input).toBeFocused();
  await expect(button(card, "Save message")).toBeEnabled();
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  await expect(card).toContainText("Keep the edited draft");
  await expect(button(card, "Edit message")).toBeFocused();
  expect(attempts).toBe(2);
});

test("one guarded confirmation restores each trigger without deleting or stealing authored focus", async ({ page, review }) => {
  const { ref, frame } = await populated(page, review);
  for (let attempt = 0; attempt < 4; attempt++) for (const card of [page.locator(".conversation-thread").first(), page.locator(".conversation-thread").last()]) {
    const trigger = button(card, "Conversation actions");
    await (await threadAction(page, card, "Delete thread")).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(1);
    await expect(button(page.getByRole("alertdialog"), "Cancel")).toBeFocused();
    if (attempt % 2) await button(page.getByRole("alertdialog"), "Cancel").click();
    else await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
  await frame.getByLabel("Page draft").focus();
  expect(await frame.getByLabel("Page draft").evaluate((element) => document.activeElement === element)).toBe(true);
  expect((await listed(review, ref, "threads")).totalCount).toBe(2);
});

test("confirmed deletion is single-flight and leaves a reachable keyboard target", async ({ page, review }) => {
  await populated(page, review);
  let deletes = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  await intercept(page, "delete-thread", async (route) => { deletes++; await gate; await route.continue(); });
  const first = page.locator(".conversation-thread").first();
  await (await threadAction(page, first, "Delete thread")).click();
  try {
    await button(page.getByRole("alertdialog"), "Confirm").evaluate((element) => { element.click(); element.click(); });
    await expect(button(page.getByRole("alertdialog"), "Confirm")).toBeDisabled();
    await expect(button(page.getByRole("alertdialog"), "Cancel")).toBeDisabled();
    await page.keyboard.press("Escape"); await expect(page.getByRole("alertdialog")).toBeVisible();
    await expect.poll(() => deletes).toBe(1);
  } finally { release(); }
  await expect(page.locator(".conversation-thread")).toHaveCount(1);
  await expect(page.locator(".conversation-thread-title")).toBeFocused();
  await (await threadAction(page, page.locator(".conversation-thread"), "Delete thread")).click();
  await button(page.getByRole("alertdialog"), "Confirm").click();
  await expect(page.locator(".conversation-thread")).toHaveCount(0);
  await expect(page.getByText(/No conversations yet/)).toBeVisible();
  await expect(page.locator("#commentsButton")).toBeFocused();
  expect(deletes).toBe(2);
});

test("shared inventory includes unvisited member pages and Show target navigates the right member", async ({ page, review }) => {
  const other = writeFile(review, "another-reviewed-document-with-a-long-file-name.html", source);
  const ref = await openReview(page, review, writeFile(review, "inventory-entry.html", source));
  const joined = await mutate(review, ref, "join-page", { target: other });
  for (let i = 0; i < 3; i++) await seedThread(review, { ...ref, key: joined.value.pageKey }, `Other-page message ${i + 1}`);
  await feedback(page); await expect(page.locator(".conversation-thread")).toHaveCount(3);
  await page.locator(".conversation-thread-title").first().press("Enter");
  await expect(page.locator(".conversation-thread-title").first()).toHaveAttribute("aria-expanded", "false");
  await button(page.locator(".conversation-thread").first(), "Show target").click();
  await waitForSdk(page);
  await expect(page.locator("#reviewPage")).toHaveAttribute("data-value", joined.value.pageKey);
  await expect(page.locator(".conversation-thread-title").first()).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".conversation-thread")).toHaveCount(3);
  await page.locator("#send").click();
  await expect(page.getByText("Queued; not received", { exact: true })).toBeVisible();
});

test("message editing validates text, respects composition and coalesces Save while allowing typing", async ({ page, review }) => {
  const { ref } = await populated(page, review, 1);
  const card = page.locator(".conversation-thread");
  await button(card, "Edit message").click();
  const input = card.getByRole("textbox", { name: "Edit message", exact: true });
  await input.fill("   "); await expect(button(card, "Save message")).toBeDisabled();
  let updates = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  await intercept(page, "update-message", async (route) => { updates++; await gate; await route.continue(); });
  try {
    await input.fill("Composition draft"); await input.dispatchEvent("compositionstart");
    await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    await expect(input).toHaveValue("Composition draft"); await expect(button(card, "Save message")).toBeDisabled();
    expect(updates).toBe(0);
    await input.dispatchEvent("compositionend");
    await input.evaluate((element) => {
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await expect.poll(() => updates).toBe(1);
    await expect(input).toBeEditable();
    await expect(button(card, "Cancel")).toBeDisabled();
    await input.fill("Newer unsaved correction");
  } finally { release(); }
  await expect(button(card, "Save message")).toBeEnabled();
  await expect(input).toHaveValue("Newer unsaved correction");
  expect((await listed(review, ref, "threads")).items[0].latestExchange.reviewer.body).toBe("Composition draft");
  expect(updates).toBe(1);
});
