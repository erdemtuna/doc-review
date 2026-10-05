import { test, expect, openReview, writeFile, waitForSdk, seedThread, feedback, sendPending, conversation, handled, renderedContrast, setReviewTheme } from "./helpers.js";
import { randomUUID } from "node:crypto";

async function waiting(page, review) {
  const ref = await openReview(page, review, writeFile(review, `waiting-${randomUUID()}.html`, "<p id='copy'>An exact passage.</p>"));
  await waitForSdk(page);
  await seedThread(review, ref, "Explain this passage.");
  await feedback(page);
  await expect(page.locator("#send")).toBeEnabled();
  await sendPending(review, ref);
  await expect(page.locator(".waiting-indicator")).toHaveAttribute("data-active", "true");
  return ref;
}

test("waiting matrix has exact geometry and motion, pauses for reduced motion and completes authoritatively", async ({ page, review }, info) => {
  const ref = await waiting(page, review), matrix = page.locator(".waiting-indicator");
  const geometry = await matrix.evaluate(node => {
    const box = node.getBoundingClientRect();
    const dots = [...node.children].map(dot => {
      const box = dot.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, animation: getComputedStyle(dot).animationName };
    });
    return { width: box.width, height: box.height, dots };
  });
  expect(geometry.width).toBe(16); expect(geometry.height).toBe(16);
  expect(geometry.dots).toHaveLength(6);
  expect(new Set(geometry.dots.map(dot => dot.y)).size).toBe(2);
  expect(new Set(geometry.dots.map(dot => dot.x)).size).toBe(3);
  for (const dot of geometry.dots) expect(dot).toMatchObject({ width: 3, height: 3, animation: "waiting-cadence" });
  expect(geometry.dots[1].x - geometry.dots[0].x).toBe(5);
  expect(geometry.dots[3].y - geometry.dots[0].y).toBe(5);
  const phases = () => matrix.locator("span").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).opacity));
  const before = await phases();
  await expect.poll(phases).not.toEqual(before);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => matrix.locator("span").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationName)))
    .toEqual(Array(6).fill("none"));
  await conversation(review, ref, "poll");
  await expect(page.locator(".conversation-lifecycle")).toHaveAccessibleDescription(/The agent has your feedback/);
  await page.screenshot({ path: info.outputPath("waiting-reduced-motion.png"), animations: "disabled" });
  await handled(review, ref);
  await expect(page.locator(".conversation-lifecycle")).toHaveText("Reviewing");
  await expect(matrix).toHaveCount(0);
});

test("disabled Send exposes the cause on hover/focus without changing native action or closing Feedback on first Escape", async ({ page, review }, info) => {
  await waiting(page, review);
  await page.getByRole("button", { name: "Note to agent", exact: true }).click();
  await page.getByRole("textbox", { name: "Note to agent", exact: true }).fill("Next-round context");
  const send = page.locator("#send"), wrapper = page.getByRole("group", { name: "Send unavailable" });
  await expect(send).toBeDisabled();
  await expect(send).toHaveText("Send to agent (1)");
  await expect(send).toHaveAccessibleDescription(/Waiting for agent.*Selected: 1 note/);
  await wrapper.hover();
  await expect(page.getByRole("tooltip")).toContainText("can't send another batch yet");
  await page.screenshot({ path: info.outputPath("send-hover-desktop.png"), animations: "disabled" });
  await page.getByRole("button", { name: "End review", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(wrapper).toBeFocused();
  await page.screenshot({ path: info.outputPath("send-focus-desktop.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(wrapper).toBeFocused();
  await expect(page.getByRole("complementary", { name: "Feedback" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(send).toBeDisabled();
  await expect(page.locator(".send-touch-reason")).toBeHidden();
  await page.screenshot({ path: info.outputPath("send-desktop.png"), animations: "disabled" });
});

test("shared inventory capsule explains both counts without adding commands", async ({ page, review }) => {
  await waiting(page, review);
  const button = page.locator("#commentsButton"), capsule = button.locator(".feedback-inventory-badge");
  await expect(button).toHaveAccessibleDescription("1 open conversations; 0 manual edits awaiting handling");
  await expect(button.locator('[data-slot="badge"]')).toHaveCount(1);
  await expect(capsule.locator("button")).toHaveCount(0);
  for (const theme of ["light", "dark"]) {
    await setReviewTheme(page, theme);
    for (const expanded of [true, false]) {
      if (await button.getAttribute("aria-expanded") !== String(expanded)) await button.click();
      await page.mouse.move(300, 100);
      await expect.poll(() => button.evaluate(node => node.getAnimations({ subtree: true }).some(animation => animation.playState === "running"))).toBe(false);
      expect(await renderedContrast(capsule)).toBeGreaterThanOrEqual(4.5);
      await capsule.locator('[data-inventory="edits"]').hover();
      await expect(page.getByRole("tooltip")).toHaveText("0 manual edits awaiting handling");
      await page.mouse.move(300, 100);
      await button.focus();
      await expect(page.getByRole("tooltip")).toContainText("1 open conversations; 0 manual edits awaiting handling");
      await button.press("Escape");
    }
  }
});

for (const [width, height] of [[390, 480], [320, 400]]) test(`touch ${width}x${height} has a consistent compact reason and one-tap Feedback`, async ({ browser, review }, info) => {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    await waiting(page, review);
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    await expect(page.locator(".send-touch-reason")).toHaveText("Waiting for agent");
    await expect(page.locator(".send-touch-reason")).toBeInViewport({ ratio: 1 });
    await expect(page.locator("#send")).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.locator("#commentsButton").tap();
    await expect(page.locator("#commentsButton")).toHaveAttribute("aria-expanded", "false");
    await page.locator(".feedback-inventory-badge").tap();
    await expect(page.locator("#commentsButton")).toHaveAttribute("aria-expanded", "true");
    await page.screenshot({ path: info.outputPath(`touch-${width}.png`), animations: "disabled" });
  } finally { await context.close(); }
});
