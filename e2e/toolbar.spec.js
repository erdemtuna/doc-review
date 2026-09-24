import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test, expect, openReview, reviewApi, waitForSdk, writeFile, message, handled, seedThread, feedback, selectReviewMode, expectEditBlocked, mutate, sendPending, intercept, failure, listed, selectText } from "./helpers.js";
import { selectChoice } from "./choice-helpers.js";

const fixture = readFileSync(new URL("../test/fixtures/toolbar-review.html", import.meta.url), "utf8");

test("toolbar preserves authored state and draft identity across themes and saved comparisons", async ({ page, review }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const ref = await openReview(page, review, writeFile(review, "toolbar-state.html", fixture));
  const frame = await waitForSdk(page);
  const appearance = () => frame.locator("body").evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor, foreground: getComputedStyle(element).color,
    scheme: getComputedStyle(element).colorScheme, theme: document.documentElement.getAttribute("data-theme"),
  }));
  const originalAppearance = await appearance();
  await message(page, "Explain the example");
  await page.locator("#send").click();
  await expect(page.getByText("Queued; not received", { exact: true })).toBeVisible();
  await handled(review, ref);
  await page.getByRole("complementary", { name: "Feedback" }).getByRole("button", { name: "Close", exact: true }).click();
  await frame.getByLabel("Authored-page draft").fill("Keep this authored draft");
  await frame.getByRole("button", { name: "Increment counter" }).click();
  await page.locator("#frame").evaluate((element) => { window.originalFrame = element; });
  await feedback(page);
  const note = page.getByRole("textbox", { name: "Overall note", exact: true });
  await note.fill("Keep this overall note");
  await note.evaluate((element) => {
    window.originalNote = element; element.setSelectionRange(5, 9);
    element.dispatchEvent(new Event("select", { bubbles: true }));
  });
  for (let i = 0; i < 3; i++) {
    await page.locator("#seeChanges").click();
    await expect(page.locator("#seeChanges")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#modeButton")).toBeHidden();
    await expect(page.getByRole("region", { name: "Saved comparison" })).toBeVisible();
    // Theme changes are independent of the mounted comparison and document.
    await page.locator("#theme").click();
    await page.locator("#latestVersion").click();
    await expect(page.locator("#latestVersion")).toHaveAttribute("aria-pressed", "true");
  }
  expect(await page.locator("#frame").evaluate((element) => element === window.originalFrame)).toBe(true);
  expect(await frame.locator("body").evaluate(() => window.boots)).toBe(1);
  await expect(frame.locator("#counter")).toHaveText("1");
  await expect(frame.getByLabel("Authored-page draft")).toHaveValue("Keep this authored draft");
  expect(await frame.locator("body").evaluate((element) => getComputedStyle(element).fontSize)).toBe("17px");
  expect(await appearance()).toEqual(originalAppearance);
  expect(await note.evaluate((element) => ({
    same: element === window.originalNote, text: element.value, selection: [element.selectionStart, element.selectionEnd],
  }))).toEqual({ same: true, text: "Keep this overall note", selection: [5, 9] });
  const view = page.locator("#modeButton");
  await view.focus(); await view.press("Enter");
  await expect(page.getByRole("menuitemradio", { name: /^View/ })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape"); await expect(view).toBeFocused();
  expect(await view.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  expect(await page.evaluate(() => localStorage.getItem("doc-review:theme"))).toBe("dark");
  expect(errors).toEqual([]);
});

test("the rounded brand scales cleanly and belongs only to the outer shell", async ({ page, review }, testInfo) => {
  const authoredIcon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
  await openReview(page, review, writeFile(review, "brand-scope.html", fixture.replace("</head>", `<link rel="icon" href="${authoredIcon}"></head>`)));
  const frame = await waitForSdk(page);
  const brand = page.getByRole("img", { name: "Doc Review", exact: true, includeHidden: true });
  const src = await brand.getAttribute("src");
  expect(await page.locator('head link[rel="icon"]').getAttribute("href")).toBe(src);
  expect(await frame.locator('head link[rel="icon"]').getAttribute("href")).toBe(authoredIcon);
  await expect(frame.getByRole("img", { name: "Doc Review", exact: true })).toHaveCount(0);
  await page.locator("#theme").click();
  expect(await brand.getAttribute("src")).toBe(src);
  expect(await frame.locator('head link[rel="icon"]').getAttribute("href")).toBe(authoredIcon);
  const study = await page.context().newPage();
  try {
    await study.setViewportSize({ width: 640, height: 320 });
    await study.setContent(`<style>body{margin:0;font:14px system-ui}section{height:160px;display:flex;align-items:center;gap:32px;padding:0 32px;box-sizing:border-box}
      .light{background:#FFFDF7;color:#292E2B}.dark{background:#222A26;color:#EEEFE6}figure{margin:0;width:96px;text-align:center}img{display:block;margin:0 auto 12px}</style>
      ${["light", "dark"].map((theme) => `<section class="${theme}">${[16, 24, 32, 64].map((size) =>
        `<figure><img src="${src}" width="${size}" height="${size}" alt="Doc Review at ${size}px"><figcaption>${size}px</figcaption></figure>`).join("")}</section>`).join("")}`);
    for (const image of await study.getByRole("img").all()) expect(await image.evaluate((element) => element.complete && element.naturalWidth === 64)).toBe(true);
    await study.screenshot({ path: testInfo.outputPath("brand-sizes.png") });
  } finally { await study.close(); }
});

test("former toolbar structure, selected paint, hit targets and lifecycle geometry across both themes", async ({ page, review }, testInfo) => {
  test.setTimeout(90_000);
  const ref = await openReview(page, review, writeFile(review, "toolbar-layout.html", fixture));
  for (const selector of ["#intro", "#detail"]) await seedThread(review, ref, "Clarify this section", {
    kind: "element", anchor: { selector, label: "Sample review" },
  });
  await feedback(page);
  await expect(page.locator(".conversation-thread")).toHaveCount(2);
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
    for (const [width, height] of [[1440, 900], [1280, 720], [900, 700], [899, 700], [768, 900], [390, 844], [390, 480], [320, 400], [761, 700], [760, 700], [601, 700], [481, 700], [480, 700], [390, 700], [320, 700], [900, 450], [899, 450], [320, 450]]) {
      await page.setViewportSize({ width, height });
      await expect(page.locator("#reviewPage")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "More", exact: true })).toHaveCount(0);
      await expect(page.locator("#reviewDetails")).toHaveCount(0);
      await expect(page.locator(".conversation-title")).toHaveCount(0);
      await expect(page.locator(".shell-toolbar")).not.toContainText("toolbar-layout.html");
      const toolbar = await page.locator(".shell-toolbar").boundingBox();
      expect(toolbar.width).toBe(width);
      for (const control of await page.locator(".shell-toolbar button").all()) {
        if (!await control.isVisible()) continue;
        const box = await control.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.height).toBe(32);
        if (await control.isEnabled()) expect(await control.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        })).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const brand = page.getByRole("img", { name: "Doc Review", exact: true });
      expect(await brand.evaluate((image) => image.complete && image.naturalWidth === 64)).toBe(true);
      const icon = await brand.boundingBox(), destination = page.getByRole("group", { name: "Review destination" });
      const group = await destination.boundingBox();
      expect([icon.width, icon.height, group.height]).toEqual([32, 32, 32]);
      expect(group.y).toBe(icon.y); expect(group.x - icon.x - icon.width).toBe(8);
      expect(await destination.evaluate((element) => getComputedStyle(element).borderRadius)).toBe("8px");
      await expect.poll(() => page.locator("#latestVersion").evaluate((element) => ({
        fill: getComputedStyle(element).backgroundColor, ink: getComputedStyle(element).color,
        inset: getComputedStyle(element, "::before").top, radius: getComputedStyle(element, "::before").borderRadius,
        selected: getComputedStyle(element, "::before").backgroundColor,
      }))).toEqual({ fill: "rgba(0, 0, 0, 0)", ink: theme === "light" ? "rgb(23, 104, 95)" : "rgb(133, 199, 184)",
        inset: "3px", radius: "5px", selected: theme === "light" ? "rgb(225, 238, 234)" : "rgb(41, 63, 55)" });
      await expect(page.locator(".conversation-lifecycle")).toHaveCount(1);
      await expect(page.locator(".conversation-lifecycle")).toHaveAttribute("data-variant", "outline");
      const badgePaint = await page.locator(".conversation-lifecycle").evaluate((element) => {
        const style = getComputedStyle(element);
        return { width: style.borderTopWidth, style: style.borderTopStyle, color: style.borderTopColor,
          radius: parseFloat(style.borderTopLeftRadius), surface: getComputedStyle(element.closest(".shell-toolbar")).backgroundColor };
      });
      expect(badgePaint.width).toBe("1px");
      expect(badgePaint.style).toBe("solid");
      expect(badgePaint.color).not.toBe("rgba(0, 0, 0, 0)");
      expect(badgePaint.color).not.toBe(badgePaint.surface);
      expect(badgePaint.radius).toBeGreaterThanOrEqual(10);
      await expect(page.locator(".conversation-global-status")).toHaveCount(0);
      const lifecycle = await page.locator(".conversation-lifecycle").boundingBox();
      const mode = await page.locator("#modeButton").boundingBox();
      expect(Math.abs(lifecycle.x + lifecycle.width / 2 - width / 2)).toBeLessThanOrEqual(1);
      expect(mode.x + mode.width).toBe(width - 12);
      expect(mode.x >= lifecycle.x + lifecycle.width || mode.y >= lifecycle.y + lifecycle.height).toBe(true);
      expect(lifecycle.height).toBe(20);
      expect(lifecycle.x + lifecycle.width).toBeLessThanOrEqual(width);
      expect(toolbar.height).toBe(width > 760 ? 49 : width > 480 || height <= 550 ? 89 : 117);
      const stage = await page.locator(".stage").boundingBox();
      expect(stage.y).toBe(toolbar.y + toolbar.height);
      const panel = await page.getByRole("complementary", { name: "Feedback" }).boundingBox();
      expect(panel.y).toBeGreaterThanOrEqual(stage.y);
      expect(panel.x).toBeGreaterThanOrEqual(0);
      expect(panel.x + panel.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`toolbar-${theme}-${width}x${height}.png`), animations: "disabled" });
      await page.locator("#modeButton").click();
      await expect(page.getByRole("menu")).toBeVisible();
      const menu = await page.getByRole("menu").boundingBox();
      expect(menu.x).toBeGreaterThanOrEqual(0); expect(menu.x + menu.width).toBeLessThanOrEqual(width);
      await page.getByRole("menuitemradio", { name: /^Edit/ }).click();
      await expect(page.locator("#modeLabel")).toHaveText("Edit");
      await expect(page.frameLocator("#frame").locator("body")).toHaveAttribute("contenteditable", "true");
      await page.locator("#modeButton").click();
      await expect(page.getByRole("menuitemradio", { name: /^Edit/ })).toHaveAttribute("aria-checked", "true");
      await page.screenshot({ path: testInfo.outputPath(`toolbar-edit-${theme}-${width}x${height}.png`), animations: "disabled" });
      await page.keyboard.press("Escape"); await expect(page.locator("#modeButton")).toBeFocused();
      await selectReviewMode(page, "View");
      await page.locator("#theme").click(); await page.locator("#theme").click();
      await page.locator("#seeChanges").click();
      await expect(page.getByRole("region", { name: "Changes", exact: true })).toContainText("No handled submissions");
      await expect(page.locator("#commentsButton")).toBeHidden();
      await expect(page.locator(".conversation-lifecycle")).toBeVisible();
      const changesBadge = await page.locator(".conversation-lifecycle").boundingBox();
      expect(Math.abs(changesBadge.x + changesBadge.width / 2 - width / 2)).toBeLessThanOrEqual(1);
      await expect(page.locator(".conversation-global-status")).toHaveCount(0);
      await expect(page.locator("#seeChanges")).toHaveAttribute("aria-pressed", "true");
      await page.locator("#latestVersion").click();
    }
  }
});

