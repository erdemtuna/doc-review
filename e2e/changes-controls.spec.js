import { test, expect, openReview, waitForSdk, writeFile, feedback, submissionHistory, seedThread, sendPending, handled, mutate } from "./helpers.js";
import { choiceItem, selectChoice } from "./choice-helpers.js";
import { REVIEW_PALETTE } from "../src/review-palette.js";

function comparison(mode, count = 2) {
  const rows = Array.from({ length: 44 }, (_, index) => {
    const changed = count > 0 && (index === 0 || (count > 1 && index === 43));
    const beforeBlock = { tag: "p", text: `Context ${index}: ${"Saved readable text. ".repeat(6)}`, startLine: index + 1 };
    const afterBlock = { ...beforeBlock };
    if (changed) afterBlock.text = `Revised ${mode} paragraph ${index}. ${"Updated readable text. ".repeat(6)}`;
    if (mode === "content" && index === 4) { afterBlock.tag = "img"; afterBlock.attributes = { src: "https://saved.invalid/tracker.png", alt: "Historical image" }; }
    if (mode === "content" && index === 5) { afterBlock.tag = "script"; afterBlock.text = "<script>window.historicalScriptExecuted=true</script>"; }
    return { id: `row-${index}`, kind: changed ? "modified" : "unchanged", changeId: changed ? `change-${index}` : null, beforeBlock, afterBlock };
  });
  return { available: true, mode, version: 2, rows, counts: { added: 0, modified: count, removed: 0 },
    limitations: ["visible_only"], viewComparison: { status: "unverified", message: "Visible content only; matching view not verified." },
    changes: rows.filter((row) => row.changeId).map((row) => ({ id: row.changeId, kind: row.kind, beforeBlock: row.beforeBlock, afterBlock: row.afterBlock })) };
}
async function setup(page, review, { count = 2, rounds = 2, pages = false } = {}) {
  const ref = await openReview(page, review, writeFile(review, `comparison-${Date.now()}.html`, "<p id='copy'>Live content</p><input aria-label='Live draft' value='Preserved'>"));
  await waitForSdk(page);
  const other = pages ? await mutate(review, ref, "join-page", { target: writeFile(review, "another-comparison.html", "<p>Another page</p>") }) : null;
  for (let i = 0; i < rounds; i++) {
    await seedThread(review, ref, `Submission ${i}`);
    if (other) await seedThread(review, { ...ref, key: other.value.pageKey }, `Other page ${i}`);
    await sendPending(review, ref);
    await handled(review, ref);
  }
  await page.route("**/api/conversation/comparison", (route) => route.fulfill({ json: comparison(route.request().postDataJSON().mode, count) }));
  await feedback(page);
  await submissionHistory(page);
  await expect(page.locator(".conversation-submission")).toHaveCount(rounds);
  await page.locator(".conversation-submission").first().locator(":scope > summary").click();
  await page.locator(".conversation-submission").first().getByRole("button", { name: "Content changes" }).first().click();
  const region = page.getByRole("region", { name: "Saved comparison" });
  await expect(region.getByRole("heading", { name: "Submission result", exact: true })).toBeVisible();
  await expect(region.getByRole("button", { name: "Content", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(region.getByRole("status")).toHaveCount(0);
  return { ref, region };
}

  test("comparison page selector uses actual multi-page submitted membership", async ({ page, review }) => {
    const { region, ref } = await setup(page, review, { pages: true, rounds: 1 });
    const requests = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/conversation/comparison")) requests.push(request.postDataJSON());
    });
    await page.locator("#historyTarget").click();
    await expect(page.getByRole("menuitemradio")).toHaveCount(2);
    const other = page.getByRole("menuitemradio").filter({ hasText: "another-comparison.html" });
    const key = await other.getAttribute("data-choice-value"); await other.click();
    await expect(page.locator("#historyTarget")).toHaveAttribute("data-value", key);
    await expect(region.getByRole("status")).toHaveCount(0);
    expect(requests.at(-1)).toMatchObject({ reviewId: ref.reviewId, pageKey: key });
  });

  for (const theme of ["light", "dark"]) test(`comparison count and legend semantic inks remain readable in ${theme}`, async ({ page, review }) => {
    await page.addInitScript((value) => localStorage.setItem("doc-review:theme", value), theme);
    const { region } = await setup(page, review, { rounds: 1 });
    await region.getByText("Comparison details", { exact: true }).click();
    for (const kind of ["added", "modified", "removed"]) {
      const color = REVIEW_PALETTE[theme][`review-count-${kind}`];
      const rgb = `rgb(${color.slice(1).match(/../g).map((part) => parseInt(part, 16)).join(", ")})`;
      for (const selector of [`.changes-counts .changes-${kind}`, `.changes-legend .changes-${kind}`]) {
        const element = region.locator(selector).locator("svg");
        await expect(element).toHaveCSS("color", rgb);
        const contrast = await element.evaluate((node) => {
          let parent = node, background;
          while (parent) {
            background = getComputedStyle(parent).backgroundColor;
            if (background !== "rgba(0, 0, 0, 0)" && background !== "transparent") break;
            parent = parent.parentElement;
          }
          const luminance = (color) => {
            const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((value) => {
              value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
            });
            return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
          };
          const a = luminance(getComputedStyle(node).color), b = luminance(background);
          return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        });
        expect(contrast).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
for (const width of [320, 390, 768, 814, 1440]) for (const theme of ["light", "dark"]) {
  test(`comparison controls, context, safe reconstruction and keyboard navigation ${width}px ${theme}`, async ({ page, review }, testInfo) => {
    await page.setViewportSize({ width, height: 740 });
    await page.addInitScript((theme) => localStorage.setItem("doc-review:theme", theme), theme);
    const requests = []; page.on("request", (request) => { if (request.url().includes("saved.invalid")) requests.push(request.url()); });
    const { region } = await setup(page, review);
    await page.locator("#frame").evaluate((element) => { window.savedFrame = element; });
    await region.locator(".comparison-expand").first().click();
    const expanded = region.locator('[data-row-id="row-10"]');
    await expect(expanded).toBeVisible();
    await expanded.evaluate((element) => { window.savedRow = element; });
    await expect(region).toContainText("Historical image");
    expect(await region.locator("script,img,iframe,a,[src]").count()).toBe(0);
    await page.locator("#theme").click(); await page.locator("#theme").click();
    await region.getByRole("button", { name: "Close comparison" }).click();
    await expect(page.frameLocator("#frame").getByLabel("Live draft")).toHaveValue("Preserved");
    await page.locator(".conversation-submission").first().getByRole("button", { name: "Content changes" }).click();
    await expect(region.getByRole("status")).toHaveCount(0);
    expect(await expanded.evaluate((element) => element === window.savedRow)).toBe(true);
    for (const mode of ["content", "source"]) {
      if (mode === "source") await region.getByRole("button", { name: "Source", exact: true }).click();
      await expect(region.getByRole("status")).toHaveCount(0);
      await selectChoice(page, "changeJump", "1");
      await expect(region.locator(".comparison-current")).toHaveAttribute("data-row-id", "row-43");
      await expect.poll(() => region.locator(".comparison-current").evaluate((element) => {
        const box = element.getBoundingClientRect(), header = element.closest("section[aria-label='Saved comparison']").querySelector("header").getBoundingClientRect();
        return box.bottom > header.bottom && box.top < innerHeight;
      })).toBe(true);
      for (const button of await region.locator("header button").all()) {
        const box = await button.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await region.getByRole("button", { name: "Previous change" }).click();
      await expect(region.locator(".comparison-current")).toHaveAttribute("data-row-id", "row-0");
      await page.screenshot({ path: testInfo.outputPath(`comparison-${mode}-${width}-${theme}.png`), animations: "disabled" });
    }
    expect(requests).toEqual([]);
    expect(await page.evaluate(() => window.historicalScriptExecuted)).toBeUndefined();
    expect(await page.locator("#frame").evaluate((element) => element === window.savedFrame)).toBe(true);
  });
}

for (const [width, height] of [[320, 400], [768, 430], [1440, 400]]) {
  test(`sticky comparison tools leave the selected change reachable at ${width}x${height}`, async ({ page, review }) => {
    await page.setViewportSize({ width, height });
    const { region } = await setup(page, review);
    await selectChoice(page, "changeJump", "1");
    const last = region.locator(".comparison-current");
    await expect(last).toHaveAttribute("data-row-id", "row-43");
    const box = await last.boundingBox(), header = await region.locator("header").boundingBox();
    expect(box.y + box.height).toBeGreaterThan(header.y + header.height);
    expect(box.y).toBeLessThan(height);
  });
}

for (const count of [0, 1]) test(`${count} changes preserve format controls without unnecessary navigation`, async ({ page, review }) => {
  const { region } = await setup(page, review, { count, rounds: 1 });
  await expect(region.getByRole("navigation")).toHaveCount(0);
  await expect(region.getByRole("button", { name: "Comparison page", exact: false })).toHaveCount(0);
  await region.getByRole("button", { name: "Source", exact: true }).click();
  await expect(region.getByRole("button", { name: "Source", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(region.getByRole("img", { name: `${count} modified changes` })).toBeVisible();
});

test("comparison menu Escape leaves a hidden conversation draft intact and menus have one owner", async ({ page, review }) => {
  const { region } = await setup(page, review);
  await region.getByRole("button", { name: "Close comparison" }).click();
  await feedback(page);
  await page.getByRole("button", { name: "New message", exact: true }).click();
  await page.getByRole("textbox", { name: "New message", exact: true }).fill("Preserve hidden draft");
  await page.getByRole("button", { name: "View result", exact: true }).click();
  await page.locator("#submissionPicker").click();
  await expect(page.getByRole("menu")).toHaveCount(1);
  await page.keyboard.press("Escape"); await expect(page.locator("#submissionPicker")).toBeFocused();
  await page.locator("#changeJump").click(); await expect(page.getByRole("menu")).toHaveCount(1);
  await page.keyboard.press("Escape"); await expect(page.locator("#changeJump")).toBeFocused();
  await page.keyboard.press("Escape"); await expect(region).toBeHidden();
  await expect(page.getByRole("textbox", { name: "New message", exact: true })).toHaveValue("Preserve hidden draft");
});

for (const width of [320, 1440]) test(`long real submission lists scroll and retain selected identity at ${width}px`, async ({ page, review }) => {
  test.setTimeout(90_000); await page.setViewportSize({ width, height: 500 });
  const { region } = await setup(page, review, { rounds: 25 });
  await page.locator("#submissionPicker").click();
  const items = page.getByRole("menuitemradio");
  await expect(items).toHaveCount(25);
  const chosen = await items.last().getAttribute("data-choice-value");
  await items.last().scrollIntoViewIfNeeded(); await items.last().click();
  await expect(page.locator("#submissionPicker")).toHaveAttribute("data-value", chosen);
  await expect(region.getByRole("status")).toHaveCount(0);
  const trigger = page.locator("#submissionPicker");
  await trigger.click(); await expect(choiceItem(page, chosen)).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
});

test("loading, malformed response, unavailable capture and retry remain independent of the live frame", async ({ page, review }) => {
  const { region } = await setup(page, review);
  await page.locator("#frame").evaluate((element) => { window.savedFrame = element; });
  let attempts = 0;
  await page.route("**/api/conversation/comparison", async (route) => {
    attempts++;
    if (attempts === 1) return route.fulfill({ json: { wrong: "shape" } });
    if (attempts === 2) return route.fulfill({ json: { available: false, mode: route.request().postDataJSON().mode, reason: "Content exceeded processing limits.", changes: [] } });
    await route.fulfill({ json: comparison(route.request().postDataJSON().mode) });
  });
  await region.getByRole("button", { name: "Source", exact: true }).click();
  await expect(region.getByRole("alert")).toContainText("Invalid comparison response");
  await region.getByRole("button", { name: "Retry comparison" }).click();
  await region.getByText("Comparison details", { exact: true }).click();
  await expect(region).toContainText("Content exceeded processing limits");
  await region.getByRole("button", { name: "Content", exact: true }).click();
  await expect(region.getByRole("img", { name: "2 modified changes" })).toBeVisible();
  expect(await page.locator("#frame").evaluate((element) => element === window.savedFrame)).toBe(true);
});

test("slow stale comparison cannot overwrite newer selection or reopen a closed comparison", async ({ page, review }) => {
  const { region } = await setup(page, review);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/conversation/comparison", async (route) => {
    if (route.request().postDataJSON().mode === "source") await gate;
    await route.fulfill({ json: comparison(route.request().postDataJSON().mode) });
  });
  await region.getByRole("button", { name: "Source", exact: true }).click();
  await expect(region.getByRole("status")).toContainText("Loading");
  await region.getByRole("button", { name: "Content", exact: true }).click();
  await expect(region.getByRole("status")).toHaveCount(0);
  release(); await page.waitForTimeout(150);
  await expect(region.getByRole("button", { name: "Content", exact: true })).toHaveAttribute("aria-pressed", "true");
  let closeRelease;
  const closed = new Promise((resolve) => { closeRelease = resolve; });
  await page.route("**/api/conversation/comparison", async (route) => { await closed; await route.fulfill({ json: comparison("source") }); });
  await region.getByRole("button", { name: "Source", exact: true }).click();
  await expect(region.getByRole("status")).toBeVisible();
  await region.getByRole("button", { name: "Close comparison" }).click();
  closeRelease(); await page.waitForTimeout(150); await expect(region).toBeHidden();
});

test("shared End retains a usable read-only comparison and closes its menu only on dismissal", async ({ page, review }) => {
  const { ref, region } = await setup(page, review);
  await page.locator("#changeJump").click();
  await mutate(review, ref, "end", { confirmUnsentReadOnly: true });
  await expect(page.locator(".conversation-lifecycle")).toHaveText("Review ended");
  await page.keyboard.press("Escape"); await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(region).toBeVisible();
  await region.getByRole("button", { name: "Next change" }).click();
  await expect(region.locator(".comparison-current")).toHaveAttribute("data-row-id", "row-43");
});
