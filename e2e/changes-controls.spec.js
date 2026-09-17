import { test, expect, openReview, waitForSdk, writeFile } from "./helpers.js";

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
async function mockHistory(page, compare = comparison) {
  const rounds = completedRounds();
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
        await page.locator("#changeJump").selectOption("1");
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

for (const width of [320, 390, 768, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`G7 controls fit ${width}px ${theme}, retain frame/detail identity and keyboard selection`, async ({ page, review }, testInfo) => {
      await page.setViewportSize({ width, height: 740 });
      await page.addInitScript((value) => localStorage.setItem("doc-review:theme", value), theme);
      await mockHistory(page);
      await openReview(page, review, writeFile(review, `g7-${width}-${theme}.html`, "<h1>Authored page</h1><input aria-label='Live draft' value='Preserve me'>"));
      const frame = await waitForSdk(page);
      await page.locator("#frame").evaluate((element) => { window.g7Frame = element; });
      await page.locator("#seeChanges").click();
      await expect(page.locator("#roundPicker")).toHaveValue("round-a");
      await expect(page.locator("#historyCounts")).toHaveText("1 Added · 1 Modified · 1 Removed");
      await page.locator("#changeDetail").evaluate((element) => {
        window.g7Detail = element.firstElementChild;
        window.g7Round = document.getElementById("roundPicker");
      });
      for (const selector of ["#roundPicker", "#historyTarget", "#comparisonModes", "#changeNavigation"]) {
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
      await expect(page.locator("#changeJump")).toHaveValue("2");
      await expect(page.locator("#nextChange")).toBeDisabled();
      await page.locator("#comparisonModes").getByRole("button", { name: "Source", exact: true }).click();
      await expect(page.locator("#changePosition")).toHaveText("1 of 3");
      await page.locator("#historyTarget").selectOption("page-b");
      await expect(page.locator("#comparisonModes")).toHaveText("Source");
      await expect(page.locator("#historyUnavailable")).toContainText("processing limits");
      await expect(page.locator("#historyDiagnostics")).toHaveAttribute("open", "");
      await expect(page.locator("#historyLimitations")).toHaveAttribute("open", "");
      await page.locator("#roundPicker").focus();
      await page.keyboard.press("ArrowDown");
      await expect(page.locator("#roundPicker")).toHaveValue("round-b");
      await page.locator("#roundPicker").selectOption("round-a");
      await expect(page.locator("#historyTarget")).toHaveValue("page-b");
      await page.locator("#historyTarget").selectOption("page-a");
      await expect(page.locator('#comparisonModes button[aria-pressed="true"]')).toHaveText("Source");
      await page.locator("#historyPanel").evaluate((element) => { element.scrollTop = 0; });
      await page.screenshot({ path: testInfo.outputPath(`g7-controls-${width}-${theme}.png`), animations: "disabled" });
      await page.locator("#latestVersion").click();
      expect(await page.locator("#frame").evaluate((element) => element === window.g7Frame)).toBe(true);
      await expect(frame.getByLabel("Live draft")).toHaveValue("Preserve me");
    });

  }
}

test("G7 native selector Escape does not cancel a hidden comment draft", async ({ page, review }) => {
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
  await expect(page.locator("#roundPicker")).toHaveValue("round-a");
  await page.locator("#roundPicker").focus();
  await page.keyboard.press("Escape");
  await page.locator("#latestVersion").click();
  await expect(page.locator("#composeText")).toHaveValue("Keep this draft while browsing history");
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
  await expect(page.locator("#roundPicker")).toHaveValue("round-a");
  await page.locator("#roundPicker").selectOption("round-b");
  await expect(page.locator("#historyStatus")).toHaveText("Loading comparison…");
  await page.locator("#roundPicker").selectOption("round-a");
  release();
  await expect(page.locator("#historyTarget")).toHaveValue("page-a");
  await expect(page.locator("#changeDetail")).toContainText("page-a");
  await page.locator("#roundPicker").selectOption("round-b");
  await expect(page.locator("#captureResult")).toBeDisabled();
  await page.locator("#historyDiagnostics > summary").click();
  await page.locator("#finishCapture").click();
  await expect(page.locator("#historyError")).toContainText("Cannot finish now");
  await expect(page.locator("#finishCapture")).toBeEnabled();
  await page.locator("#finishCapture").click();
  await expect(page.locator("#finishCapture")).toBeHidden();
  expect(finishes).toBe(2);
});
