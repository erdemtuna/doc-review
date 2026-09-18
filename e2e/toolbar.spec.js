import { readFileSync } from "node:fs";
import { test, expect, openReview, reviewApi, waitForSdk, writeFile } from "./helpers.js";

const fixture = readFileSync(new URL("../test/fixtures/toolbar-review.html", import.meta.url), "utf8");

test("G2 toolbar preserves the authored document and drafts across themes and destinations", async ({ page, review }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openReview(page, review, writeFile(review, "toolbar-state.html", fixture));
  const frame = await waitForSdk(page);
  const authoredAppearance = () => frame.locator("body").evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    foreground: getComputedStyle(element).color,
    scheme: getComputedStyle(element).colorScheme,
    theme: document.documentElement.getAttribute("data-theme"),
  }));
  const originalAppearance = await authoredAppearance();
  await frame.getByLabel("Authored-page draft").fill("Keep this authored draft");
  await frame.getByRole("button", { name: "Increment counter" }).click();
  await page.locator("#frame").evaluate((element) => { window.g2Frame = element; });
  await page.locator("#commentsButton").click();
  await page.locator("#note").fill("Keep this overall note");
  await page.locator("#note").evaluate((element) => {
    window.g2Note = element;
    element.setSelectionRange(5, 9);
  });
  await page.locator("#drawerClose").click();
  for (let i = 0; i < 3; i++) {
    await page.locator("#seeChanges").click();
    await expect(page.locator("#seeChanges")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#modeButton")).toBeHidden();
    await expect(page.locator("#theme")).toBeVisible();
    await page.locator("#theme").click();
    await page.locator("#latestVersion").click();
    await expect(page.locator("#latestVersion")).toHaveAttribute("aria-pressed", "true");
  }
  expect(await page.locator("#frame").evaluate((element) => element === window.g2Frame)).toBe(true);
  expect(await frame.locator("body").evaluate(() => window.boots)).toBe(1);
  await expect(frame.locator("#counter")).toHaveText("1");
  await expect(frame.getByLabel("Authored-page draft")).toHaveValue("Keep this authored draft");
  expect(await frame.locator("body").evaluate((element) => getComputedStyle(element).fontSize)).toBe("17px");
  expect(await authoredAppearance()).toEqual(originalAppearance);
  expect(await page.locator("#note").evaluate((element) => ({
    same: element === window.g2Note, text: element.value, selection: [element.selectionStart, element.selectionEnd],
  }))).toEqual({ same: true, text: "Keep this overall note", selection: [5, 9] });
  const mode = page.locator("#modeButton");
  await mode.focus();
  await mode.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(mode).toBeFocused();
  expect(await mode.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  expect(await page.evaluate(() => localStorage.getItem("doc-review:theme"))).toBe("dark");
  expect(errors).toEqual([]);
});

test("the rounded brand scales cleanly and belongs only to the outer shell", async ({ page, review }, testInfo) => {
  const authoredIcon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
  const authored = fixture.replace("</head>", `<link rel="icon" href="${authoredIcon}"></head>`);
  await openReview(page, review, writeFile(review, "brand-scope.html", authored));
  const frame = await waitForSdk(page);
  const brand = page.getByRole("img", { name: "Doc Review", exact: true });
  const source = await brand.getAttribute("src");
  expect(await page.locator('head link[rel="icon"]').getAttribute("href")).toBe(source);
  expect(await frame.locator('head link[rel="icon"]').getAttribute("href")).toBe(authoredIcon);
  await expect(frame.getByRole("img", { name: "Doc Review", exact: true })).toHaveCount(0);
  await page.locator("#theme").click();
  expect(await brand.getAttribute("src")).toBe(source);
  expect(await frame.locator('head link[rel="icon"]').getAttribute("href")).toBe(authoredIcon);
  const study = await page.context().newPage();
  try {
    await study.setViewportSize({ width: 640, height: 320 });
    await study.setContent(`<style>
      body{margin:0;font:14px system-ui}section{height:160px;display:flex;align-items:center;gap:32px;padding:0 32px;box-sizing:border-box}
      .light{background:#FFFDF7;color:#292E2B}.dark{background:#222A26;color:#EEEFE6}
      figure{margin:0;width:96px;text-align:center}img{display:block;margin:0 auto 12px}
    </style>${["light", "dark"].map((theme) => `<section class="${theme}">${[16, 24, 32, 64].map((size) =>
      `<figure><img src="${source}" width="${size}" height="${size}" alt="Doc Review at ${size}px"><figcaption>${size}px</figcaption></figure>`,
    ).join("")}</section>`).join("")}`);
    for (const image of await study.getByRole("img").all()) {
      expect(await image.evaluate((element) => element.complete && element.naturalWidth === 64)).toBe(true);
    }
    await study.screenshot({ path: testInfo.outputPath("brand-sizes.png") });
  } finally { await study.close(); }
});