test("editing is disabled while the initial page is loading", async ({ page, review }) => {
  const target = writeFile(review, "toolbar-loading.html", fixture);
  const opened = await reviewApi(review, "/api/conversation", {
    method: "POST", body: { operation: "open", requestId: randomUUID(), target },
  });
  expect(opened.status, opened.raw).toBe(200);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/session/*/page", async (route) => { await held; await route.continue(); });
  try {
    await page.goto(`http://127.0.0.1:${review.port}/r/${opened.json().receipt.reviewId}`);
    await expect(page.locator("#modeButton")).toBeDisabled();
    await expect(page.locator("#commentsButton")).toBeVisible();
    release(); await waitForSdk(page);
    await expect(page.locator("#modeButton")).toBeEnabled();
  } finally { release(); }
});

test("waiting and ended badges keep centered geometry, receipt semantics and theme tokens in Review and Changes", async ({ page, review }, info) => {
  test.setTimeout(60_000);
  const ref = await openReview(page, review, writeFile(review, "lifecycle-badges.html", fixture));
  await waitForSdk(page);
  await seedThread(review, ref, "Keep accepted work visible");
  await sendPending(review, ref);
  const badge = page.locator(".conversation-lifecycle");
  for (const ended of [false, true]) {
    if (ended) await mutate(review, ref, "end", { confirmUnsentReadOnly: true });
    await expect(badge).toHaveText(ended ? "Review ended" : "Waiting for agent");
    await expect(badge).toHaveAttribute("data-slot", "badge");
    await expect(badge).toHaveAttribute("data-variant", ended ? "secondary" : "warning");
    await expect(badge).toHaveAttribute("role", "status");
    await expect(badge).toHaveAccessibleDescription(/Queued; not received/);
    expect(await badge.evaluate((element) => element.tabIndex)).toBe(0);
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
      await expect.poll(() => badge.evaluate((element) => {
        const style = getComputedStyle(element);
        const probe = document.createElement("span");
        probe.style.color = `var(${element.dataset.variant === "warning" ? "--annotation-foreground" : "--secondary-foreground"})`;
        element.append(probe);
        const expected = getComputedStyle(probe).color;
        probe.remove();
        return style.color === expected;
      })).toBe(true);
      for (const [width, height] of [[1440, 900], [1280, 720], [900, 700], [899, 700], [768, 900], [390, 844], [390, 480], [320, 400],
        ...[1440, 900, 899, 761, 760, 601, 481, 480, 390, 320].map(width => [width, 450])]) {
        await page.setViewportSize({ width, height });
        const mode = await page.locator("#modeButton").boundingBox(), box = await badge.boundingBox();
        expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(1);
        expect(mode.x + mode.width).toBe(width - 12);
        expect(mode.x >= box.x + box.width || mode.y >= box.y + box.height).toBe(true);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect((await page.locator(".shell-toolbar").boundingBox()).height).toBe(width > 760 ? 49 : width > 480 || height <= 550 ? 89 : 117);
        await expect(page.locator(".conversation-global-status")).toHaveCount(0);
        await page.screenshot({ path: info.outputPath(`${ended ? "ended" : "waiting"}-${theme}-${width}x${height}.png`) });
        await page.locator("#seeChanges").click();
        await expect(page.locator("#modeButton")).toBeHidden();
        await expect(badge).toBeVisible();
        const changesBadge = await badge.boundingBox();
        expect(Math.abs(changesBadge.x + changesBadge.width / 2 - width / 2)).toBeLessThanOrEqual(1);
        await expect(page.locator(".conversation-global-status")).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.locator("#latestVersion").click();
      }
    }
  }
});

test("toolbar controls reflow without clipping when their text is enlarged", async ({ page, review }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openReview(page, review, writeFile(review, "toolbar-large-text.html", fixture));
  await waitForSdk(page);
  await page.addStyleTag({ content: ".shell-toolbar button { font-size:24px;line-height:1.5;height:auto; }" });
  for (const name of ["Review", "Changes", "View", "Feedback"]) {
    const button = page.getByRole("button", { name, exact: true });
    const box = await button.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(await button.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
    if (await button.isEnabled()) { await button.focus(); await expect(button).toBeFocused(); }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("lifecycle tooltips explain every state on hover and keyboard focus without clipping or stealing menu and iframe focus", async ({ page, review }) => {
  test.setTimeout(90_000);
  const ref = await openReview(page, review, writeFile(review, "status-tooltip.html", fixture));
  const frame = await waitForSdk(page);
  const badge = page.locator(".conversation-lifecycle"), tooltip = page.getByRole("tooltip");
  const surface = page.locator('[data-slot="tooltip-content"]');
  await frame.getByLabel("Authored-page draft").fill("Keep authored input");
  await feedback(page);
  const note = page.getByRole("textbox", { name: "Overall note", exact: true });
  await note.fill("Keep the memory-only note");
  await note.evaluate((element) => { window.keptNote = element; element.setSelectionRange(2, 7); element.dispatchEvent(new Event("select", { bubbles: true })); });
  await page.locator("#commentsButton").click();
  await page.locator("#frame").evaluate((element) => { window.keptFrame = element; });
  for (const state of ["reviewing", "queued", "received", "ended"]) {
    if (state === "queued") { await seedThread(review, ref, "Explain this page"); await sendPending(review, ref); }
    if (state === "received") {
      const polled = await reviewApi(review, "/api/conversation", { method: "POST", body: { operation: "poll", reviewId: ref.reviewId, entryKey: ref.entryKey } });
      expect(polled.status, polled.raw).toBe(200);
    }
    if (state === "ended") await mutate(review, ref, "end", { confirmUnsentReadOnly: true });
    const explanation = state === "reviewing" ? "Saved feedback is not sent until you choose Send"
      : state === "queued" ? "Queued; not received"
      : state === "received" ? "Received; delivery is not evidence of an active agent"
      : "Accepted work can still finish; ending the review does not cancel it";
    await expect(badge).toHaveAccessibleDescription(new RegExp(explanation));
    await expect(badge).not.toHaveAttribute("title");
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 450 });
        await page.locator("#latestVersion").focus();
        await badge.hover();
        await expect(tooltip).toContainText(explanation);
        const box = await surface.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(12);
        expect(box.x + box.width).toBeLessThanOrEqual(width - 12);
        expect(box.y + box.height).toBeLessThanOrEqual(450);
        expect(await surface.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await expect(surface).toHaveCSS("color", theme === "light" ? "rgb(41, 46, 43)" : "rgb(238, 239, 230)");
        await page.keyboard.press("Escape");
        await expect(tooltip).toHaveCount(0);
        await page.locator("#theme").hover();
        await badge.focus();
        await expect(tooltip).toContainText(explanation);
        await page.keyboard.press("Escape");
        await expect(tooltip).toHaveCount(0);
        await expect(badge).toBeFocused();
        await page.keyboard.press("Tab");
        expect(await badge.evaluate((element) => document.activeElement === element)).toBe(false);
      }
    }
    if (state === "reviewing") {
      await page.setViewportSize({ width: 1440, height: 900 });
      await badge.focus(); await expect(tooltip).toBeVisible();
      await page.locator("#modeButton").click();
      await expect(tooltip).toHaveCount(0);
      await expect(page.locator("#modeMenu")).toBeVisible();
      await badge.focus();
      await expect(page.locator("#modeMenu")).toHaveCount(0);
      await expect(tooltip).toBeVisible();
      await frame.getByLabel("Authored-page draft").click();
      await expect(tooltip).toHaveCount(0);
      await expect(page.locator("#frame")).toBeFocused();
      await page.keyboard.insertText(" + focus retained");
      await expect(frame.getByLabel("Authored-page draft")).toHaveValue("Keep authored input + focus retained");
      await expect(page.getByRole("menuitem", { name: "Reload without scripts" })).toHaveCount(0);
    }
  }
  expect(await page.locator("#frame").evaluate((element) => element === window.keptFrame)).toBe(true);
  await feedback(page);
  expect(await note.evaluate((element) => ({ same: element === window.keptNote, text: element.value, caret: [element.selectionStart, element.selectionEnd] })))
    .toEqual({ same: true, text: "Keep the memory-only note", caret: [2, 7] });
});

test("hoverable status tooltip dismisses across the iframe boundary without needing parent-document pointer moves", async ({ page, review }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReview(page, review, writeFile(review, "tooltip-iframe-exit.html", fixture));
  const frame = await waitForSdk(page), badge = page.locator(".conversation-lifecycle");
  const surface = page.locator('[data-slot="tooltip-content"]');
  await page.evaluate(() => {
    window.tooltipPointerTrace = [];
    for (const type of ["pointerout", "pointerover", "pointerleave", "pointerenter"]) {
      document.addEventListener(type, (event) => {
        const label = (node) => node instanceof Element ? `${node.tagName}#${node.id}.${node.getAttribute("data-slot") || ""}` : String(node);
        window.tooltipPointerTrace.push({ type, target: label(event.target), related: label(event.relatedTarget), x: event.clientX, y: event.clientY });
      }, true);
    }
  });
  try {
    expect(await page.evaluate(() => document.activeElement.tagName)).toBe("BODY");
    for (const steps of [1, 30]) {
      await badge.hover();
      await expect(surface).toBeVisible();
      expect(await badge.evaluate((element) => document.activeElement === element)).toBe(false);
      await page.mouse.move(1438, 898, { steps });
      await expect(surface).toBeHidden({ timeout: 1200 });
      await badge.hover();
      await expect(surface).toBeVisible();
      const content = await surface.boundingBox();
      await page.mouse.move(content.x + content.width / 2, content.y + content.height / 2, { steps: 15 });
      await expect(surface).toBeVisible();
      await page.waitForTimeout(450);
      await expect(surface).toBeVisible();
      await page.mouse.move(1438, 898, { steps });
      await expect(surface).toBeHidden({ timeout: 1200 });
    }
    await badge.hover();
    await badge.focus();
    await expect(surface).toBeVisible();
    await page.mouse.move(1438, 898, { steps: 30 });
    await expect(surface).toBeVisible();
    await expect(badge).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(surface).toBeHidden();
    await expect(badge).toBeFocused();
    await page.locator("#modeButton").click();
    await page.keyboard.press("Escape");
    await frame.getByLabel("Authored-page draft").fill("Typing still works");
    await expect(page.locator("#frame")).toBeFocused();
    await page.keyboard.insertText(" after tooltip dismissal");
    await expect(frame.getByLabel("Authored-page draft")).toHaveValue("Typing still works after tooltip dismissal");
  } finally {
    const trace = testInfo.outputPath("iframe-pointer-events.json");
    writeFileSync(trace, JSON.stringify(await page.evaluate(() => window.tooltipPointerTrace), null, 2));
    await testInfo.attach("iframe-pointer-events.json", { path: trace, contentType: "application/json" });
  }
});

test("View and Edit remain responsive during repeated keyboard transitions", async ({ page, review }) => {
  await openReview(page, review, writeFile(review, "toolbar-reopen.html", fixture));
  const frame = await waitForSdk(page);
  for (let attempt = 0; attempt < 8; attempt++) for (const mode of ["Edit", "View"]) {
    const button = page.locator("#modeButton");
    await button.focus(); await button.press("Enter");
    await page.getByRole("menuitemradio", { name: new RegExp(`^${mode}`) }).click();
    await expect(page.locator("#modeLabel")).toHaveText(mode);
    await expect(button).toBeFocused();
    if (mode === "Edit") await expect(frame.locator("body")).toHaveAttribute("contenteditable", "true");
    else await expect(frame.locator("body")).not.toHaveAttribute("contenteditable", "true");
  }
});

test("mode exit preserves an iframe focus handoff and real keyboard edits", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "toolbar-focus.md", "# Heading\n\nOriginal paragraph\n"));
  const frame = await waitForSdk(page);
  await page.addStyleTag({ content: "#modeMenu { animation-duration: 600ms; }" });
  await selectReviewMode(page, "Edit");
  await expect(frame.locator("body")).toHaveAttribute("contenteditable", "true");
  await frame.locator("p").click();
  await expect(page.locator("#frame")).toBeFocused();
  await expect(page.locator("#modeMenu")).toHaveCount(0);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator("#frame")).toBeFocused();
  await selectText(frame, "p");
  await page.keyboard.insertText("Exact keyboard edit after menu exit");
  await expect(frame.locator("p")).toHaveText("Exact keyboard edit after menu exit");
  await expect.poll(async () => (await listed(review, ref, "edits")).items.map((edit) => edit.content.after))
    .toEqual(["Exact keyboard edit after menu exit"]);
});

test("mode and page menus hand off focus and mode can reopen during exit", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "toolbar-menu-handoff.html", fixture));
  await waitForSdk(page);
  await mutate(review, ref, "join-page", { target: writeFile(review, "toolbar-menu-second.html", fixture) });
  const mode = page.locator("#modeButton"), picker = page.locator("#reviewPage");
  for (let attempt = 0; attempt < 3; attempt++) {
    await picker.click();
    await mode.click();
    await expect(page.getByRole("menuitemradio", { name: /^View/ })).toBeVisible();
    await picker.click();
    await expect(page.locator("#reviewPageMenu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toBeFocused();
    await mode.click(); await page.keyboard.press("Escape"); await mode.click();
    const menu = page.locator("#modeMenu");
    await expect(menu).toBeVisible();
    await menu.evaluate(async (element) => {
      await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await expect(menu).toBeVisible();
    await expect(mode).toHaveAttribute("aria-expanded", "true");
    expect(await menu.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0); await expect(mode).toBeFocused();
  }
});

test("Changes has no invented identity, follows handled history, retains selection/error and stays usable after End", async ({ page, review }, testInfo) => {
  const ref = await openReview(page, review, writeFile(review, "changes-entry.html", fixture));
  await waitForSdk(page);
  const requests = [];
  page.on("request", (request) => { if (request.url().endsWith("/api/conversation/comparison")) requests.push(request.postDataJSON()); });
  await page.locator("#seeChanges").click();
  await expect(page.getByRole("region", { name: "Changes", exact: true })).toContainText("No handled submissions");
  expect(requests).toEqual([]);
  await seedThread(review, ref, "Explain without changing source");
  await sendPending(review, ref);
  await expect(page.locator(".conversation-lifecycle")).toHaveText("Waiting for agent");
  await page.screenshot({ path: testInfo.outputPath("toolbar-waiting-changes.png") });
  const completed = await handled(review, ref);
  const comparison = page.getByRole("region", { name: "Saved comparison" });
  await expect(comparison.getByRole("region", { name: "Comparison availability" })).toContainText("No new source changes reported");
  await expect(comparison.locator(".comparison-surface")).toHaveCount(0);
  await comparison.getByRole("button", { name: "Source", exact: true }).click();
  await expect(comparison.getByRole("button", { name: "Source", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.locator("#latestVersion").click();
  await mutate(review, ref, "end", { confirmUnsentReadOnly: true });
  await expect(page.locator(".conversation-lifecycle")).toHaveText("Review ended");
  await expect(page.locator("#modeButton")).toBeDisabled();
  await feedback(page); await expect(page.getByRole("complementary", { name: "Feedback" })).toBeVisible();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/conversation/comparison", async (route) => {
    await pending; await route.fulfill({ status: 503, json: { error: "Comparison read failed" } });
  });
  await page.locator("#seeChanges").click();
  await expect(comparison.getByRole("status")).toContainText("Loading");
  release(); await expect(comparison.getByRole("alert")).toContainText("Comparison read failed");
  await page.unroute("**/api/conversation/comparison");
  await comparison.getByRole("button", { name: "Retry comparison" }).click();
  await expect(comparison.getByRole("alert")).toHaveCount(0);
  await expect(comparison.getByRole("button", { name: "Source", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.locator("#theme").click();
  await page.screenshot({ path: testInfo.outputPath("toolbar-ended-changes.png") });
  expect(requests.every((request) => request.reviewId === ref.reviewId && request.entryKey === ref.entryKey &&
    request.submissionId === completed.work.submissionId && request.pageKey === ref.key)).toBe(true);
});

test("multi-page navigation appears once and write blockers disable Edit without disabling discussion or ended navigation", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "entry.html", fixture));
  await waitForSdk(page);
  const other = await mutate(review, ref, "join-page", { target: writeFile(review, "second-page.html", fixture) });
  await expect(page.locator("#reviewPage")).toHaveCount(1);
  await selectChoice(page, "reviewPage", other.value.pageKey); await waitForSdk(page);
  await expect(page.locator("#reviewPage")).toHaveAttribute("data-value", other.value.pageKey);
  await seedThread(review, ref, "Accepted discussion"); await sendPending(review, ref);
  await expectEditBlocked(page, true);
  await feedback(page); await expect(page.getByRole("button", { name: "New message", exact: true })).toBeEnabled();
  await mutate(review, ref, "end", { confirmUnsentReadOnly: true });
  await expect(page.locator("#modeButton")).toBeDisabled();
  await selectChoice(page, "reviewPage", ref.key); await waitForSdk(page);
  await expect(page.locator("#reviewPage")).toHaveAttribute("data-value", ref.key);
});

