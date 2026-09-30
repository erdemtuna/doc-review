import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { renderedContrast, setReviewTheme } from "./helpers.js";

test.describe.configure({ mode: "serial" });
let server;
let base;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (process.env.DOC_REVIEW_UI_PREVIEW_URL) {
    const url = new URL(process.env.DOC_REVIEW_UI_PREVIEW_URL);
    if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") throw new Error("The UI preview must be local.");
    base = url.href;
    return;
  }
  server = spawn(process.execPath, [path.join(process.cwd(), "scripts", "ui-preview.js")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`UI preview startup timed out: ${output}`)), 90_000);
    const finish = (error, url) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(url);
    };
    const read = (chunk) => {
      output += chunk;
      const url = output.match(/G1 component preview: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (url) finish(null, url);
    };
    server.stdout.on("data", read);
    server.stderr.on("data", read);
    server.once("error", (error) => finish(error));
    server.once("exit", (code) => finish(new Error(`UI preview exited ${code}: ${output}`)));
  });
});

test.afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
});

test("G1 controls preserve draft selection, theme preference and focus", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  const primarySize = await page.getByRole("button", { name: "Send feedback", exact: true }).boundingBox();
  expect(primarySize.height).toBe(32);
  expect(await page.getByLabel("Note to agent").evaluate((element) => getComputedStyle(element).fontSize)).toBe("13px");
  expect(await page.getByRole("button", { name: "Cancel", exact: true }).evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  const contentColor = await page.getByRole("button", { name: "Document", exact: true }).evaluate((element) => getComputedStyle(element, "::before").backgroundColor);
  expect(await page.getByRole("button", { name: "Source", exact: true }).evaluate((element) => getComputedStyle(element, "::before").backgroundColor)).not.toBe(contentColor);
  const note = page.getByLabel("Note to agent");
  await note.fill("Keep this selected draft.");
  await note.evaluate((element) => element.setSelectionRange(5, 9));
  await setReviewTheme(page, "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(note).toHaveValue("Keep this selected draft.");
  expect(await note.evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual([5, 9]);
  await page.getByRole("button", { name: /^Submission:/ }).click();
  await page.getByRole("menuitemradio", { name: "Submission 1 - Handled" }).click();
  await expect(page.getByRole("status")).toContainText("Sample submission 1");
  const menu = page.getByRole("button", { name: "Open sample menu" });
  await menu.focus();
  await menu.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  expect(await menu.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  const confirmation = page.getByRole("button", { name: "Try confirmation" });
  await confirmation.click();
  await expect(page.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeFocused();
  await confirmation.click();
  await page.getByRole("button", { name: "Discard sample edits" }).click();
  await expect(page.getByRole("status")).toContainText("Nothing was deleted");
  await expect(note).toHaveValue("Keep this selected draft.");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(errors).toEqual([]);
});

test("G1 populated controls and overlays fit both themes at required widths", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(base);
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) {
      await setReviewTheme(page, theme);
    }
    for (const name of ["Send feedback", "Capture result", "Selected context", "Cancel", "Delete thread", "Abandon"]) {
      const button = page.getByRole("button", { name, exact: true });
      for (const state of ["rest", "hover", "focus"]) {
        await page.mouse.move(0, 0);
        if (state === "hover") await button.hover();
        if (state === "focus") {
          await button.focus();
          await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
          await expect(button).toBeFocused();
        }
        expect(await renderedContrast(button), `${theme}: ${name} ${state}`).toBeGreaterThanOrEqual(4.5);
        if (state === "focus") {
          await expect(button).toHaveCSS("outline-width", "2px");
          expect(await renderedContrast(button, "outlineColor"), `${theme}: ${name} focus boundary`).toBeGreaterThanOrEqual(3);
        }
      }
    }
    const picker = page.getByRole("button", { name: /^Submission:/ });
    const border = await picker.evaluate(node => getComputedStyle(node).borderTopColor);
    const filters = page.getByRole("group", { name: "Sample conversation filters" });
    await expect(filters).toHaveCSS("box-shadow", "none");
    await expect(filters).toHaveCSS("gap", "8px");
    for (const button of await filters.getByRole("button").all()) {
      await expect(button).toHaveCSS("border-top-width", "1px");
      await expect(button).toHaveCSS("border-top-color", border);
      expect(await renderedContrast(button)).toBeGreaterThanOrEqual(4.5);
    }
    for (const state of ["rest", "hover", "expanded"]) {
      if (state === "hover") await picker.hover();
      if (state === "expanded") await picker.click();
      await expect(picker).toHaveCSS("border-top-color", border);
      expect(await renderedContrast(picker)).toBeGreaterThanOrEqual(4.5);
      expect(await renderedContrast(picker.locator("svg").first())).toBeGreaterThanOrEqual(3);
    }
    await expect(picker).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(picker).toBeFocused();
    expect(await renderedContrast(picker, "outlineColor")).toBeGreaterThanOrEqual(3);
    expect(await renderedContrast(page.getByRole("textbox", { name: "Note to agent" }), "borderTopColor")).toBeGreaterThanOrEqual(3);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`g1-${theme}-${width}.png`), fullPage: true, animations: "disabled" });
      await page.getByRole("button", { name: "Open sample menu" }).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      const menuBox = await menu.boundingBox();
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
      if (width === 390 || width === 1440) {
        await page.screenshot({ path: testInfo.outputPath(`g1-menu-${theme}-${width}.png`), animations: "disabled" });
      }
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await page.getByRole("button", { name: "Try confirmation" }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      const dialogBox = await dialog.boundingBox();
      expect(dialogBox.x).toBeGreaterThanOrEqual(0);
      expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 390 || width === 1440) {
        await page.screenshot({ path: testInfo.outputPath(`g1-dialog-${theme}-${width}.png`), animations: "disabled" });
      }
      await page.getByRole("button", { name: "Keep editing" }).click();
      await expect(dialog).toBeHidden();
    }
  }
});

test("G1 styles stay scoped and reduced motion disables component transitions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(base);
  const values = await page.evaluate(() => {
    document.documentElement.classList.remove("review-ui");
    document.documentElement.style.setProperty("--card", "rgb(1, 2, 3)");
    const legacy = document.createElement("div");
    legacy.style.background = "var(--card)";
    document.body.append(legacy);
    const result = {
      legacy: getComputedStyle(legacy).backgroundColor,
      ui: getComputedStyle(document.querySelector(".preview-section")).backgroundColor,
      transition: getComputedStyle(document.querySelector('[data-slot="button"]')).transitionDuration,
    };
    legacy.remove();
    return result;
  });
  expect(values.legacy).toBe("rgb(1, 2, 3)");
  expect(values.ui).toBe("rgb(255, 253, 247)");
  expect(values.transition).toBe("0s");
});