test("G2 populated toolbar and portals fit all review widths in both themes", async ({ page, review }, testInfo) => {
  test.setTimeout(90_000);
  const session = await openReview(page, review, writeFile(review, "toolbar-layout.html", fixture));
  for (const selector of ["#intro", "#detail"]) {
    const response = await reviewApi(review, `/api/page/${session.key}/comment`, {
      method: "POST",
      body: { kind: "element", quote: "Sample review", anchor: { selector, label: "Sample review" }, feedback: "Clarify this section." },
    });
    expect(response.status).toBe(200);
  }
  await page.reload();
  await waitForSdk(page);
  await expect(page.locator("#toolbarCount")).toHaveText("2");
  await expect(page.locator("#toolbarCount")).toHaveAttribute("aria-label", "2 feedback items");
  await expect(page.locator("#toolbarCount")).toHaveAttribute("title", "2 feedback items");
  await expect(page.locator("#commentsButton")).toHaveAccessibleName("Feedback");
  await expect(page.locator(".shell-comments-label")).toHaveText("Feedback");
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const id of ["latestVersion", "seeChanges", "modeButton", "commentsButton", "theme"]) {
        const box = await page.locator(`#${id}`).boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.height).toBe(32);
      }
      expect(await page.locator(".toolbar").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      const brand = page.getByRole("img", { name: "Doc Review", exact: true });
      const iconBox = await brand.boundingBox();
      const destination = page.getByRole("group", { name: "Review destination" });
      const destinationBox = await destination.boundingBox();
      expect([iconBox.width, iconBox.height, destinationBox.height]).toEqual([32, 32, 32]);
      expect(destinationBox.y).toBe(iconBox.y);
      expect(destinationBox.x - iconBox.x - iconBox.width).toBe(8);
      expect(await brand.evaluate((image) => image.complete && image.naturalWidth === 64)).toBe(true);
      expect(await destination.evaluate((element) => getComputedStyle(element).borderRadius)).toBe("8px");
      await expect.poll(() => page.locator("#latestVersion").evaluate((element) => ({
        fill: getComputedStyle(element).backgroundColor,
        ink: getComputedStyle(element).color,
        inset: getComputedStyle(element, "::before").top,
        radius: getComputedStyle(element, "::before").borderRadius,
        selected: getComputedStyle(element, "::before").backgroundColor,
      }))).toEqual({
        fill: "rgba(0, 0, 0, 0)",
        ink: theme === "light" ? "rgb(23, 104, 95)" : "rgb(133, 199, 184)",
        inset: "3px", radius: "5px",
        selected: theme === "light" ? "rgb(225, 238, 234)" : "rgb(41, 63, 55)",
      });
      await page.screenshot({ path: testInfo.outputPath(`g2-${theme}-${width}.png`), animations: "disabled" });
      await page.locator("#modeButton").click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(await menu.evaluate((element) => getComputedStyle(element).backgroundColor))
        .toBe(theme === "light" ? "rgb(255, 253, 247)" : "rgb(34, 42, 38)");
      await page.screenshot({ path: testInfo.outputPath(`g2-menu-${theme}-${width}.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await page.locator("#seeChanges").click();
      await expect(page.locator("#commentsButton")).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator("#latestVersion").click();
    }
  }
});

test("G2 disables editing while the initial page is loading", async ({ page, review }) => {
  const target = writeFile(review, "toolbar-loading.html", fixture);
  const response = await reviewApi(review, "/api/session", { method: "POST", body: { target } });
  const session = response.json();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/session/*/page", async (route) => { await held; await route.continue(); });
  try {
    await page.goto(`http://127.0.0.1:${review.port}${session.path}`);
    await expect(page.locator("#modeButton")).toBeDisabled();
    await expect(page.locator("#seeChanges")).toBeVisible();
    release();
    await waitForSdk(page);
    await expect(page.locator("#modeButton")).toBeEnabled();
  } finally { release(); }
});

test("the destination selector reflows without clipping when toolbar text is enlarged", async ({ page, review }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openReview(page, review, writeFile(review, "toolbar-large-text.html", fixture));
  await waitForSdk(page);
  await page.addStyleTag({ content: ".shell-toolbar button { font-size: 24px; line-height: 1.5; }" });
  for (const name of ["Review", "Changes"]) {
    const button = page.getByRole("button", { name, exact: true });
    const box = await button.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(await button.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
    await button.focus();
    await expect(button).toBeFocused();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("G2 mode menu can reopen during the previous close animation", async ({ page, review }) => {
  await openReview(page, review, writeFile(review, "toolbar-reopen.html", fixture));
  await waitForSdk(page);
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.locator("#modeButton").click();
    await page.getByRole("menuitemradio", { name: /^View/ }).click();
    await page.locator("#modeButton").click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await menu.evaluate(async (element) => {
      await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  }
});
