import { test, expect, openReview, waitForSdk, writeFile } from "./helpers.js";
import { choiceItem, expectCounts, selectChoice } from "./choice-helpers.js";

function colorContrast(first, second) {
  const luminance = (color) => {
    const channels = color.match(/\d+(?:\.\d+)?/g).slice(0, 3).map((value) => {
      const channel = Number(value) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

for (const theme of ["light", "dark"]) {
  test(`neutral count badges and colored legend icons preserve comparison highlights in ${theme}`, async ({ page, review }) => {
    await page.addInitScript((value) => localStorage.setItem("doc-review:theme", value), theme);
    await mockHistory(page);
    await openReview(page, review, writeFile(review, `badge-palette-${theme}.html`, "<p>Palette example</p>"));
    await page.locator("#seeChanges").click();
    await expect(page.getByRole("img", { name: "1 modified changes" })).toBeVisible();
    const palette = theme === "light"
      ? { surface: "rgb(255, 253, 247)", text: "rgb(41, 46, 43)", border: "rgb(216, 216, 204)",
        icons: ["rgb(77, 107, 36)", "rgb(145, 91, 19)", "rgb(180, 60, 72)"], added: "rgb(239, 243, 226)", removed: "rgb(252, 236, 239)" }
      : { surface: "rgb(34, 42, 38)", text: "rgb(238, 239, 230)", border: "rgb(60, 72, 65)",
        icons: ["rgb(187, 205, 135)", "rgb(231, 187, 114)", "rgb(242, 162, 171)"], added: "rgb(43, 53, 34)", removed: "rgb(64, 39, 44)" };
    await page.locator("#historyDiagnostics > summary").click();
    for (const [index, kind] of ["added", "modified", "removed"].entries()) {
      const badge = page.getByRole("img", { name: `1 ${kind} changes` });
      expect(await badge.evaluate((element) => {
        const style = getComputedStyle(element);
        return { surface: style.backgroundColor, text: style.color, border: style.borderTopColor,
          icon: getComputedStyle(element.querySelector("svg")).color, height: element.getBoundingClientRect().height };
      })).toEqual({ surface: palette.surface, text: palette.text, border: palette.border, icon: palette.icons[index], height: 20 });
      expect(await page.locator(`.changes-legend .changes-${kind} svg`).evaluate((element) => getComputedStyle(element).color)).toBe(palette.icons[index]);
      expect(colorContrast(palette.icons[index], palette.surface)).toBeGreaterThanOrEqual(3);
      expect(colorContrast(palette.text, palette.surface)).toBeGreaterThanOrEqual(4.5);
    }
    await expect(page.locator(".comparison-added").first()).toHaveCSS("background-color", palette.added);
    await expect(page.locator(".comparison-removed").first()).toHaveCSS("background-color", palette.removed);
  });
}

function buttonShape(element) {
  const style = getComputedStyle(element);
  return {
    height: style.height, radius: style.borderRadius, paddingLeft: style.paddingLeft,
    paddingRight: style.paddingRight, border: style.border, fontSize: style.fontSize,
  };
}

function completedRounds() {
  return [
    { roundId: "round-a", ordinal: 2, feedbackStatus: "acknowledged", captureStatus: "ready", acknowledgedAt: 1700000000000,
      targets: [
        { key: "page-a", filename: "A long reviewed document name for narrow selectors.html", resultRevisionId: "result-a" },
        { key: "page-b", filename: "Another reviewed page.md", resultRevisionId: "result-b" },
      ] },
    { roundId: "round-b", ordinal: 1, feedbackStatus: "acknowledged", captureStatus: "ready",
      targets: [{ key: "page-c", filename: "Earlier.html", resultRevisionId: "result-c" }] },
  ];
}
function comparison(mode, key) {
  if (key === "page-b" && mode === "content") return { available: false, changes: [], reason: "Content exceeded processing limits.", limitations: ["max_blocks"] };
  return {
    available: true, beforeCapturedAt: 1699999900000, afterCapturedAt: 1700000030000,
    counts: { added: 1, modified: 1, removed: 1, total: 3 }, limitations: ["visible_only"],
    viewComparison: { status: "unverified", message: "Visible content only; matching view not verified." },
    changes: [
      { kind: "modified", label: "Heading", before: "Original title", after: "Revised title" },
      { kind: "removed", label: "Paragraph", before: "Removed paragraph", after: "" },
      { kind: "added", label: "New summary", before: "", after: `Added ${mode} summary for ${key}` },
    ],
  };
}
async function mockHistory(page, compare = comparison, rounds = completedRounds()) {
  await page.route("**/api/session/*/history**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ json: url.pathname.endsWith("/compare")
      ? compare(url.searchParams.get("mode"), url.searchParams.get("key"))
      : url.pathname.endsWith("/history") ? { rounds }
        : { round: rounds.find((round) => url.pathname.endsWith(round.roundId)) } });
  });
}

function continuousComparison(mode) {
  const rows = Array.from({ length: 44 }, (_, index) => {
    const changed = index === 0 || index === 43;
    const beforeBlock = { tag: "p", text: `Context ${index}: ${"Saved readable text. ".repeat(6)}`, startLine: index + 1 };
    const afterBlock = { ...beforeBlock };
    if (changed) afterBlock.text = `Revised ${mode} paragraph ${index}. ${"Updated readable text. ".repeat(6)}`;
    if (mode === "content" && index === 4) {
      afterBlock.tag = "img";
      afterBlock.attributes = { src: "https://saved.invalid/tracker.png", alt: "Historical image" };
    }
    if (mode === "content" && index === 5) {
      afterBlock.tag = "script";
      afterBlock.text = "<script>window.historicalScriptExecuted=true</script>";
    }
    return { id: `row-${index}`, kind: changed ? "modified" : "unchanged",
      changeId: changed ? `change-${index}` : null, beforeBlock, afterBlock };
  });
  return { available: true, version: 2, rows, counts: { added: 0, modified: 2, removed: 0 },
    changes: [0, 43].map((index) => ({ id: `change-${index}`, kind: "modified", label: `Paragraph ${index}`,
      beforeBlock: rows[index].beforeBlock, afterBlock: rows[index].afterBlock })) };
}

for (const width of [320, 390, 768, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`G8/G9 comparison portals preserve context and scroll committed rows at ${width}px ${theme}`, async ({ page, review }, testInfo) => {
      await page.setViewportSize({ width, height: 740 });
      await page.addInitScript((value) => localStorage.setItem("doc-review:theme", value), theme);
      const historicalRequests = [];
      page.on("request", (request) => { if (request.url().includes("saved.invalid")) historicalRequests.push(request.url()); });
      await mockHistory(page, continuousComparison);
      await openReview(page, review, writeFile(review, `g8g9-${width}-${theme}.html`, "<h1>Live document</h1><input aria-label='Live draft' value='Preserved'>"));
      const frame = await waitForSdk(page);
      await page.locator("#frame").evaluate((element) => { window.comparisonFrame = element; });
      await page.locator("#seeChanges").click();
      await expect(page.locator("#changeDetail")).toHaveClass(/comparison-content/);
      await page.locator(".comparison-expand").first().click();
      const expanded = page.locator('[data-row-id="row-10"]');
      await expect(expanded).toBeVisible();
      await expanded.evaluate((element) => { window.expandedComparisonRow = element; });
      await expect(page.locator("#changeDetail")).toContainText("Historical image");
      expect(await page.locator("#changeDetail script, #changeDetail img, #changeDetail iframe, #changeDetail a, #changeDetail [src]").count()).toBe(0);
      expect(await page.evaluate(() => window.historicalScriptExecuted)).toBeUndefined();
      await page.locator("#theme").click();
      await page.locator("#theme").click();
      await page.locator("#latestVersion").click();
      await expect(frame.getByLabel("Live draft")).toHaveValue("Preserved");
      await page.locator("#seeChanges").click();
      await expect(page.locator("#historyStatus")).not.toContainText(/Loading|Refreshing/);
      expect(await expanded.evaluate((element) => element === window.expandedComparisonRow)).toBe(true);
      for (const mode of ["content", "source"]) {
        if (mode === "source") await page.getByRole("button", { name: "Source", exact: true }).click();
        await selectChoice(page, "changeJump", "1");
        const selected = page.locator(".comparison-current");
        await expect(selected).toHaveAttribute("data-row-id", "row-43");
        await expect.poll(() => selected.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const header = document.getElementById("comparisonHeader").getBoundingClientRect();
          return bounds.bottom > header.bottom && bounds.top < innerHeight;
        })).toBe(true);
        expect(await page.locator("#changeDetail").evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe("1px");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.locator("#historyPanel").evaluate((element) => { element.scrollTop = 0; });
        await page.screenshot({ path: testInfo.outputPath(`comparison-${mode}-${width}-${theme}.png`), animations: "disabled" });
      }
      expect(historicalRequests).toEqual([]);
      expect(await page.locator("#frame").evaluate((element) => element === window.comparisonFrame)).toBe(true);
    });
  }
}

