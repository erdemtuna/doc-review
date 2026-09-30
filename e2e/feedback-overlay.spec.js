import { test, expect, openReview, waitForSdk, writeFile, seedThread, feedback, expectFeedbackBounds, overallNote, mutate, intercept, failure, conversation, setReviewTheme } from "./helpers.js";

const source = '<!doctype html><p id="copy">Feedback overlay target</p><label>Authored input <input aria-label="Authored input"></label>';

for (const theme of ["light", "dark"]) {
  test(`expanded optional note exposes the entire unchecked permission control and label ${theme}`, async ({ page, review }, info) => {
    await page.setViewportSize({ width: 320, height: 400 });
    await page.addInitScript((theme) => localStorage.setItem("doc-review:theme", theme), theme);
    const ref = await openReview(page, review, writeFile(review, `permission-${theme}.html`, source));
    await waitForSdk(page);
    for (let i = 0; i < 2; i++) await seedThread(review, ref, `Saved feedback ${i}`);
    await feedback(page);
    await feedback(page);
    await expect(page.getByRole("button", { name: /Note to agent/ })).toHaveAttribute("aria-expanded", "false");
    await overallNote(page);
    const permission = page.locator("footer").getByRole("checkbox", { name: "Request a change" });
    await expect(permission).not.toBeChecked();
    for (const [width, height] of [[320, 400], [390, 480]]) {
      await page.setViewportSize({ width, height });
      for (const note of ["", "An ordinary unresized note"]) {
        await (await overallNote(page)).fill(note);
        await expect.poll(() => permission.evaluate((checkbox) => {
          const label = checkbox.closest("label"), clipped = [];
          const text = document.createRange();
          text.selectNodeContents(label);
          for (const [name, bounds] of [["checkbox", checkbox.getBoundingClientRect()], ["label", label.getBoundingClientRect()], ["label content", text.getBoundingClientRect()]]) {
            if (bounds.top < 0 || bounds.bottom > innerHeight || bounds.left < 0 || bounds.right > innerWidth) clipped.push(`${name}:viewport`);
            for (let parent = label.parentElement; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
              if (/(auto|scroll|hidden|clip)/.test(style.overflowY) &&
                (bounds.top < box.top + parent.clientTop || bounds.bottom > box.top + parent.clientTop + parent.clientHeight)) clipped.push(`${name}:${parent.className}`);
              if (/(auto|scroll|hidden|clip)/.test(style.overflowX) &&
                (bounds.left < box.left + parent.clientLeft || bounds.right > box.left + parent.clientLeft + parent.clientWidth)) clipped.push(`${name}:${parent.className}`);
            }
          }
          for (const element of [checkbox, label]) {
            const bounds = element.getBoundingClientRect();
            if (!element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.bottom - 1))) clipped.push("permission covered");
          }
          return { clipped, scroll: label.parentElement.scrollTop, fontSize: getComputedStyle(label).fontSize };
        })).toEqual({ clipped: [], scroll: 0, fontSize: "12px" });
        expect((await page.locator(".conversation-inventory").boundingBox()).height).toBeGreaterThanOrEqual(50);
        await expect(page.locator(".conversation-footer-support")).toBeHidden();
        for (const id of ["endReview", "send"]) {
          const box = await page.locator(`#${id}`).boundingBox();
          expect(box.y + box.height).toBeLessThanOrEqual(height);
        }
        await page.screenshot({ path: info.outputPath(`permission-${theme}-${width}x${height}-${note ? "typed" : "empty"}.png`) });
      }
    }
  });
}