test("long mutation errors occupy an on-demand recovery row below real pointer controls at the overlap boundary", async ({ page, review }, info) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openReview(page, review, writeFile(review, "long-status.html", fixture)); await waitForSdk(page);
  await intercept(page, "create-thread", (route) => failure(route, "Source and review evidence could not be verified. ".repeat(8)));
  await feedback(page); await page.getByRole("button", { name: "New message", exact: true }).click();
  await page.getByRole("textbox", { name: "New message", exact: true }).fill("Keep this draft");
  await page.getByRole("button", { name: "Save message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("could not be verified");
  await page.getByRole("complementary", { name: "Feedback" }).getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".conversation-global-status").getByRole("alert")).toBeVisible();
  for (const [width, height] of [[1440, 900], [1280, 720], [900, 700], [899, 700], [768, 900], [390, 844], [390, 480], [320, 400]]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height });
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
    await page.locator("#modeButton").click(); await page.keyboard.press("Escape");
    await expect(page.locator("#modeButton")).toBeFocused();
    const status = await page.locator(".conversation-global-status").boundingBox();
    const stage = await page.locator(".stage").boundingBox();
    const mode = await page.locator("#modeButton").boundingBox();
    expect(status.y).toBeGreaterThanOrEqual(mode.y + mode.height);
    const refresh = page.locator(".conversation-global-status").getByRole("button", { name: "Refresh review" });
    await refresh.scrollIntoViewIfNeeded();
    expect(await refresh.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    expect(stage.y).toBeGreaterThanOrEqual(status.y + status.height);
    await page.screenshot({ path: info.outputPath(`recovery-${theme}-${width}x${height}.png`) });
  }
  const [refreshed] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/conversation") && response.request().postDataJSON()?.operation === "status"),
    page.locator(".conversation-global-status").getByRole("button", { name: "Refresh review" }).click(),
  ]);
  expect(refreshed.status()).toBe(200);
  await feedback(page);
  await expect(page.locator(".conversation-global-status")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("could not be verified");
  await expect(page.getByRole("textbox", { name: "New message", exact: true })).toHaveValue("Keep this draft");
});
