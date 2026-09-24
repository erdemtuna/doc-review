import fs from "node:fs";
import { test, expect, openReview, waitForSdk, writeFile, seedThread, feedback, sendPending, handled, mutate } from "./helpers.js";
import { threadAction } from "./conversation-actions.js";

test("identical pending and handled cards retain readable content and record density across themes and sizes", async ({ page, review }, info) => {
  test.setTimeout(60000);
  const ref = await openReview(page, review, writeFile(review, "card-density.html", '<!doctype html><p id="copy">A concise target</p>'));
  await waitForSdk(page);
  const { threadId } = await seedThread(review, ref, "Please clarify this sentence.");
  await feedback(page);
  const card = page.locator(`[data-thread="${threadId}"]`);
  const metrics = [];
  for (const state of ["pending", "handled"]) {
    if (state === "handled") {
      await sendPending(review, ref); await handled(review, ref);
      await expect(card.locator(".conversation-response")).toContainText("The explanation preserves the original meaning.");
    }
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
      for (const [width, height] of [[1440, 900], [900, 700], [899, 700], [390, 480], [320, 400]]) {
        await page.setViewportSize({ width, height });
        await page.locator(".conversation-inventory").evaluate((element) => { element.scrollTop = 0; });
        const message = card.locator(".conversation-exchange > p").first();
        const box = await card.boundingBox(), body = await message.boundingBox();
        metrics.push({ state, theme, width, height, cardHeight: box.height, messageOffset: body.y - box.y,
          fontSize: await message.evaluate((element) => getComputedStyle(element).fontSize) });
        expect(await message.evaluate((element) => getComputedStyle(element).fontSize)).toBe("13px");
        await expect(card.locator(".conversation-thread-title")).toHaveAttribute("aria-expanded", "true");
        await expect(page.getByRole("button", { name: "Open (1)", exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByRole("button", { name: "Resolved (0)", exact: true })).toHaveAttribute("aria-pressed", "true");
        await page.screenshot({ path: info.outputPath(`cards-${state}-${theme}-${width}.png`) });
        await message.scrollIntoViewIfNeeded();
        expect(await message.evaluate((element) => {
          const body = element.getBoundingClientRect(), inventory = element.closest(".conversation-inventory").getBoundingClientRect();
          const line = document.createRange(); line.selectNodeContents(element);
          return [...line.getClientRects()].some((rect) => rect.height > 10 && rect.top >= inventory.top && rect.bottom <= inventory.bottom &&
            element.contains(document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2))) && body.width > 0;
        })).toBe(true);
        if (state === "handled") {
          const response = card.locator(".conversation-response p");
          await response.scrollIntoViewIfNeeded();
          expect(await response.evaluate((element) => {
            const inventory = element.closest(".conversation-inventory").getBoundingClientRect();
            const content = document.createRange(); content.selectNodeContents(element);
            return [...content.getClientRects()].some((rect) => rect.height > 10 && rect.top >= inventory.top && rect.bottom <= inventory.bottom);
          })).toBe(true);
        }
        if (height <= 480) await page.screenshot({ path: info.outputPath(`cards-${state}-${theme}-${width}-reading.png`) });
      }
    }
  }
  fs.writeFileSync(info.outputPath("card-density.json"), JSON.stringify(metrics, null, 2));
});

test("narrow resolved cards retain reachable secondary controls when new activity is marked", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "card-activity.html", "<p>A concise target</p>"));
  await waitForSdk(page);
  const { threadId } = await seedThread(review, ref, "An answered discussion.");
  await sendPending(review, ref); await handled(review, ref);
  await feedback(page);
  const card = page.locator(`[data-thread="${threadId}"]`);
  await expect(card.locator(".conversation-response")).toBeVisible();
  await mutate(review, ref, "set-thread-status", { threadId, status: "resolved" });
  await expect(card.getByRole("button", { name: "New activity" })).toBeVisible();
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
    for (const [width, height] of [[390, 480], [320, 400]]) {
      await page.setViewportSize({ width, height });
      await card.getByRole("button", { name: "Focus", exact: true }).click();
      const header = card.locator(":scope > header");
      expect(await header.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await card.getByRole("button", { name: "Conversation actions", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "Reopen", exact: true })).toBeEnabled();
      await page.keyboard.press("Escape");
      await card.getByRole("button", { name: "Back to Feedback", exact: true }).click();
    }
  }
});