for (const width of [320, 390, 768, 814, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`G7 controls fit ${width}px ${theme}, retain frame/detail identity and keyboard selection`, async ({ page, review }, testInfo) => {
      await page.setViewportSize({ width, height: 740 });
      await page.addInitScript((value) => localStorage.setItem("doc-review:theme", value), theme);
      await mockHistory(page);
      await openReview(page, review, writeFile(review, `g7-${width}-${theme}.html`, "<h1>Authored page</h1><input aria-label='Live draft' value='Preserve me'>"));
      const frame = await waitForSdk(page);
      const viewShape = await page.locator("#modeButton").evaluate(buttonShape);
      await page.locator("#frame").evaluate((element) => { window.g7Frame = element; });
      await page.locator("#seeChanges").click();
      await expect(page.locator("#roundPicker")).toHaveAttribute("data-value", "round-a");
      await expectCounts(page, 1, 1, 1);
      await page.mouse.move(0, 0);
      const segmentShape = (element) => {
        const group = getComputedStyle(element);
        const item = getComputedStyle(element.querySelector('button[aria-pressed="true"]'));
        return {
          padding: group.padding, radius: group.borderRadius, border: group.border,
          gap: group.gap, itemHeight: item.height, itemRadius: item.borderRadius,
          itemPadding: item.padding, itemBackground: item.backgroundColor,
        };
      };
      await expect(async () => {
        expect(await page.locator("#comparisonModes").evaluate(segmentShape))
          .toEqual({
            padding: "2px", radius: "10px",
            border: `1px solid ${theme === "light" ? "rgb(216, 216, 204)" : "rgb(60, 72, 65)"}`,
            gap: "2px", itemHeight: "32px", itemRadius: "10px", itemPadding: "1px 10px",
            itemBackground: theme === "light" ? "rgb(236, 237, 229)" : "rgb(48, 58, 51)",
          });
      }).toPass({ timeout: 5000 });
      expect(viewShape).toMatchObject({ height: "32px", radius: "10px", paddingLeft: "10px", paddingRight: "10px" });
      for (const selector of ["#roundPicker", "#historyTarget", "#changeJump", "#previousChange", "#nextChange"]) {
        expect(await page.locator(selector).evaluate(buttonShape)).toEqual(viewShape);
      }
      expect(await page.locator(".changes-toolbar").evaluate((element) => {
        const style = getComputedStyle(element);
        return { left: style.paddingLeft, right: style.paddingRight,
          inset: element.querySelector(".changes-context").getBoundingClientRect().left - element.getBoundingClientRect().left - element.clientLeft };
      })).toEqual({ left: "12px", right: "12px", inset: 12 });
      expect(await page.locator("#changeNavigation").evaluate((element) => {
        const navigation = element.getBoundingClientRect();
        const toolbar = element.closest(".changes-toolbar").getBoundingClientRect();
        return Math.abs(navigation.left + navigation.width / 2 - toolbar.left - toolbar.width / 2);
      })).toBeLessThanOrEqual(1);
      await expect(page.locator("#historyStatus")).toHaveClass("sr-only");
      await expect(page.locator("#historyStatus")).toHaveCSS("position", "absolute");
      await expect(page.locator("#historyStatus")).toHaveCSS("clip-path", "inset(50%)");
      expect(await page.locator("#comparisonModes").evaluate((element) => element.getBoundingClientRect().height)).toBe(38);
      expect(await page.locator('#comparisonModes button[aria-pressed="true"]').evaluate((element) => element.getBoundingClientRect().height)).toBe(32);
      await page.locator("#changeDetail").evaluate((element) => {
        window.g7Detail = element.firstElementChild;
        window.g7Round = document.getElementById("roundPicker");
      });
      for (const selector of ["#roundPicker", "#historyTarget", "#comparisonModes", "#historyCounts", "#changeNavigation", "#changeJump"]) {
        await expect.poll(async () => {
          const box = await page.locator(selector).boundingBox();
          return box && box.x >= 0 && box.x + box.width <= width;
        }).toBe(true);
      }
      await page.locator("#historyDiagnostics > summary").click();
      await page.locator("#historyLimitations > summary").click();
      await expect(page.locator("#historyTiming")).toContainText("Agent acknowledged");
      await expect(page.locator("#historyCaptureDelay")).toContainText("30 seconds after acknowledgment");
      await page.locator("#theme").click();
      await page.locator("#theme").click();
      expect(await page.locator("#changeDetail").evaluate((element) =>
        element.firstElementChild === window.g7Detail && document.getElementById("roundPicker") === window.g7Round)).toBe(true);
      await page.locator("#nextChange").click();
      await expect(page.locator("#changePosition")).toHaveText("2 of 3");
      await page.locator("#changeJump").focus();
      await page.keyboard.press("ArrowDown");
      await expect(choiceItem(page, "1")).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("End");
      await expect(choiceItem(page, "2")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("#changeJump")).toHaveAttribute("data-value", "2");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(page.locator("#changeJump")).toBeFocused();
      await expect(page.locator("#nextChange")).toBeDisabled();
      await page.locator("#comparisonModes").getByRole("button", { name: "Source", exact: true }).click();
      await expect(page.locator("#changePosition")).toHaveText("1 of 3");
      await selectChoice(page, "historyTarget", "page-b");
      await expect(page.locator("#comparisonModes")).toHaveText("Source");
      await expect(page.locator("#historyUnavailable")).toContainText("processing limits");
      await expect(page.locator("#historyDiagnostics")).toHaveAttribute("open", "");
      await expect(page.locator("#historyLimitations")).toHaveAttribute("open", "");
      await page.locator("#roundPicker").focus();
      await page.keyboard.press("ArrowDown");
      await expect(choiceItem(page, "round-a")).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("End");
      await expect(choiceItem(page, "round-b")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("#roundPicker")).toHaveAttribute("data-value", "round-b");
      await selectChoice(page, "roundPicker", "round-a");
      await expect(page.locator("#historyTarget")).toHaveAttribute("data-value", "page-b");
      await selectChoice(page, "historyTarget", "page-a");
      await expect(page.locator('#comparisonModes button[aria-pressed="true"]')).toHaveText("Source");
      await page.locator("#historyPanel").evaluate((element) => { element.scrollTop = 0; });
      await page.screenshot({ path: testInfo.outputPath(`g7-controls-${width}-${theme}.png`), animations: "disabled" });
      await page.locator("#latestVersion").click();
      expect(await page.locator("#frame").evaluate((element) => element === window.g7Frame)).toBe(true);
      await expect(frame.getByLabel("Live draft")).toHaveValue("Preserve me");
    });

  }
}

