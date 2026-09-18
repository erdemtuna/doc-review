import { test, expect, openReview, waitForSdk, writeFile, reviewApi } from "./helpers.js";

const source = `<!doctype html><html><head><style>
body { padding:24px; font:17px/1.6 system-ui; color:#263142; background:white }
input { max-width:100%; box-sizing:border-box }
</style></head><body><h1>Comments inventory</h1>
<p id="copy">A paragraph for the comments inventory.</p>
<label>Page draft <input aria-label="Page draft" value="Keep this page-owned input"></label></body></html>`;

async function seed(review, key, count = 2) {
  const comments = [];
  for (let index = 0; index < count; index++) {
    const response = await reviewApi(review, `/api/page/${key}/comment`, {
      method: "POST", body: {
        kind: "element", anchor: { selector: "#copy", label: "Inventory paragraph" },
        quote: index === 0 ? `Beginning ${"long excerpt ".repeat(25)}FINAL TAIL` : "Inventory paragraph",
        feedback: `Comment ${index + 1}: ${index === 0 ? "Long feedback ".repeat(35) : "Make this paragraph clearer."}`,
      },
    });
    expect(response.status).toBe(200);
    comments.push(response.json().comment);
  }
  return comments;
}

async function populated(page, review, count = 2) {
  const session = await openReview(page, review, writeFile(review, `inventory-${test.info().line}.html`, source));
  const comments = await seed(review, session.key, count);
  await page.reload();
  const frame = await waitForSdk(page);
  await page.locator("#commentsButton").click();
  await expect(page.locator("#cards article")).toHaveCount(count);
  return { session, comments, frame };
}

