import fs from "node:fs";
import { test, expect, openReview, waitForSdk, writeFile, seedThread, feedback, enterEditMode, selectText, selectReviewMode } from "./helpers.js";
import { fieldNotes, summaryFeedback, actionFeedback } from "../test/fixtures/readme-review.js";
import { threadAction } from "./conversation-actions.js";

const matrix = [[1440, 900], [1280, 720], [900, 700], [899, 700], [768, 900], [390, 844], [390, 480], [320, 400]];
const textGeometry = locator => locator.evaluate(node => {
  const range = document.createRange(); range.selectNodeContents(node);
  const lines = [...range.getClientRects()].filter(rect => rect.width && rect.height);
  const first = lines[0];
  let top = 0, bottom = innerHeight, left = 0, right = innerWidth;
  for (let parent = node; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, rect.top + parent.clientTop); bottom = Math.min(bottom, rect.top + parent.clientTop + parent.clientHeight);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, rect.left + parent.clientLeft); right = Math.min(right, rect.left + parent.clientLeft + parent.clientWidth);
    }
  }
  return { text: node.textContent, font: parseFloat(getComputedStyle(node).fontSize), firstLine: first?.height ?? 0,
    visibleFirstLine: first && first.left >= left && first.right <= right + 1 ? Math.max(0, Math.min(first.bottom, bottom) - Math.max(first.top, top)) : 0,
    totalVisible: lines.reduce((sum, rect) => sum + Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top)), 0),
    y: first?.top, clipTop: top, clipBottom: bottom };
});
const fieldGeometry = locator => locator.evaluate(node => {
  const rect = node.getBoundingClientRect(); let top = 0, bottom = innerHeight;
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
      const box = parent.getBoundingClientRect(); top = Math.max(top, box.top + parent.clientTop);
      bottom = Math.min(bottom, box.top + parent.clientTop + parent.clientHeight);
    }
  }
  return { height: rect.height, visible: Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top)),
    same: node === window.responsiveEditor, selection: [node.selectionStart, node.selectionEnd], font: parseFloat(getComputedStyle(node).fontSize) };
});

async function fixture(page, review, name) {
  const ref = await openReview(page, review, writeFile(review, name, fieldNotes()));
  await waitForSdk(page);
  await seedThread(review, ref, summaryFeedback, { kind: "element", anchor: { selector: "#summary", label: "Summary" } });
  await seedThread(review, ref, actionFeedback, { kind: "element", anchor: { selector: "#action", label: "Call to action" } });
  await feedback(page);
  const card = page.locator(".conversation-thread").filter({ hasText: actionFeedback });
  return { ref, card, message: card.locator(".conversation-exchange > .conversation-body").first() };
}

for (const host of ["inventory", "reply", "focus", "adjacent"]) test(`integrated ${host} initially exposes real message text at every audited size without editor refocus`, async ({ page, review }, info) => {
  test.setTimeout(120_000);
  const { card, message } = await fixture(page, review, `responsive-${host}.html`);
  let editor;
  if (host !== "inventory") {
    await card.getByRole("button", { name: "Reply", exact: true }).click();
    editor = card.getByRole("textbox", { name: "Reply", exact: true });
    await editor.fill("Keep the same draft and permission.");
    await editor.evaluate(node => {
      window.responsiveEditor = node; node.setSelectionRange(4, 12);
      node.dispatchEvent(new Event("select", { bubbles: true }));
      node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });

    if (host === "focus") await card.getByRole("button", { name: "Focus", exact: true }).click();
    if (host === "adjacent") {
      await (await threadAction(page, card, "Beside target")).click();
      await expect(page.locator(".conversation-panel")).toHaveAttribute("data-host", "adjacent");
    }
  }
  await auditHost(page, card, message, editor, host, info);
});