test("Feedback docks with room, floats without narrow reflow and leaves document controls interactive", async ({ page, review }, info) => {
  test.setTimeout(60000);
  const ref = await openReview(page, review, writeFile(review, "feedback-overlay.html", source));
  const frame = await waitForSdk(page);
  await frame.getByLabel("Authored input").fill("Keep authored draft");
  for (let i = 0; i < 8; i++) await seedThread(review, ref, `Saved feedback ${i} ${"Readable discussion. ".repeat(8)}`);
  await page.locator("#frame").evaluate((element) => { window.originalOverlayFrame = element; });
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await setReviewTheme(page);
    for (const [width, height] of [[1440, 900], [900, 700], [899, 700], [720, 760], [390, 480], [320, 400]]) {
      await page.setViewportSize({ width, height });
      await expect(page.locator(".shell-toolbar")).toHaveCSS("width", `${width}px`);
      const before = await page.locator("#frame").boundingBox();
      await feedback(page);
      await overallNote(page);
      const panel = page.getByRole("complementary", { name: "Feedback" });
      await expectFeedbackBounds(page, { width, height });
      const box = await panel.boundingBox();
      expect(box.width).toBe(Math.min(width, 380));
      expect(box.x + box.width).toBe(width); expect(box.y + box.height).toBe(height);
      const docked = width >= 1020;
      await expect.poll(async () => (await page.locator("#frame").boundingBox()).width).toBe(before.width - (docked ? 380 : 0));
      expect(await page.locator("#frame").evaluate((element) => element === window.originalOverlayFrame)).toBe(true);
      expect(await page.locator(".stage").evaluate((element) => element.inert)).toBe(false);
      await expect(page.locator(".conversation-backdrop")).toHaveCount(0);
      if (width > 380) {
        await frame.getByLabel("Authored input").fill("Keep authored draft");
        await expect(panel).toBeVisible();
      }
      const inventory = panel.locator(".conversation-inventory"), footer = panel.locator("footer");
      const inventoryBox = await inventory.boundingBox(), footerBox = await footer.boundingBox();
      expect(inventoryBox.height).toBeGreaterThanOrEqual(50);
      expect(inventoryBox.y + inventoryBox.height).toBeLessThanOrEqual(footerBox.y + 1);
      expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(height);
      await expect(panel.locator(".conversation-footer-support")).toBeHidden();
      const end = await page.locator("#endReview").boundingBox(), send = await page.locator("#send").boundingBox();
      expect(end.x + end.width).toBeLessThan(send.x);
      expect(end.y).toBe(send.y); expect(send.y + send.height).toBeLessThanOrEqual(height);
      await inventory.evaluate((element) => { element.scrollTop = 180; });
      expect(await inventory.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect(await footer.boundingBox()).toEqual(footerBox);
      const firstVisible = () => inventory.evaluate((element) => {
        const top = element.getBoundingClientRect().top;
        const card = [...element.querySelectorAll("[data-thread]")].find((card) => card.getBoundingClientRect().bottom > top);
        return { id: card.dataset.thread, offset: card.getBoundingClientRect().top - top };
      });
      const reading = await firstVisible();
      await overallNote(page);
      const note = page.getByRole("textbox", { name: "Note to agent", exact: true });
      await note.fill("Retain note between overlay openings");
      const noteBox = await note.boundingBox();
      await page.mouse.move(noteBox.x + noteBox.width - 3, noteBox.y + noteBox.height - 3);
      await page.mouse.down(); await page.mouse.move(noteBox.x + noteBox.width - 3, noteBox.y + noteBox.height + 17, { steps: 5 }); await page.mouse.up();
      if (theme === "light" && width === 1440) expect((await note.boundingBox()).height).toBeGreaterThan(noteBox.height);
      expect(await firstVisible()).toEqual(reading);
      expect((await inventory.boundingBox()).height).toBeGreaterThanOrEqual(50);
      expect((await page.locator("#send").boundingBox()).y + (await page.locator("#send").boundingBox()).height).toBeLessThanOrEqual(height);
      const supportArea = panel.locator(".conversation-footer-support");
      if (await supportArea.evaluate((element) => element.scrollHeight > element.clientHeight)) {
        await supportArea.hover(); await page.mouse.wheel(0, 100);
        await expect.poll(() => supportArea.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        expect(await firstVisible()).toEqual(reading);
      }
      await expect(panel.locator("footer").getByRole("checkbox", { name: "Request a change" })).not.toBeChecked();
      await setReviewTheme(page); await setReviewTheme(page);
      await panel.getByRole("button", { name: "Close feedback", exact: true }).click();
      await expect(panel).toBeHidden();
      await expect(page.locator("#commentsButton")).toBeFocused();
      expect(await page.locator(".stage").evaluate((element) => element.inert)).toBe(false);
      expect(await page.locator("#frame").boundingBox()).toEqual(before);
      await feedback(page);
      await expect(page.getByRole("textbox", { name: "Note to agent", exact: true })).toHaveValue("Retain note between overlay openings");
      await page.screenshot({ path: info.outputPath(`feedback-overlay-${theme}-${width}.png`) });
      await panel.getByRole("button", { name: "Close feedback", exact: true }).click();
    }
  }
  await expect(frame.getByLabel("Authored input")).toHaveValue("Keep authored draft");
});

test("Send includes all saved feedback with independent note permission and unknown counts stay explicit", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "feedback-selection.html", source));
  await waitForSdk(page); await seedThread(review, ref, "Saved discussion"); await feedback(page);
  await expect(page.locator("#toolbarCount")).toHaveText("1 open");
  await expect(page.locator("#send")).toHaveText("Send to agent (1)");
  await expect(page.locator(".conversation-thread").getByRole("checkbox")).toHaveCount(0);
  await feedback(page);
  await expect(page.getByRole("checkbox", { name: /^Include message:/ })).toHaveCount(0);
  await expect(page.locator("#toolbarCount")).toHaveText("1 open");
  await expect(page.locator("#send")).toBeEnabled();
  await page.getByRole("button", { name: /Note to agent/ }).click();
  await page.getByRole("textbox", { name: "Note to agent", exact: true }).fill("Only this note requests a change");
  const permission = page.locator("footer").getByRole("checkbox", { name: "Request a change" });
  await expect(permission).not.toBeChecked(); await permission.check();
  await expect(page.locator("#send")).toHaveText("Send to agent (2)");
  await expect(page.locator("#send")).toHaveAccessibleDescription("Ready to send: 1 comment · 1 note");
  await intercept(page, "list", (route) => failure(route, "Counts cannot be verified"));
  await page.locator("#commentsButton").click();
  await mutate(review, ref, "create-thread", { pageKey: ref.key, target: { kind: "element", anchor: { selector: "body" } }, body: "Remote pending", intent: "discuss" });
  await expect(page.locator("#toolbarCount")).toHaveText("…");
  await feedback(page); await expect(page.locator("#send")).toBeDisabled();
  await expect(page.locator("#sendSelectionDescription")).toHaveText("Couldn't check what's ready to send. Refresh the review.");
  await page.setViewportSize({ width: 320, height: 400 });
  for (const id of ["endReview", "send"]) {
    await expect.poll(async () => {
      const box = await page.locator(`#${id}`).boundingBox();
      return box.y + box.height;
    }).toBeLessThanOrEqual(400);
  }
  expect((await page.locator(".conversation-inventory").boundingBox()).height).toBeGreaterThanOrEqual(50);
  await page.unroute("**/api/conversation");
  await page.getByRole("button", { name: "Refresh review", exact: true }).click();
  await expect(page.locator("#toolbarCount")).toHaveText("2 open");
  await expect(page.locator("#send")).toHaveText("Send to agent (3)");
  await page.locator("#send").click();
  await expect(page.getByRole("status", { name: "Waiting for agent", exact: true })).toBeVisible();
  const work = (await conversation(review, ref, "poll")).submission;
  expect(work.messages).toHaveLength(2); expect(work.edits).toEqual([]);
  expect(work.messages.every(item => item.message.intent === "discuss")).toBe(true);
  expect(work.overallNote).toEqual({ body: "Only this note requests a change", intent: "request-change" });
  await expect(page.locator("#toolbarCount")).toHaveText("2 open");
  await expect(page.locator("#send")).toBeDisabled();
  await mutate(review, ref, "end", { confirmUnsentReadOnly: true });
  await expect(page.locator(".conversation-lifecycle")).toHaveText("Review ended");
  await expect(page.locator("#toolbarCount")).toHaveText("2 open");
});
