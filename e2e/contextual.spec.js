import fs from "node:fs";
import { test, expect, openReview, waitForSdk, writeFile, reviewApi } from "./helpers.js";

const source = fs.readFileSync(new URL("../test/fixtures/contextual-review.html", import.meta.url), "utf8");
async function select(frame, selector = "#detail") {
  await frame.locator(selector).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await frame.locator("#commentAction").click();
}
for (const theme of ["light", "dark"]) for (const width of [320, 390, 768, 1440]) {
  test(`G5 contextual controls fit ${width}px ${theme} and preserve document and draft identity`, async ({ page, review }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await openReview(page, review, writeFile(review, `context-${theme}-${width}.html`, source));
    const frame = await waitForSdk(page);
    if (theme === "dark") await page.locator("#theme").click();
    await frame.getByLabel("Page-owned draft").fill("Authored input stays");
    await page.locator("#frame").evaluate((element) => { window.g5Frame = element; });
    await select(frame);
    const field = page.getByRole("textbox", { name: "Comment", exact: true });
    await field.fill("Keep this contextual draft");
    await field.evaluate((element) => { window.g5Composer = element; element.setSelectionRange(5, 9); element.dispatchEvent(new Event("select", { bubbles: true })); });
    await page.locator("#theme").click();
    await page.locator("#theme").click();
    expect(await field.evaluate((element) => ({ same: element === window.g5Composer, selection: [element.selectionStart, element.selectionEnd] })))
      .toEqual({ same: true, selection: [5, 9] });
    await field.focus();
    const focusSpacing = await field.evaluate((element) => {
      const style = getComputedStyle(element);
      const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      const hints = document.getElementById("composeHelp").getBoundingClientRect();
      return {
        outline: style.outlineStyle,
        width: parseFloat(style.outlineWidth),
        clearance: hints.top - element.getBoundingClientRect().bottom - ring,
      };
    });
    expect(focusSpacing.outline).toBe("solid");
    expect(focusSpacing.width).toBeGreaterThanOrEqual(2);
    expect(focusSpacing.clearance).toBeGreaterThanOrEqual(4);
    const compose = page.locator("#compose");
    const box = await compose.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(901);
    await expect(compose).toHaveAttribute("aria-modal", "false");
    await page.screenshot({ path: info.outputPath(`g5-compose-${theme}-${width}.png`), animations: "disabled" });
    await page.locator("#composeAdd").click();
    await expect(compose).toBeHidden();
    await expect(page.locator("#count")).toHaveText("1");
    await expect(page.locator("#toolbarCount")).toHaveText("1");
    await expect(page.locator("#commentsButton")).toHaveAccessibleName("Feedback");
    await frame.locator("mark[data-eh-mark]").first().click();
    if (width <= 720) await page.locator("#commentsButton").click();
    const card = width <= 720 ? page.locator("#cards article").first() : page.locator("#alignedCard");
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: "More", exact: true })).toHaveCount(0);
    await expect(card.getByRole("menu")).toHaveCount(0);
    const actions = width <= 720
      ? ["Jump to", "Edit comment", "Delete comment"]
      : ["Edit comment", "Delete comment", "Close comment card"];
    for (const name of actions) {
      const action = card.getByRole("button", { name, exact: true });
      await expect(action).toHaveAttribute("aria-label", name);
      await expect(action).toHaveAttribute("title", name);
      await expect(action).toHaveText("");
      await expect(action.locator("svg")).toHaveCount(1);
      await action.hover();
      await expect.poll(() => action.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
      await page.mouse.move(0, 0);
      await action.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(action).toBeFocused();
      await expect.poll(() => action.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          focused: document.activeElement === element,
          focusVisible: element.matches(":focus-visible"),
          indicator: style.boxShadow !== "none" || (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2),
        };
      })).toEqual({ focused: true, focusVisible: true, indicator: true });
      const cardBox = await card.boundingBox();
      const actionBox = await action.boundingBox();
      expect(actionBox.width).toBe(32);
      expect(actionBox.height).toBe(32);
      expect(actionBox.x).toBeGreaterThanOrEqual(cardBox.x);
      expect(actionBox.y).toBeGreaterThanOrEqual(cardBox.y);
      expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
      expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height);
    }
    await page.screenshot({ path: info.outputPath(`g5-actions-${theme}-${width}.png`), animations: "disabled" });
    await card.getByRole("button", { name: "Edit comment" }).click();
    const edit = card.getByRole("textbox", { name: "Edit comment text" });
    await edit.fill("Revised contextual draft");
    await edit.evaluate((element) => { window.g5Edit = element; element.setSelectionRange(2, 7); });
    await page.locator("#theme").click();
    await page.locator("#theme").click();
    expect(await edit.evaluate((element) => ({ same: element === window.g5Edit, selection: [element.selectionStart, element.selectionEnd] })))
      .toEqual({ same: true, selection: [2, 7] });
    await page.screenshot({ path: info.outputPath(`g5-edit-${theme}-${width}.png`), animations: "disabled" });
    await edit.press("Escape");
    let deletes = 0;
    page.on("request", (request) => {
      if (request.method() === "DELETE" && request.url().includes("/comment/")) deletes++;
    });
    const deleteAction = card.getByRole("button", { name: "Delete comment", exact: true });
    await deleteAction.click();
    await expect(card).toContainText("Delete this comment?");
    await expect(card.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
    await expect(card.getByRole("menu")).toHaveCount(0);
    const confirmBox = await card.boundingBox();
    expect(confirmBox.x).toBeGreaterThanOrEqual(0);
    expect(confirmBox.x + confirmBox.width).toBeLessThanOrEqual(width + 1);
    for (const name of ["Cancel", "Delete"]) {
      const button = card.getByRole("button", { name, exact: true });
      await expect(button).toHaveText(name);
      const buttonBox = await button.boundingBox();
      expect(buttonBox.x).toBeGreaterThanOrEqual(confirmBox.x);
      expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(confirmBox.x + confirmBox.width);
      expect(buttonBox.y).toBeGreaterThanOrEqual(confirmBox.y);
      expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(confirmBox.y + confirmBox.height);
    }
    expect(deletes).toBe(0);
    await page.screenshot({ path: info.outputPath(`g5-confirm-${theme}-${width}.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(deleteAction).toBeFocused();
    await expect(card.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    await deleteAction.click();
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(deleteAction).toBeFocused();
    await expect(card.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    expect(deletes).toBe(0);
    expect(await page.locator("#frame").evaluate((element) => element === window.g5Frame)).toBe(true);
    await expect(frame.getByLabel("Page-owned draft")).toHaveValue("Authored input stays");
  });
}

test("G5 failed composer keeps one field and caret through retry with synchronous IME events", async ({ page, review }) => {
  await openReview(page, review, writeFile(review, "context-failure.html", source));
  const frame = await waitForSdk(page);
  await select(frame);
  const field = page.locator("#composeText");
  await field.fill("Original draft after failed request");
  await field.evaluate((element) => {
    window.g5Composer = element;
    element.setSelectionRange(3, 8);
    element.dispatchEvent(new Event("select", { bubbles: true }));
  });
  let posts = 0;
  page.on("request", (request) => { if (request.method() === "POST" && /\/comment$/.test(request.url())) posts++; });
  await field.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
  expect(posts).toBe(0);
  await page.route("**/api/page/*/comment", (route) => route.fulfill({ status: 503, json: { error: "Comment service unavailable" } }));
  await page.locator("#composeAdd").click();
  await expect(page.locator("#composeError")).toContainText("Comment service unavailable");
  await expect(field).toBeFocused();
  expect(await field.evaluate((element) => ({ same: element === window.g5Composer, selection: [element.selectionStart, element.selectionEnd] })))
    .toEqual({ same: true, selection: [3, 8] });
  await page.unroute("**/api/page/*/comment");
  await field.press("Enter");
  await expect(page.locator("#compose")).toBeHidden();
  await expect(page.locator("#toolbarCount")).toHaveText("1");
  expect(posts).toBe(2);
});

test("G5 late successful submit cannot clear the draft retained by source reload", async ({ page, review }) => {
  const target = writeFile(review, "context-late.html", source);
  const session = await openReview(page, review, target);
  const frame = await waitForSdk(page);
  await select(frame);
  await page.locator("#composeText").fill("Draft retained during reload");
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const requested = new Promise((resolve) => { started = resolve; });
  await page.route("**/api/page/*/comment", async (route) => {
    const response = await route.fetch();
    started();
    await gate;
    await route.fulfill({ response });
  });
  await page.locator("#composeAdd").click();
  await requested;
  const previous = await page.locator("#frame").getAttribute("src");
  fs.writeFileSync(target, source.replace("A good review explains", "Updated source explains"));
  await expect(page.locator("#safeReload")).toBeVisible();
  await page.locator("#safeReload").click();
  await expect(page.locator("#frame")).not.toHaveAttribute("src", previous);
  await waitForSdk(page);
  release();
  await expect(page.locator("#composeText")).toHaveValue("Draft retained during reload");
  await expect(page.locator("#composeError")).toContainText("page changed while this comment was saving");
  await expect(page.locator("#composeText")).toHaveJSProperty("readOnly", false);
  const saved = await reviewApi(review, `/api/page/${session.key}`);
  expect(saved.json().comments).toHaveLength(1);
  await page.locator("#composeCancel").click();
  await expect(page.locator("#compose")).toBeHidden();
});