test("saved and source-pending edit evidence remains initially readable and independently selectable across the matrix", async ({ page, review }, info) => {
      test.setTimeout(120_000);
      const samples = [];
      for (const state of ["saved", "pending"]) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await openReview(page, review, writeFile(review, `responsive-edit.${state === "saved" ? "html" : "md"}`,
          state === "saved" ? "<p>Original wording.</p>" : "Original wording.\n"));
        const frame = await enterEditMode(page);
        await frame.locator("p").click(); await selectText(frame, "p"); await page.keyboard.insertText("Exact revised wording.");
        await selectReviewMode(page, "View");
        await feedback(page);
        const edits = page.locator(".conversation-edits");
        await expect(edits).toContainText(state === "saved" ? "Already saved" : "Source pending");
        const preview = edits.locator(".conversation-edit-preview dd").first();
        for (const [width, height] of matrix) for (const theme of ["light", "dark"]) {
          await page.setViewportSize({ width, height });
          if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
          else await page.locator("#theme").focus();
          await page.waitForTimeout(100);
          const text = await textGeometry(preview);
          samples.push({ state, width, height, theme, text });
          await page.screenshot({ path: info.outputPath(`edit-${state}-${theme}-${width}x${height}.png`) });
          expect.soft(text.font).toBeGreaterThanOrEqual(13);
          expect.soft(text.visibleFirstLine + 0.1, `${state} evidence ${width}x${height}`).toBeGreaterThanOrEqual(text.firstLine);
          await expect(edits.getByRole("checkbox")).toBeChecked();
        }
        const selection = edits.getByRole("checkbox");
        await selection.uncheck(); await expect(page.locator("#send")).toBeDisabled();
        await selection.check(); await expect(page.locator("#send")).toHaveText("Send (1)");
      }
      fs.writeFileSync(info.outputPath("edits-geometry.json"), JSON.stringify(samples, null, 2));
    });

    test("compact reply and note controls retain deliberate scrolling, filters and exact editors through keyboard menus", async ({ page, review }) => {
      const { ref, card } = await fixture(page, review, "responsive-ownership.html");
      for (let index = 0; index < 6; index++) await seedThread(review, ref, `Earlier context ${index}: ${"Readable history. ".repeat(10)}`);
      await card.getByRole("button", { name: "Reply", exact: true }).click();
      const editor = card.getByRole("textbox", { name: "Reply" });
      await editor.fill("Keep my compact reply");
      const note = page.locator("#draft-note");
      const toggle = page.getByRole("button", { name: /Overall note \(optional\)/ });
      await toggle.click();
      await note.fill("Separate note permission and text");
      await page.locator('[data-composer="note"]').getByRole("checkbox").check();
      await editor.evaluate(node => {
        window.responsiveEditor = node; node.setSelectionRange(2, 9);
        node.dispatchEvent(new Event("select", { bubbles: true }));
        node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      });
      await note.evaluate(node => { window.responsiveNote = node; });
      await toggle.click();
      await page.setViewportSize({ width: 320, height: 400 });
      await page.locator("#theme").click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.focus(); await page.keyboard.press("Enter");
      await expect(note).toHaveValue("Separate note permission and text");
      await expect(page.locator('[data-composer="note"]').getByRole("checkbox")).toBeChecked();
      expect(await note.evaluate(node => node === window.responsiveNote)).toBe(true);
      await toggle.click();
      const inventory = page.locator(".conversation-inventory"), bounds = await inventory.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, 160);
      await expect.poll(() => inventory.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      await page.waitForTimeout(200);
      const position = await inventory.evaluate(node => node.scrollTop);
      await page.locator("#theme").click();
      await expect.poll(() => inventory.evaluate(node => node.scrollTop)).toBe(position);
      const filter = page.getByRole("button", { name: "Open (8)", exact: true });
      await filter.click(); await expect(card).toBeHidden();
      await filter.click(); await expect(card).toBeVisible();
      expect(await editor.evaluate(node => [node === window.responsiveEditor, node.selectionStart, node.selectionEnd])).toEqual([true, 2, 9]);
      await expect(card.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      await card.getByRole("button", { name: "Conversation actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Resolve", exact: true })).toBeEnabled();
      await page.keyboard.press("Escape");
      await expect(card.getByRole("button", { name: "Conversation actions" })).toBeFocused();
      await page.setViewportSize({ width: 1440, height: 900 });
      expect(await note.evaluate(node => node === window.responsiveNote)).toBe(true);
      expect(await editor.evaluate(node => node === window.responsiveEditor)).toBe(true);
      await toggle.click();
      await note.focus();
      await page.setViewportSize({ width: 320, height: 400 });
      await expect(note).toBeFocused();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await page.screenshot({ path: test.info().outputPath("focused-note-resize.png"), animations: "disabled" });
      fs.writeFileSync(test.info().outputPath("focused-note-resize.json"), JSON.stringify(await note.evaluate(node => {
        const result = [];
        for (let item = node; item; item = item.parentElement) {
          const style = getComputedStyle(item), rect = item.getBoundingClientRect();
          result.push({ className: item.className, top: rect.top, height: rect.height, clientHeight: item.clientHeight,
            scrollTop: item.scrollTop, scrollHeight: item.scrollHeight, overflow: style.overflow, minHeight: style.minHeight });
        }
        return result;
      }), null, 2));
      expect((await fieldGeometry(note)).visible).toBeGreaterThanOrEqual(36);
    });
async function auditHost(page, card, message, editor, host, info) {
  const samples = [];
  for (const [width, height] of matrix) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height });
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
    else await page.locator("#theme").focus();
    await page.waitForTimeout(100);
    const text = await textGeometry(message), field = editor && await fieldGeometry(editor);
    samples.push({ width, height, theme, host, text, field,
      toolbar: await page.locator(".shell-toolbar").boundingBox(), panel: await page.locator(".conversation-panel").boundingBox() });
    await page.screenshot({ path: info.outputPath(`${host}-${theme}-${width}x${height}.png`) });
    expect.soft(text.text).toBe(actionFeedback);
    expect.soft(text.font).toBeGreaterThanOrEqual(13);
    expect.soft(text.firstLine).toBeGreaterThan(0);
    expect.soft(text.visibleFirstLine + 0.1, `${host} ${theme} ${width}x${height}: complete natural first glyph line`).toBeGreaterThanOrEqual(text.firstLine);
    if (field) {
      expect.soft(field.same).toBe(true); expect.soft(field.selection).toEqual([4, 12]);
      expect.soft(field.visible + 0.1, `draft initially readable at ${width}x${height}`).toBeGreaterThanOrEqual(Math.min(36, field.height));
      await expect.soft(card.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    }
    await expect.soft(page.locator("#theme")).toBeFocused();
  }
  fs.writeFileSync(info.outputPath(`${host}-geometry.json`), JSON.stringify(samples, null, 2));
  if (editor) {
    await editor.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    const permission = card.getByRole("checkbox", { name: "Request a change" });
    await expect(permission).not.toBeChecked();
    await permission.scrollIntoViewIfNeeded();
    await permission.click();
    await expect(permission).toBeChecked();
    const save = card.getByRole("button", { name: "Save", exact: true });
    await save.scrollIntoViewIfNeeded();
    expect(await save.evaluate(node => {
      const box = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    await save.focus(); await page.keyboard.press("Enter");
    await expect(editor).toHaveCount(0);
    await expect(card).toContainText("Keep the same draft and permission.");
  }
}
