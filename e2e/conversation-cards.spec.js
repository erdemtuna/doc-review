import fs from "node:fs";
import { test, expect, openReview, waitForSdk, writeFile, seedThread, feedback, expectFeedbackBounds, sendPending, handled, mutate, setReviewTheme, renderedContrast } from "./helpers.js";
import { threadAction } from "./conversation-actions.js";

test("identical pending and handled cards retain readable content and record density across themes and sizes", async ({ page, review }, info) => {
  test.setTimeout(60000);
  const ref = await openReview(page, review, writeFile(review, "card-density.html", '<!doctype html><p id="copy">A concise target</p>'));
  await waitForSdk(page);
  const quote = "A concise target";
  const { threadId } = await seedThread(review, ref, "Please clarify this sentence.", { kind: "selection", anchor: { quote } });
  await feedback(page);
  const card = page.locator(`[data-thread="${threadId}"]`);
  const metrics = [];
  for (const state of ["pending", "handled"]) {
    if (state === "handled") {
      await sendPending(review, ref); await handled(review, ref);
      await expect(card.locator(".conversation-response")).toContainText("The explanation preserves the original meaning.");
    }
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await setReviewTheme(page);
      for (const [width, height] of [[1440, 900], [900, 700], [899, 700], [390, 480], [320, 400]]) {
        await page.setViewportSize({ width, height });
        await expectFeedbackBounds(page, { width, height });
        await page.locator(".conversation-inventory").evaluate((element) => { element.scrollTop = 0; });
        const message = card.locator(".conversation-exchange > .conversation-body").first();
        const box = await card.boundingBox(), body = await message.boundingBox();
        metrics.push({ state, theme, width, height, cardHeight: box.height, messageOffset: body.y - box.y,
          fontSize: await message.evaluate((element) => getComputedStyle(element).fontSize) });
        expect(await message.evaluate((element) => getComputedStyle(element).fontSize)).toBe("13px");
        expect(await card.evaluate(element => {
          const style = getComputedStyle(element), inventory = getComputedStyle(element.closest(".conversation-inventory"));
          return parseFloat(style.borderTopWidth) >= 1 && parseFloat(style.borderRadius) > 0 &&
            style.backgroundColor === inventory.backgroundColor && parseFloat(style.marginBottom) >= 8;
        })).toBe(true);
        await expect(card.locator(".conversation-thread-title")).toHaveAttribute("aria-expanded", "true");
        const title = card.locator(".conversation-thread-title"), actions = card.locator(".conversation-thread-actions");
        const titleBox = await title.boundingBox(), actionsBox = await actions.boundingBox();
        expect(titleBox.width).toBeGreaterThanOrEqual(24);
        expect(Math.abs(actionsBox.y - titleBox.y)).toBeLessThan(8);
        await expect(card.locator(".conversation-target-quote")).toHaveAttribute("title", `Selected text: "${quote}"`);
        await expect(card.locator(".conversation-source")).toContainText(quote);
        await expect(card.getByRole("img", { name: "Not sent", exact: true })).toHaveCount(state === "pending" ? 1 : 0);
        if (state === "pending") await expect(card.getByRole("img", { name: "Not sent", exact: true })).toHaveAttribute("data-status-icon", "not-sent");
        await expect(card.locator(".conversation-meta").getByText(/^(Discussion|answered)$/)).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Open (1)", exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByRole("button", { name: "Resolved (0)", exact: true })).toHaveAttribute("aria-pressed", "false");
        await page.screenshot({ path: info.outputPath(`cards-${state}-${theme}-${width}.png`) });
        await message.scrollIntoViewIfNeeded();
        expect(await message.evaluate((element) => {
          const body = element.getBoundingClientRect(), inventory = element.closest(".conversation-inventory").getBoundingClientRect();
          const line = document.createRange(); line.selectNodeContents(element);
          return [...line.getClientRects()].some((rect) => rect.height > 10 && rect.top >= inventory.top && rect.bottom <= inventory.bottom &&
            element.contains(document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2))) && body.width > 0;
        })).toBe(true);
        if (state === "handled") {
          const reply = await card.getByRole("button", { name: "Reply", exact: true }).boundingBox();
          const transcript = await card.locator(".conversation-transcript").boundingBox();
          expect(Math.abs(reply.x + reply.width - transcript.x - transcript.width)).toBeLessThan(1);
          const response = card.locator(".conversation-response p");
          expect(await card.locator(".conversation-response").evaluate(element => {
            const style = getComputedStyle(element);
            return style.borderLeftWidth === "0px" && style.backgroundColor === "rgba(0, 0, 0, 0)";
          })).toBe(true);
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

test("narrow resolved cards retain reachable secondary controls without restoring unread emphasis", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "card-activity.html", "<p>A concise target</p>"));
  await waitForSdk(page);
  const { threadId } = await seedThread(review, ref, "An answered discussion.");
  await feedback(page);
  const card = page.locator(`[data-thread="${threadId}"]`);
  await expect(card).toContainText("An answered discussion.");
  await sendPending(review, ref);
  await expect(card.getByRole("img", { name: "Not sent", exact: true })).toHaveCount(0);
  await handled(review, ref);
  await expect(card.locator(".conversation-response")).toBeVisible();
  await expect(card.getByRole("button", { name: "Mark conversation as read" })).toBeVisible();
  await mutate(review, ref, "set-thread-status", { threadId, status: "resolved" });
  await page.getByRole("button", { name: "Resolved (1)", exact: true }).click();
  await expect(card.getByRole("button", { name: "Mark conversation as read" })).toHaveCount(0);
  await expect(card.getByRole("img", { name: "Resolved", exact: true })).toHaveAccessibleName("Resolved");
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await setReviewTheme(page);
    for (const [width, height] of [[390, 480], [320, 400]]) {
      await page.setViewportSize({ width, height });
      await (await threadAction(page, card, "Focus")).click();
      const header = card.locator(":scope > header");
      expect(await header.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(await threadAction(page, card, "Reopen conversation")).toBeEnabled();
      await page.keyboard.press("Escape");
      await (await threadAction(page, card, "Open in Feedback")).click();
    }
  }
});

test("only meaningful permission and response outcomes remain attached to their messages", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "card-outcomes.html", '<p id="copy">Original target context remains readable</p>'));
  await waitForSdk(page);
  const examples = [];
  for (const outcome of ["answered", "applied", "deferred", "clarification-needed"]) {
    const intent = outcome === "applied" ? "request-change" : "discuss";
    const receipt = await mutate(review, ref, "create-thread", { pageKey: ref.key, intent,
      target: { kind: "element", anchor: { selector: "#copy", label: "Original target context remains readable" } },
      body: `Reviewer message for ${outcome}` });
    examples.push({ ...receipt.value, outcome, intent });
  }
  await sendPending(review, ref);
  const { work } = await handled(review, ref, { responses: examples.map(item => ({
    threadId: item.threadId, messageId: item.messageId, messageVersion: 1,
    outcome: item.outcome, body: `Agent response for ${item.outcome}`,
  })) });
  for (const item of examples) {
    expect(work.messages.find(({ message }) => message.messageId === item.messageId)?.message.intent).toBe(item.intent);
  }
  await feedback(page);
  for (const theme of ["light", "dark"]) {
  await setReviewTheme(page, theme);
  for (const item of examples) {
    const card = page.locator(`[data-thread="${item.threadId}"]`);
    await expect(card.locator(".conversation-response p")).toHaveText(`Agent response for ${item.outcome}`);
    await expect(card.locator(".conversation-meta").getByText("Discussion", { exact: true })).toHaveCount(0);
    const label = { answered: "Answered", applied: "Change reported", deferred: "Deferred", "clarification-needed": "Needs clarification" }[item.outcome];
    const status = card.locator(".conversation-response .conversation-meta").getByRole("img", { name: label, exact: true });
    await expect(status).toBeVisible();
    await card.locator(".conversation-response .conversation-time").focus();
    await page.keyboard.press("Tab");
    await expect(status).toBeFocused();
    await expect(page.getByRole("tooltip")).toContainText(label);
    await expect(status).toHaveAccessibleName(label);
    await page.locator(".conversation-inventory").evaluate(node => { node.scrollTop += 1; });
    await expect(page.getByRole("tooltip")).toContainText(label);
    await expect(status).toBeFocused();
    expect(await renderedContrast(status)).toBeGreaterThanOrEqual(3);
    expect(await renderedContrast(status, "outlineColor")).toBeGreaterThanOrEqual(3);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toBeHidden();
    await expect(card.locator(".conversation-exchange > .conversation-meta").getByRole("img", { name: "Change requested", exact: true }))
      .toHaveCount(item.intent === "request-change" ? 1 : 0);
  }
  }
});