for (const width of [1440, 2000]) {
  for (const theme of ["light", "dark"]) {
    test(`comparison navigation is centred between context and display tools at ${width}px ${theme}`, async ({ page, review }) => {
      await page.setViewportSize({ width, height: 850 });
      await page.addInitScript((value) => localStorage.setItem("doc-review:theme", value), theme);
      await mockHistory(page);
      await openReview(page, review, writeFile(review, `grouped-${width}-${theme}.html`, "<p>Review document</p>"));
      await page.locator("#seeChanges").click();
      await page.locator("#nextChange").click();
      await expect(page.locator("#changePosition")).toHaveText("2 of 3");
      const layout = await page.evaluate(() => {
        const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
        const centre = (selector) => { const box = rect(selector); return box.y + box.height / 2; };
        const format = rect("#comparisonModes");
        const counts = rect("#historyCounts");
        const navigation = rect("#changeNavigation");
        const view = rect(".changes-view-tools");
        const context = rect(".changes-context");
        const previous = rect("#previousChange");
        const jump = rect("#changeJump");
        const next = rect("#nextChange");
        const toolbar = rect(".changes-toolbar");
        return {
          rowCentres: ["#roundPicker", "#historyTarget", "#comparisonModes", "#historyCounts", "#previousChange", "#changeJump", "#nextChange"].map(centre),
          formatCountsGap: counts.left - format.right,
          contextGap: rect("#historyTarget").left - rect("#roundPicker").right,
          contextNavigationGap: navigation.left - context.right,
          navigationToolsGap: view.left - navigation.right,
          navigationCentreOffset: Math.abs(navigation.left + navigation.width / 2 - toolbar.left - toolbar.width / 2),
          previousJumpGap: jump.left - previous.right,
          jumpNextGap: next.left - jump.right,
          jumpWidth: jump.width,
          pageWidth: rect("#historyTarget").width,
          toolbarContainsAll: ["#roundPicker", "#historyTarget", "#comparisonModes", "#historyCounts", "#changeNavigation", "#historyStatus"].every((selector) =>
            document.querySelector(".changes-toolbar").contains(document.querySelector(selector))),
        };
      });
      expect(Math.max(...layout.rowCentres) - Math.min(...layout.rowCentres)).toBeLessThanOrEqual(1);
      expect(layout.formatCountsGap).toBe(8);
      expect(layout.contextGap).toBe(8);
      expect(layout.contextNavigationGap).toBeGreaterThanOrEqual(8);
      expect(layout.navigationToolsGap).toBeGreaterThanOrEqual(8);
      expect(layout.navigationCentreOffset).toBeLessThanOrEqual(1);
      expect(layout.previousJumpGap).toBe(8);
      expect(layout.jumpNextGap).toBe(8);
      expect(layout.jumpWidth).toBeLessThanOrEqual(128);
      expect(layout.pageWidth).toBeLessThanOrEqual(192);
      expect(layout.toolbarContainsAll).toBe(true);
      const source = page.getByRole("button", { name: "Source", exact: true });
      await page.locator("#historyTarget").focus();
      await page.keyboard.press("Tab");
      await expect(page.locator("#previousChange")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.locator("#changeJump")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.locator("#nextChange")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Content", exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(source).toBeFocused();
      await page.locator("#nextChange").focus();
      await page.keyboard.press("Shift+Tab");
      await expect(page.locator("#changeJump")).toBeFocused();
      await source.focus();
      await page.keyboard.press("Enter");
      await expect(source).toHaveAttribute("aria-pressed", "true");
    });
  }
}

for (const viewport of [{ width: 320, height: 568 }, { width: 768, height: 400 }]) {
  test(`sticky tools leave navigated content visible at ${viewport.width}x${viewport.height}`, async ({ page, review }) => {
    await page.setViewportSize(viewport);
    await mockHistory(page, continuousComparison);
    await openReview(page, review, writeFile(review, "short-sticky.html", "<p>Review document</p>"));
    await page.locator("#seeChanges").click();
    for (const mode of ["Content", "Source"]) {
      await page.getByRole("button", { name: mode, exact: true }).click();
      await selectChoice(page, "changeJump", "1");
      await expect(page.locator(".comparison-current")).toHaveAttribute("data-row-id", "row-43");
      await expect.poll(() => page.evaluate(() => {
        const header = document.getElementById("comparisonHeader").getBoundingClientRect();
        const panelElement = document.getElementById("historyPanel");
        const panel = panelElement.getBoundingClientRect();
        const selected = document.querySelector(".comparison-current").getBoundingClientRect();
        return {
          stickyOffset: Math.round(header.top - panel.top - parseFloat(getComputedStyle(panelElement).paddingTop)),
          readingSpace: Math.round(Math.min(innerHeight, panel.bottom) - header.bottom),
          selectedVisible: selected.bottom > header.bottom && selected.top < Math.min(innerHeight, panel.bottom),
        };
      })).toEqual({ stickyOffset: 0, readingSpace: expect.any(Number), selectedVisible: true });
      expect(await page.evaluate(() => Math.min(innerHeight, document.getElementById("historyPanel").getBoundingClientRect().bottom) -
        document.getElementById("comparisonHeader").getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(80);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.locator("#comparisonModes")).toBeVisible();
      await expect(page.locator("#changeJump")).toBeVisible();
    }
  });
}

test("Source-only zero and single changes retain display controls without navigation or an extra page field", async ({ page, review }) => {
  let count = 0;
  const rounds = [{ roundId: "round-a", ordinal: 1, feedbackStatus: "acknowledged",
    targets: [{ key: "page-a", filename: "Single page.html", resultRevisionId: "result-a" }] }];
  await mockHistory(page, (mode) => mode === "source"
    ? { available: true, counts: { added: count, modified: 0, removed: 0 },
      changes: Array.from({ length: count }, () => ({ kind: "added", label: "Only change", after: "Added text" })) }
    : { available: false, reason: "No Content snapshot" }, rounds);
  await openReview(page, review, writeFile(review, "few-changes.html", "<p>Review document</p>"));
  for (count = 0; count < 2; count++) {
    if (count) await page.reload();
    await page.locator("#seeChanges").click();
    await expect(page.locator("#comparisonHeader")).toBeVisible();
    await expect(page.locator("#comparisonModes")).toHaveText("Source");
    await expectCounts(page, count, 0, 0);
    await expect(page.locator("#changeNavigation")).toBeHidden();
    await expect(page.locator("#historyTargetLabel")).toBeHidden();
    await expect(page.locator("#historyStatus")).toContainText("Source available");
  }
});

test("G7 radio menu Escape does not cancel a hidden comment draft", async ({ page, review }) => {
  await mockHistory(page);
  await openReview(page, review, writeFile(review, "g7-escape-draft.html", "<p>Keep this comment draft.</p>"));
  const frame = await waitForSdk(page);
  await frame.locator("p").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await frame.locator("#commentAction").click();
  await page.locator("#composeText").fill("Keep this draft while browsing history");
  await page.locator("#seeChanges").click();
  await expect(page.locator("#roundPicker")).toHaveAttribute("data-value", "round-a");
  for (const id of ["roundPicker", "historyTarget", "changeJump"]) {
    const trigger = page.locator(`#${id}`);
    await trigger.focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("menu")).toHaveCount(1);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  await page.locator("#latestVersion").click();
  await expect(page.locator("#composeText")).toHaveValue("Keep this draft while browsing history");
});

test("radio menus have one owner, retain checked choices and do not steal outside focus on rapid reopen", async ({ page, review }) => {
  await mockHistory(page, continuousComparison);
  await openReview(page, review, writeFile(review, "choice-lifecycle.html", "<p>Live review</p>"));
  await page.locator("#seeChanges").click();
  const round = page.locator("#roundPicker");
  const target = page.locator("#historyTarget");
  const jump = page.locator("#changeJump");
  await expect(round).toHaveText("Round 2");
  await expect(round).toHaveAccessibleName("Review round: Round 2 · completed");
  await expect(round).toHaveAttribute("title", "Round 2 · completed");
  await expect(target).toHaveAccessibleName(`Comparison page: ${completedRounds()[0].targets[0].filename}`);

  for (const [trigger, value] of [[round, "round-a"], [target, "page-a"], [jump, "0"]]) {
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toHaveCount(1);
    await expect(choiceItem(page, value)).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("menuitemradio").and(page.locator('[aria-checked="true"]'))).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }

  await round.click();
  await target.click();
  await expect(page.getByRole("menu")).toHaveCount(1);
  await expect(round).toHaveAttribute("aria-expanded", "false");
  await expect(target).toHaveAttribute("aria-expanded", "true");
  await expect(choiceItem(page, "page-a")).toHaveAttribute("aria-checked", "true");
  await jump.click();
  await expect(page.getByRole("menu")).toHaveCount(1);
  await expect(target).toHaveAttribute("aria-expanded", "false");
  await choiceItem(page, "1").click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(jump).toBeFocused();
  await expect(jump).toHaveAccessibleName("Jump to change: 2 of 2");
  await expect(jump.locator("#changePosition")).toHaveText("2 of 2");
  await expect(page.locator(".comparison-current")).toHaveAttribute("data-row-id", "row-43");
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.locator(".comparison-current").evaluate((element) => {
    const selected = element.getBoundingClientRect();
    const header = document.getElementById("comparisonHeader").getBoundingClientRect();
    return selected.bottom > header.bottom && selected.top < innerHeight;
  })).toBe(true);

  await jump.click();
  await expect(choiceItem(page, "1")).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator("#changePosition")).toHaveText("1 of 2");
  await expect(page.getByRole("button", { name: "Source", exact: true })).toBeFocused();
  for (let index = 0; index < 3; index++) {
    await round.click();
    await expect(page.getByRole("menu")).toHaveCount(1);
    await round.click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await target.click();
    await expect(page.getByRole("menu")).toHaveCount(1);
    await page.locator("#latestVersion").click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.locator("#latestVersion")).toBeFocused();
    await expect(page.locator("#historyPanel")).toBeHidden();
    await page.locator("#seeChanges").click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.locator("#seeChanges")).toBeFocused();
  }
});