test("G4 long inventory and icon actions fit all widths without remounting page or note", async ({ page, review }, testInfo) => {
  test.setTimeout(90_000);
  const { frame } = await populated(page, review, 24);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#frame").evaluate((element) => { window.inventoryFrame = element; });
  await page.locator("#note").fill("Keep this overall feedback note");
  await page.locator("#note").evaluate((element) => { window.inventoryNote = element; element.setSelectionRange(2, 8); });
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await page.locator("#theme").click();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const drawer = await page.locator("#drawer").boundingBox();
      expect(Math.round(drawer.width)).toBe(width <= 720 ? width : 380);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator("#commentsSection").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.locator("#commentsSection").evaluate((element) => { element.scrollTop = 0; });
      const first = page.locator("#cards article").first();
      await expect(first.getByRole("button", { name: "More", exact: true })).toHaveCount(0);
      await expect(first.getByRole("menu")).toHaveCount(0);
      for (const name of ["Jump to", "Edit comment", "Delete comment"]) {
        const action = first.getByRole("button", { name, exact: true });
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
        const cardBox = await first.boundingBox();
        const actionBox = await action.boundingBox();
        expect(actionBox.width).toBe(32);
        expect(actionBox.height).toBe(32);
        expect(actionBox.x).toBeGreaterThanOrEqual(cardBox.x);
        expect(actionBox.y).toBeGreaterThanOrEqual(cardBox.y);
        expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
        expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height);
      }
      await first.getByRole("button", { name: "Delete comment", exact: true }).click();
      await expect(first.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
      for (const name of ["Cancel", "Delete"]) {
        const button = first.getByRole("button", { name, exact: true });
        await expect(button).toHaveText(name);
        const box = await button.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      await page.screenshot({ path: testInfo.outputPath(`g4-confirm-${theme}-${width}.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(first.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
      await expect(first.getByRole("button", { name: "Delete comment", exact: true })).toBeFocused();
      await page.locator("#commentsSection").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(page.locator("#cards article").last().locator(".quote")).toContainText("FINAL TAIL");
      await page.screenshot({ path: testInfo.outputPath(`g4-long-${theme}-${width}.png`), animations: "disabled" });
    }
  }
  expect(await page.locator("#frame").evaluate((element) => element === window.inventoryFrame)).toBe(true);
  expect(await page.locator("#note").evaluate((element) => ({
    same: element === window.inventoryNote, text: element.value, selection: [element.selectionStart, element.selectionEnd],
  }))).toEqual({ same: true, text: "Keep this overall feedback note", selection: [2, 8] });
  await expect(frame.getByLabel("Page draft")).toHaveValue("Keep this page-owned input");
  expect(errors).toEqual([]);
});

test("G4 textarea identity and draft survive unrelated updates, failure and retry", async ({ page, review }) => {
  await populated(page, review);
  const card = page.locator("#cards article").first();
  await card.getByRole("button", { name: "Edit comment" }).click();
  const input = card.getByLabel("Edit comment text");
  await input.fill("Keep the edited draft");
  await input.evaluate((element) => { window.inventoryEdit = element; element.setSelectionRange(3, 9); });
  await page.locator("#note").fill("Unrelated feedback update");
  await page.locator("#theme").click();
  expect(await input.evaluate((element) => ({
    same: element === window.inventoryEdit, selection: [element.selectionStart, element.selectionEnd],
  }))).toEqual({ same: true, selection: [3, 9] });
  await page.route("**/api/page/*/comment/*", (route) => route.request().method() === "PATCH"
    ? route.fulfill({ status: 503, json: { error: "Try editing again" } }) : route.continue());
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("Try editing again");
  await expect(input).toHaveValue("Keep the edited draft");
  await expect(input).toBeFocused();
  await page.unroute("**/api/page/*/comment/*");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#cards textarea")).toHaveCount(0);
  await expect(page.locator("#cards article").first()).toContainText("Keep the edited draft");
  await expect(page.locator("#cards article").first().getByRole("button", { name: "Edit comment" })).toBeFocused();
});

test("G4 direct confirmation switches owners without deleting and restores each trigger", async ({ page, review }) => {
  const { frame } = await populated(page, review);
  const firstCard = page.locator("#cards article").first();
  const secondCard = page.locator("#cards article").last();
  const first = firstCard.getByRole("button", { name: "Delete comment", exact: true });
  const second = secondCard.getByRole("button", { name: "Delete comment", exact: true });
  let deletes = 0;
  page.on("request", (request) => {
    if (request.method() === "DELETE" && request.url().includes("/comment/")) deletes++;
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    await first.click();
    await expect(firstCard.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
    await second.click();
    await expect(firstCard.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    await expect(secondCard.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
    await expect(page.locator("#cards").getByRole("button", { name: "Delete", exact: true })).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(second).toBeFocused();
    await expect(secondCard.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    await second.click();
    await secondCard.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(second).toBeFocused();
    await expect(page.locator("#cards").getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    expect(deletes).toBe(0);
  }
  await first.click();
  await firstCard.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(first).toBeFocused();
  await frame.getByLabel("Page draft").focus();
  await expect(page.locator("#cards").getByRole("menu")).toHaveCount(0);
  await expect(page.locator("#cards").getByRole("button", { name: "More", exact: true })).toHaveCount(0);
  expect(await frame.getByLabel("Page draft").evaluate((element) => document.activeElement === element)).toBe(true);
  await expect(page.locator("#drawer")).toHaveClass(/open/);
  await expect(page.locator("#cards article")).toHaveCount(2);
  expect(deletes).toBe(0);
});

test("G4 drawer deletion stays inline, single-flight and focuses the next card or empty inventory", async ({ page, review }) => {
  await populated(page, review, 2);
  const card = page.locator("#cards article").first();
  const next = page.locator("#cards article").last();
  let deletes = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/page/*/comment/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    deletes++;
    await gate;
    await route.continue();
  });
  try {
    await card.getByRole("button", { name: "Delete comment", exact: true }).click();
    await expect(card.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
    expect(deletes).toBe(0);
    await page.keyboard.press("Escape");
    await expect(card.getByRole("button", { name: "Delete comment", exact: true })).toBeFocused();
    await card.getByRole("button", { name: "Delete comment", exact: true }).click();
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(card.getByRole("button", { name: "Delete comment", exact: true })).toBeFocused();
    await card.getByRole("button", { name: "Delete comment", exact: true }).click();
    expect(deletes).toBe(0);
    await card.getByRole("button", { name: "Delete", exact: true }).evaluate((button) => { button.click(); button.click(); });
    await expect(card.getByRole("button", { name: "Deleting...", exact: true })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    for (const name of ["Delete comment", "Edit comment"]) {
      await expect(card.getByRole("button", { name, exact: true })).toHaveCount(0);
      await expect(next.getByRole("button", { name, exact: true })).toBeDisabled();
    }
    await next.getByRole("button", { name: "Delete comment", exact: true }).evaluate((button) => button.click());
    await expect(next.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    await expect.poll(() => deletes).toBe(1);
  } finally { release(); }
  await expect(page.locator("#cards article")).toHaveCount(1);
  await expect(next.getByRole("button", { name: "Delete comment", exact: true })).toBeFocused();
  await next.getByRole("button", { name: "Delete comment", exact: true }).click();
  await expect(next.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
  expect(deletes).toBe(1);
  await next.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator("#cards article")).toHaveCount(0);
  await expect(page.locator("#empty")).toBeVisible();
  await expect(page.locator("#commentsSection")).toBeFocused();
  expect(deletes).toBe(2);
});

test("G4 other-page inventory navigates and updates current-page counts", async ({ page, review }) => {
  const otherFile = "another-reviewed-document-with-a-long-file-name.html";
  writeFile(review, otherFile, source);
  const session = await openReview(page, review, writeFile(review, "inventory-other-page-entry.html", source));
  const navigated = await reviewApi(review, `/api/session/${session.sessionId}/navigate`, {
    method: "POST", body: { href: otherFile },
  });
  expect(navigated.status).toBe(200);
  await seed(review, navigated.json().key, 3);
  expect((await reviewApi(review, `/api/session/${session.sessionId}/navigate`, {
    method: "POST", body: { href: "inventory-other-page-entry.html" },
  })).status).toBe(200);
  await page.reload();
  await waitForSdk(page);
  await page.locator("#commentsButton").click();
  await expect(page.locator("#empty")).toBeVisible();
  await expect(page.locator("#count")).toHaveText("0");
  await expect(page.locator("#toolbarCount")).toHaveText("3");
  await expect(page.locator("#send")).toHaveText("Send 3 to agent");
  await expect(page.locator("#othersCount")).toHaveText("1");
  await page.locator("#commentsContentToggle").click();
  await expect(page.locator("#commentsContent")).toBeHidden();
  await expect(page.locator("#othersList")).toBeVisible();
  await page.locator("#othersList").getByRole("button").click();
  await waitForSdk(page);
  await expect(page.locator("#count")).toHaveText("3");
  await expect(page.locator("#toolbarCount")).toHaveText("3");
  await expect(page.locator("#commentsContentToggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#commentsContent")).toBeHidden();
  await expect(page.locator("#othersBox")).toBeHidden();
  await expect(page.locator("#drawer")).toHaveClass(/open/);
});

test("G4 edits validate text, respect composition and coalesce pending saves", async ({ page, review }) => {
  await populated(page, review, 1);
  const card = page.locator("#cards article");
  await card.getByRole("button", { name: "Edit comment" }).click();
  const input = card.getByLabel("Edit comment text");
  await input.fill("   ");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("Comment text is required.");
  await expect(input).toBeFocused();
  let patches = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/page/*/comment/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    patches++;
    await gate;
    await route.continue();
  });
  try {
    await input.fill("Composition draft");
    await input.dispatchEvent("compositionstart");
    await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    await expect(input).toHaveValue("Composition draft");
    await expect(card.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    expect(patches).toBe(0);
    await input.dispatchEvent("compositionend");
    await input.evaluate((element) => {
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await expect.poll(() => patches).toBe(1);
    await expect(input).toHaveJSProperty("readOnly", true);
    await expect(card.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(card.locator("textarea")).toHaveCount(0);
  await expect(card.locator(".body")).toHaveText("Composition draft");
  expect(patches).toBe(1);
});