test("card filters keep selected paint and defaults; actions are keyboard menus with guarded confirmations and independent permission", async ({ page, review }, info) => {
  const ref = await openReview(page, review, writeFile(review, "card-actions.html", '<!doctype html><p id="copy">A concise target</p>'));
  await waitForSdk(page);
  const resolved = await seedThread(review, ref, "A handled discussion");
  await sendPending(review, ref); await handled(review, ref);
  await mutate(review, ref, "set-thread-status", { threadId: resolved.threadId, status: "resolved" });
  const pending = await seedThread(review, ref, "Please clarify this sentence.");
  await feedback(page);
  const card = page.locator(`[data-thread="${pending.threadId}"]`);
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await setReviewTheme(page);
    const open = page.getByRole("button", { name: "Open (1)", exact: true });
    const resolvedFilter = page.getByRole("button", { name: "Resolved (1)", exact: true });
    await page.mouse.move(2, 2);
    await expect(open).toHaveAttribute("aria-pressed", "true");
    await expect(resolvedFilter).toHaveAttribute("aria-pressed", "false");
    await resolvedFilter.click();
    await expect(resolvedFilter).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => open.evaluate((element) => {
      getComputedStyle(element).backgroundColor;
      return element.getAnimations().some((animation) => animation.playState === "running");
    })).toBe(false);
    const paint = await open.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(paint).not.toBe("rgba(0, 0, 0, 0)");
    await expect(open.locator("svg")).toHaveCount(0);
    await open.click(); await page.mouse.move(2, 2); await open.evaluate((element) => element.blur());
    await expect(card).toBeHidden();
    await expect.poll(() => open.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(paint);
    await expect(open.locator("svg")).toHaveCount(0);
    await expect(resolvedFilter).toHaveAttribute("aria-pressed", "true");
    await open.click(); await page.mouse.move(2, 2); await open.evaluate((element) => element.blur());
    await expect.poll(() => open.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(paint);
    await expect(open.locator("svg")).toHaveCount(0);
    await expect(card.locator(".conversation-thread-title")).toHaveAttribute("aria-expanded", "true");
    await resolvedFilter.click();
  }
  await expect(card.getByRole("button", { name: "Resolve conversation", exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Resolve conversation", exact: true }).click();
  await expect(card.getByRole("status")).toContainText("not been sent");
  await card.getByRole("button", { name: "Keep reviewing" }).click();
  const more = card.getByRole("button", { name: "Conversation actions", exact: true });
  await more.focus(); await more.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Resolve conversation", exact: true })).toHaveCount(0);
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
  await card.getByRole("button", { name: /^(Add comment|Add reply|Update comment)$/, exact: true }).click();
  await expect(editor).toHaveCount(0);
  const change = card.getByRole("img", { name: "Change requested", exact: true });
  await expect(change).toBeVisible();
  await expect(change).not.toHaveAttribute("title");
  await change.focus();
  await expect(page.getByRole("tooltip")).toHaveText("Change requested. You asked the agent to change the document.");
  await page.keyboard.press("Escape");
  await expect(change).toHaveText("");
  await change.focus(); await expect(change).toBeFocused();
  await expect(card.getByText("Discussion", { exact: true })).toHaveCount(0);
  await expect(card.locator(".conversation-exchange").first().getByRole("img", { name: "Change requested", exact: true })).toHaveCount(0);
  await expect(card.locator(".conversation-exchange").first().getByRole("img", { name: "Not sent", exact: true })).toBeVisible();
  await feedback(page);
  await expect(page.getByRole("checkbox", { name: /^Include message:/ })).toHaveCount(0);
  await expect(page.locator("#send")).toHaveText("Send to agent (2)");
  await expect(page.locator("#toolbarCount")).toHaveText("1");
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await setReviewTheme(page);
    await expect(card.getByRole("img", { name: "Not sent", exact: true })).toHaveCount(2);
    await expect(card.getByRole("img", { name: "Not sent", exact: true }).first()).toHaveAttribute("data-status-icon", "not-sent");
    await expect(page.locator("#send")).toBeEnabled();
    await page.screenshot({ path: info.outputPath(`pending-intent-${theme}.png`), caret: "initial", animations: "disabled" });
  }
});

test("card timestamp and menu focus handoffs leave real authored input usable and preserve the editor", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "card-focus.html", '<!doctype html><p id="copy">A concise target</p><input aria-label="Authored input">'));
  const frame = await waitForSdk(page);
  const { threadId } = await seedThread(review, ref, "Please clarify this sentence.", { kind: "selection", anchor: { quote: "A concise target" } });
  await feedback(page);
  const card = page.locator(`[data-thread="${threadId}"]`);
  await (await threadAction(page, card, "Beside target")).click();
  await expect(page.locator(".conversation-panel")).toHaveAttribute("data-host", "adjacent");
  const more = card.getByRole("button", { name: "Conversation actions", exact: true });
  const collapse = await threadAction(page, card, "Collapse conversation");
  await expect(collapse).toBeVisible();
  await collapse.focus(); await collapse.press("Enter");
  await expect(card.locator(".conversation-thread-content")).toBeHidden();
  await expect(more).toBeFocused();
  const expand = await threadAction(page, card, "Expand conversation");
  await expand.focus(); await expand.press("Enter");
  await expect(card.locator(".conversation-thread-content")).toBeVisible();
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