for (const width of [390, 1440]) {
  test(`long radio lists scroll, expose full labels and support keyboard typeahead at ${width}px`, async ({ page, review }) => {
    await page.setViewportSize({ width, height: 568 });
    const filename = `${"A deliberately long reviewed page filename ".repeat(6)}.html`;
    const targets = Array.from({ length: 60 }, (_, index) => ({
      key: `page-${index}`, filename: index === 0 ? filename : index === 59 ? "Zebra final reviewed page.html" : `Document ${index}.html`,
      resultRevisionId: `result-${index}`,
    }));
    const rounds = Array.from({ length: 40 }, (_, index) => ({
      roundId: `round-${index}`, ordinal: 40 - index, feedbackStatus: "acknowledged", captureStatus: "ready", targets,
    }));
    await mockHistory(page, () => ({
      available: true, counts: { added: 0, modified: 70, removed: 0 },
      changes: Array.from({ length: 70 }, (_, index) => ({
        kind: "modified", label: `Change ${index}: ${"Long descriptive change label ".repeat(5)}`,
        before: `Before ${index}`, after: `After ${index}`,
      })),
    }), rounds);
    await openReview(page, review, writeFile(review, `long-choices-${width}.html`, "<p>Live review</p>"));
    await page.locator("#seeChanges").click();
    await expectCounts(page, 0, 70, 0);
    await expect(page.locator("#historyTarget")).toHaveAttribute("title", filename);
    await expect(page.locator("#historyTarget")).toHaveAccessibleName(`Comparison page: ${filename}`);
    expect(await page.locator("#historyTarget").evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(192);

    for (const [id, length, last] of [["roundPicker", 40, "round-39"], ["historyTarget", 60, "page-59"], ["changeJump", 70, "69"]]) {
      const trigger = page.locator(`#${id}`);
      await expect(trigger).toBeEnabled();
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      const menu = page.getByRole("menu");
      await expect(menu).toHaveCount(1);
      await expect(menu.getByRole("menuitemradio")).toHaveCount(length);
      expect(await menu.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const scroller = [element, ...element.querySelectorAll("*")].find((node) =>
          /auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight);
        return {
          bounded: bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight,
          scrollable: Boolean(scroller),
        };
      })).toEqual({ bounded: true, scrollable: true });
      if (id === "historyTarget") {
        await expect(choiceItem(page, "page-0")).toHaveText(filename);
        await page.keyboard.type("Zebra");
      } else {
        await page.keyboard.press("End");
      }
      await expect(choiceItem(page, last)).toBeFocused();
      await expect(choiceItem(page, last)).toBeInViewport();
      await page.keyboard.press("Enter");
      await expect(menu).toHaveCount(0);
      await expect(trigger).toHaveAttribute("data-value", last);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect(choiceItem(page, last)).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    }
    await expect(page.locator("#changePosition")).toHaveText("70 of 70");
    await expect(page.locator(".comparison-current")).toContainText("After 69");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("ending the session in another review window disposes an open Changes menu", async ({ page, review }) => {
  await mockHistory(page);
  await openReview(page, review, writeFile(review, "ended-choice-menu.html", "<p>Keep the authored document mounted</p>"));
  await waitForSdk(page);
  await page.locator("#frame").evaluate((element) => { window.choiceFrameBeforeEnd = element; });
  const other = await page.context().newPage();
  try {
    await other.goto(page.url());
    await waitForSdk(other);
    await page.locator("#seeChanges").click();
    await page.locator("#roundPicker").click();
    await expect(page.getByRole("menu")).toHaveCount(1);
    await other.locator("#commentsButton").click();
    await other.locator("#endReview").click();
    await other.getByRole("alertdialog").getByRole("button", { name: "End review", exact: true }).click();
    await expect(other.locator(".ended")).toBeVisible();
    await expect(page.locator(".ended")).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.locator("#roundPicker")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#seeChanges")).toBeDisabled();
    expect(await page.locator("#frame").evaluate((element) => element === window.choiceFrameBeforeEnd)).toBe(true);
  } finally {
    await other.close();
  }
});

test("an unavailable round retains the compact Round toolbar and can recover to a completed comparison", async ({ page, review }) => {
  await mockHistory(page, (mode, key) => key === "page-c"
    ? { available: false, changes: [], reason: "No saved representation is available." }
    : comparison(mode, key));
  await openReview(page, review, writeFile(review, "unavailable-round-toolbar.html", "<p>Live review</p>"));
  await page.locator("#seeChanges").click();
  await selectChoice(page, "roundPicker", "round-b");
  await expect(page.locator("#historyStatus")).not.toContainText(/Loading|Refreshing/);
  await expect(page.locator("#comparisonHeader")).toBeVisible();
  await expect(page.locator(".changes-toolbar #roundPicker")).toBeEnabled();
  await expect(page.locator("#comparisonModes")).toBeHidden();
  await expect(page.locator("#historyCounts")).toBeHidden();
  await expect(page.locator("#changeNavigation")).toBeHidden();
  await expect(page.locator("#changeDetail")).toBeHidden();
  await expect(page.locator("#historyTargetLabel")).toBeHidden();
  expect(await page.locator("#historyStatus").evaluate((element) => {
    const header = document.getElementById("comparisonHeader");
    return !header.contains(element) && Boolean(element.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await selectChoice(page, "roundPicker", "round-a");
  await expect(page.locator("#historyTarget")).toHaveAttribute("data-value", "page-a");
  await expect(page.locator("#changeDetail")).toContainText("page-a");
  await expectCounts(page, 1, 1, 1);
  await expect(page.locator(".changes-toolbar #historyStatus")).toBeVisible();
});

test("G7 loading/error/empty and retry are explicit without remounting the authored page", async ({ page, review }) => {
  let failing = true, release;
  const delayed = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/session/*/history", async (route) => {
    if (failing) {
      await delayed;
      return route.fulfill({ status: 503, json: { error: "History unavailable" } });
    }
    await route.fulfill({ json: { rounds: [] } });
  });
  await openReview(page, review, writeFile(review, "g7-empty.html", "<h1>Live page</h1>"));
  await waitForSdk(page);
  await page.locator("#seeChanges").click();
  await expect(page.locator("#historyStatus")).toHaveText("Loading comparison…");
  release();
  await expect(page.locator("#historyError")).toContainText("History unavailable");
  failing = false;
  await page.locator("#historyRetry").click();
  await expect(page.locator("#historyStatus")).toContainText("No review rounds");
  await expect(page.locator("#comparisonHeader")).toBeVisible();
  await expect(page.locator("#roundPicker")).toBeDisabled();
  await expect(page.locator("#changeDetail")).toBeHidden();
  await expect(page.locator("#historyCounts")).toBeHidden();
});

test("G7 stale selection responses cannot relabel detail and failed finalization stays retryable", async ({ page, review }) => {
  const rounds = completedRounds();
  rounds[1].captureStatus = "failed";
  rounds[1].targets[0] = { key: "page-c", filename: "Earlier.html", capture: { status: "failed" } };
  let release, holding = false, finishes = 0;
  const delayed = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/session/*/history**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/capture")) {
      finishes++;
      if (finishes === 1) return route.fulfill({ json: {
        ok: false, round: { targets: [{ key: "page-c", capture: { error: "Cannot finish now" } }] },
      } });
      rounds[1].targets[0].capture.status = "unavailable";
      return route.fulfill({ json: { ok: true, round: rounds[1] } });
    }
    if (url.pathname.endsWith("/round-b") && !holding) { holding = true; await delayed; }
    await route.fulfill({ json: url.pathname.endsWith("/compare")
      ? comparison(url.searchParams.get("mode"), url.searchParams.get("key"))
      : url.pathname.endsWith("/history") ? { rounds }
        : { round: rounds.find((round) => url.pathname.endsWith(round.roundId)) } });
  });
  await openReview(page, review, writeFile(review, "g7-races.html", "<h1>Live page</h1>"));
  await waitForSdk(page);
  await page.locator("#seeChanges").click();
  await expect(page.locator("#roundPicker")).toHaveAttribute("data-value", "round-a");
  await selectChoice(page, "roundPicker", "round-b");
  await expect(page.locator("#historyStatus")).toHaveText("Loading comparison…");
  await expect(page.locator("#roundPicker")).toBeEnabled();
  await expect(page.locator("#historyTarget")).toBeDisabled();
  await expect(page.locator("#changeJump")).toBeDisabled();
  await selectChoice(page, "roundPicker", "round-a");
  release();
  await expect(page.locator("#historyTarget")).toHaveAttribute("data-value", "page-a");
  await expect(page.locator("#changeDetail")).toContainText("page-a");
  await selectChoice(page, "roundPicker", "round-b");
  await expect(page.locator("#captureResult")).toBeDisabled();
  await page.locator("#historyDiagnostics > summary").click();
  await page.locator("#finishCapture").click();
  await expect(page.locator("#historyError")).toContainText("Cannot finish now");
  await expect(page.locator("#finishCapture")).toBeEnabled();
  await page.locator("#finishCapture").click();
  await expect(page.locator("#finishCapture")).toBeHidden();
  expect(finishes).toBe(2);
});
