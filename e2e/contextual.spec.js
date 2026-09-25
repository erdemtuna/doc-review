import fs from "node:fs";
import { threadAction } from "./conversation-actions.js";
import { test, expect, openReview, waitForSdk, writeFile, selectText, intercept, failure, listed, feedback } from "./helpers.js";

const source = fs.readFileSync(new URL("../test/fixtures/contextual-review.html", import.meta.url), "utf8");
async function select(frame) {
  await selectText(frame, "#detail");
  await frame.locator("#commentAction").click();
}
for (const theme of ["light", "dark"]) for (const width of [320, 390, 768, 1440]) {
  test(`contextual controls fit ${width}px ${theme} and preserve document and draft identity`, async ({ page, review }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await openReview(page, review, writeFile(review, `context-${theme}-${width}.html`, source));
    const frame = await waitForSdk(page);
    if (theme === "dark") await page.locator("#theme").click();
    await frame.getByLabel("Page-owned draft").fill("Authored input stays");
    await page.locator("#frame").evaluate((element) => { window.originalFrame = element; });
    await select(frame);
    const field = page.getByRole("textbox", { name: "New message", exact: true });
    await field.fill("Keep this contextual draft");
    await field.evaluate((element) => {
      window.originalComposer = element; element.setSelectionRange(5, 9);
      element.dispatchEvent(new Event("select", { bubbles: true }));
    });
    await page.locator("#theme").click(); await page.locator("#theme").click();
    expect(await field.evaluate((element) => ({ same: element === window.originalComposer, selection: [element.selectionStart, element.selectionEnd] })))
      .toEqual({ same: true, selection: [5, 9] });
    await field.focus();
    expect(await field.evaluate((element) => {
      const style = getComputedStyle(element);
      return style.boxShadow !== "none" || (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2);
    })).toBe(true);
    const panel = page.locator(".conversation-panel");
    const box = await panel.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(900);
    await expect(panel).not.toHaveAttribute("aria-modal", "true");
    await page.screenshot({ path: info.outputPath(`composer-${theme}-${width}.png`), animations: "disabled" });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(field).toHaveCount(0);
    await feedback(page);
    const card = page.locator(".conversation-thread");
    await expect(card).toHaveCount(1);
    // Closing does not activate an adjacent conversation; activation is explicit.
    await page.locator(".conversation-panel-header").getByRole("button", { name: "Close", exact: true }).click();
    await frame.locator("mark[data-eh-mark]").first().click();
    await expect(card).toBeVisible();
    const adjacent = await panel.getAttribute("data-host") === "adjacent";
    if (!adjacent) await expect(page.getByText(/not enough room beside, above or below/)).toBeVisible();
    else {
      const surface = await panel.boundingBox(), target = await frame.locator("mark[data-eh-mark]").first().boundingBox();
      expect(surface.x >= target.x + target.width || surface.x + surface.width <= target.x ||
        surface.y >= target.y + target.height || surface.y + surface.height <= target.y).toBe(true);
    }
    if (adjacent) await expect(card.locator(".conversation-jump")).toBeHidden();
    for (const name of [...(adjacent ? [] : ["Jump to"]), "Edit message", "Conversation actions"]) {
      const action = card.getByRole("button", { name, exact: true });
      await action.focus(); await action.press("Tab"); await page.keyboard.press("Shift+Tab");
      await expect(action).toBeFocused();
      expect(await action.evaluate((element) => {
        const style = getComputedStyle(element);
        return style.boxShadow !== "none" || (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2);
      })).toBe(true);
    }
    await card.getByRole("button", { name: "Edit message", exact: true }).click();
    const edit = card.getByRole("textbox", { name: "Edit message", exact: true });
    await edit.fill("Revised contextual draft");
    await edit.evaluate((element) => {
      window.originalEditor = element; element.setSelectionRange(2, 7);
      element.dispatchEvent(new Event("select", { bubbles: true }));
    });
    await page.locator("#theme").click(); await page.locator("#theme").click();
    expect(await edit.evaluate((element) => ({ same: element === window.originalEditor, selection: [element.selectionStart, element.selectionEnd] })))
      .toEqual({ same: true, selection: [2, 7] });
    await edit.press("Escape");
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    let deletes = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/conversation") && request.postDataJSON()?.operation === "delete-thread") deletes++;
    });
    const trigger = card.getByRole("button", { name: "Conversation actions", exact: true });
    for (const cancel of ["Escape", "Cancel"]) {
      await (await threadAction(page, card, "Delete thread")).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("Delete");
      await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
      const bounds = await dialog.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      if (cancel === "Escape") await page.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(trigger).toBeFocused();
      await expect(dialog).toHaveCount(0);
    }
    expect(deletes).toBe(0);
    expect(await page.locator("#frame").evaluate((element) => element === window.originalFrame)).toBe(true);
    await expect(frame.getByLabel("Page-owned draft")).toHaveValue("Authored input stays");
    await page.screenshot({ path: info.outputPath(`conversation-${theme}-${width}.png`), animations: "disabled" });
  });
}

test("failed composer keeps one field and caret through retry with synchronous IME events", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "context-failure.html", source));
  const frame = await waitForSdk(page); await select(frame);
  const field = page.getByRole("textbox", { name: "New message", exact: true });
  await field.fill("Original draft after failed request");
  await field.evaluate((element) => {
    window.originalComposer = element; element.setSelectionRange(3, 8);
    element.dispatchEvent(new Event("select", { bubbles: true }));
  });
  let posts = 0;
  await intercept(page, "create-thread", (route) => {
    posts++;
    return posts === 1 ? failure(route, "Conversation service unavailable", "VERSION_CONFLICT") : route.continue();
  });
  await field.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
  expect(posts).toBe(0);
  await field.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Conversation service unavailable");
  await expect(field).toBeFocused();
  expect(await field.evaluate((element) => ({ same: element === window.originalComposer, selection: [element.selectionStart, element.selectionEnd] })))
    .toEqual({ same: true, selection: [3, 8] });
  await field.press("Enter");
  await expect(field).toHaveCount(0);
  expect((await listed(review, ref, "threads")).totalCount).toBe(1);
  expect(posts).toBe(2);
});

test("late successful save after source reload clears only its captured draft, not newer typing", async ({ page, review }) => {
  const target = writeFile(review, "context-late.html", source);
  const ref = await openReview(page, review, target);
  const frame = await waitForSdk(page); await select(frame);
  const field = page.getByRole("textbox", { name: "New message", exact: true });
  await field.fill("Submitted before reload");
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const requested = new Promise((resolve) => { started = resolve; });
  await intercept(page, "create-thread", async (route) => {
    const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
  });
  try {
    await field.press("Enter"); await requested;
    await field.fill("Newer draft retained during reload");
    const previous = await page.locator("#frame").getAttribute("src");
    fs.writeFileSync(target, source.replace("A good review explains", "Updated source explains"));
    await expect(page.locator("#frame")).not.toHaveAttribute("src", previous);
    await waitForSdk(page); release();
    await expect(field).toHaveValue("Newer draft retained during reload");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    expect((await listed(review, ref, "threads")).totalCount).toBe(1);
    await field.press("Escape");
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(field).toHaveCount(0);
  } finally { release(); }
});