test("card filters keep selected paint and defaults; actions are keyboard menus with guarded confirmations and independent permission", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "card-actions.html", '<!doctype html><p id="copy">A concise target</p>'));
  await waitForSdk(page);
  const resolved = await seedThread(review, ref, "A handled discussion");
  await sendPending(review, ref); await handled(review, ref);
  await mutate(review, ref, "set-thread-status", { threadId: resolved.threadId, status: "resolved" });
  const pending = await seedThread(review, ref, "Please clarify this sentence.");
  await feedback(page);
  const card = page.locator(`[data-thread="${pending.threadId}"]`);
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
    const open = page.getByRole("button", { name: "Open (1)", exact: true });
    const resolvedFilter = page.getByRole("button", { name: "Resolved (1)", exact: true });
    await page.mouse.move(2, 2);
    await expect(open).toHaveAttribute("aria-pressed", "true");
    await expect(resolvedFilter).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => open.evaluate((element) => {
      getComputedStyle(element).backgroundColor;
      return element.getAnimations().some((animation) => animation.playState === "running");
    })).toBe(false);
    const paint = await open.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(paint).not.toBe("rgba(0, 0, 0, 0)");
    await open.click(); await page.mouse.move(2, 2); await open.evaluate((element) => element.blur());
    await expect(card).toBeHidden();
    await expect.poll(() => open.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(paint);
    await expect(resolvedFilter).toHaveAttribute("aria-pressed", "true");
    await open.click(); await page.mouse.move(2, 2); await open.evaluate((element) => element.blur());
    await expect.poll(() => open.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(paint);
    await expect(card.locator(".conversation-thread-title")).toHaveAttribute("aria-expanded", "true");
  }
  await expect(card.getByRole("button", { name: "Resolve", exact: true })).toHaveCount(0);
  const more = card.getByRole("button", { name: "Conversation actions", exact: true });
  await more.focus(); await more.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Resolve", exact: true })).toBeVisible();
  await page.keyboard.press("End"); await expect(page.getByRole("menuitem", { name: "Delete thread" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alertdialog")).toContainText("never-submitted");
  await expect(page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(more).toBeFocused();
  await card.getByRole("button", { name: "Reply", exact: true }).click();
  const editor = card.getByRole("textbox", { name: "Reply", exact: true });
  await editor.fill("My independent reply");
  await expect(card.getByRole("checkbox", { name: "Request a change" })).not.toBeChecked();
  await card.getByRole("checkbox", { name: "Request a change" }).check();
  await card.getByRole("button", { name: "Save reply" }).click();
  await expect(editor).toHaveCount(0);
  await expect(card.getByText("Change requested", { exact: true })).toBeVisible();
  await expect(card.getByText("Discussion", { exact: true })).toBeVisible();
  const selected = card.getByRole("checkbox", { name: "Send message", exact: true });
  await expect(selected).toHaveCount(2);
  await selected.first().uncheck();
  await expect(page.locator("#send")).toHaveText("Send (1)");
  await expect(page.locator("#toolbarCount")).toHaveText("2");
});

test("card timestamp and menu focus handoffs leave real authored input usable and preserve the editor", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "card-focus.html", '<!doctype html><p id="copy">A concise target</p><input aria-label="Authored input">'));
  const frame = await waitForSdk(page);
  const { threadId } = await seedThread(review, ref, "Please clarify this sentence.", { kind: "selection", anchor: { quote: "A concise target" } });
  await feedback(page);
  const card = page.locator(`[data-thread="${threadId}"]`);
  await (await threadAction(page, card, "Beside target")).click();
  await expect(page.locator(".conversation-panel")).toHaveAttribute("data-host", "adjacent");
  const timestamp = card.locator(".conversation-time").first();
  const full = await timestamp.getAttribute("aria-label");
  await timestamp.hover();
  await expect(page.getByRole("tooltip")).toHaveText(full);
  await page.getByRole("tooltip").hover(); await expect(page.getByRole("tooltip")).toBeVisible();
  await frame.getByLabel("Authored input").hover(); await expect(page.getByRole("tooltip")).toBeHidden();
  await timestamp.focus(); await expect(page.getByRole("tooltip")).toHaveText(full);
  await page.keyboard.press("Escape"); await expect(page.getByRole("tooltip")).toBeHidden();
  await expect(page.locator(".conversation-panel")).toBeVisible();
  await card.getByRole("button", { name: "Reply", exact: true }).click();
  const editor = card.getByRole("textbox", { name: "Reply", exact: true });
  await editor.fill("Retain this draft");
  await editor.evaluate((element) => { window.cardEditor = element; element.setSelectionRange(3, 7); element.dispatchEvent(new Event("select", { bubbles: true })); });
  const menu = card.getByRole("button", { name: "Conversation actions", exact: true });
  await menu.click();
  await frame.getByLabel("Authored input").click();
  await page.waitForTimeout(250);
  await page.keyboard.type("Typed in authored input");
  await expect(frame.getByLabel("Authored input")).toHaveValue("Typed in authored input");
  expect(await editor.evaluate((element) => [element === window.cardEditor, element.selectionStart, element.selectionEnd])).toEqual([true, 3, 7]);
  await menu.click(); await page.keyboard.press("Escape");
  await menu.press("Enter"); await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape"); await expect(menu).toBeFocused();
});
