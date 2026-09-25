import fs from "node:fs";
import { test, expect, openReview, waitForSdk, writeFile, seedThread, feedback } from "./helpers.js";

for (const changes of [false, true]) test(`an earlier SDK report arriving after a newer projection cannot corrupt current membership (${changes ? "Changes" : "Review"})`, async ({ page, review }, info) => {
  await page.addInitScript(() => {
    // Hold genuine envelopes, preserving source/origin and frame-to-shell order.
    // Pause the newer projection before the SDK consumes it, not its response.
    const shell = window === window.top;
    const probe = window.anchorOrdering = { trace: [], held: [], replaying: false, holding: true };
    window.addEventListener("message", (event) => {
      if (!["eh:threadAnchors", "eh:threadAnchorStates", "eh:threadAction"].includes(event.data?.type)) return;
      probe.trace.push({ at: Date.now(), replay: probe.replaying, data: event.data });
      if (probe.replaying || !probe.holding) return;
      if ((shell && event.data.type === "eh:threadAnchorStates" && event.data.anchors.length === 1) ||
          (shell && event.data.type === "eh:threadAction") ||
          (!shell && event.data.type === "eh:threadAnchors" && event.data.anchors.length === 2)) {
        probe.held.push(event);
        event.stopImmediatePropagation();
      }
    }, true);
    probe.release = () => {
      probe.holding = false;
      probe.replaying = true;
      for (const event of probe.held.splice(0)) window.dispatchEvent(new MessageEvent("message", {
        data: event.data, origin: event.origin, source: event.source,
      }));
      probe.replaying = false;
    };
  });
  const ref = await openReview(page, review, writeFile(review, `anchor-ordering-${changes ? "changes" : "review"}.html`,
    '<p id="one">First target</p><p id="two">Second target</p><input aria-label="Authored input">'));
  const frame = await waitForSdk(page);
  try {
    await seedThread(review, ref, "First conversation", { kind: "element", anchor: { selector: "#one" } });
    await expect.poll(() => page.evaluate(() => window.anchorOrdering.held.length)).toBeGreaterThan(0);
    await frame.locator(".block-badge").first().click();
    await expect.poll(() => page.evaluate(() => window.anchorOrdering.held.some((event) => event.data.type === "eh:threadAction"))).toBe(true);
    await seedThread(review, ref, "Second conversation", { kind: "element", anchor: { selector: "#two" } });
    await feedback(page);
    await expect(page.locator(".conversation-thread")).toHaveCount(2);
    await expect.poll(() => frame.locator("body").evaluate(() => window.anchorOrdering.held.length)).toBeGreaterThan(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    if (changes) {
      await page.locator("#theme").click();
      await page.locator("#seeChanges").click();
    }
    await page.evaluate(() => window.anchorOrdering.release());
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".conversation-panel")).toHaveAttribute("data-host", "feedback");
    await frame.locator("body").evaluate(() => window.anchorOrdering.release());
    if (changes) await page.locator("#latestVersion").click();
    await feedback(page);
    await expect(page.locator(".conversation-thread").getByRole("button", { name: "Jump to", exact: true })).toHaveCount(2);
    for (const control of await page.locator(".conversation-thread").getByRole("button", { name: "Jump to", exact: true }).all()) {
      await expect(control).toBeEnabled();
    }
    const earlier = await page.evaluate(() => ({
      report: window.anchorOrdering.trace.find(({ data }) => data.type === "eh:threadAnchorStates" && data.anchors.length === 1).data,
      action: window.anchorOrdering.trace.find(({ data }) => data.type === "eh:threadAction").data,
      current: window.anchorOrdering.trace.filter(({ data }) => data.type === "eh:threadAnchorStates" && data.anchors.length === 2).at(-1).data,
    }));
    expect(earlier.current.projectionRevision).toBeGreaterThan(earlier.report.projectionRevision);
    expect(earlier.action.projectionRevision).toBe(earlier.report.projectionRevision);
    await frame.locator("body").evaluate((_node, action) => parent.postMessage(action, "*"), earlier.action);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator(".conversation-panel")).toHaveAttribute("data-host", "feedback");
    await frame.locator("#one").evaluate((element) => { element.hidden = true; });
    const original = page.locator(`[data-thread="${earlier.action.threadId}"]`);
    await expect(original.getByRole("button", { name: "Jump to", exact: true })).toBeDisabled();
    await frame.locator("body").evaluate((_node, report) => parent.postMessage(report, "*"), earlier.report);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(original.getByRole("button", { name: "Jump to", exact: true })).toBeDisabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    fs.writeFileSync(info.outputPath("ordering-trace.json"), JSON.stringify({
      shell: await page.evaluate(() => window.anchorOrdering.trace),
      frame: await frame.locator("body").evaluate(() => window.anchorOrdering.trace),
    }, null, 2));
  }
});

test("current invalid anchor reports stay explicit errors while foreign sources cannot replace geometry", async ({ page, review }) => {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    window.anchorReports = [];
    window.addEventListener("message", ({ data, source }) => {
      if (source === document.querySelector("#frame")?.contentWindow && data?.type === "eh:threadAnchorStates") {
        window.anchorReports.push(data);
      }
    });
  });
  const ref = await openReview(page, review, writeFile(review, "anchor-invalid.html", '<p id="copy">A verified target</p>'));
  const frame = await waitForSdk(page);
  await seedThread(review, ref, "Keep this conversation");
  await expect.poll(() => page.evaluate(() => window.anchorReports.at(-1)?.anchors.length)).toBe(1);
  const current = await page.evaluate(() => window.anchorReports.at(-1));
  await feedback(page);
  const target = page.locator(".conversation-thread").getByRole("button", { name: "Jump to", exact: true });
  await expect(target).toBeEnabled();
  await page.evaluate((report) => window.postMessage({
    ...report, anchors: [{ threadId: report.anchors[0].threadId, state: "missing" }],
  }, "*"), current);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(target).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  for (const corrupt of [
    (report) => Object.fromEntries(Object.entries(report).filter(([key]) => key !== "projectionRevision")),
    (report) => ({ ...report, projectionRevision: 0 }),
    (report) => ({ ...report, projectionRevision: "1" }),
    (report) => ({ ...report, projectionRevision: report.projectionRevision + 1 }),
    (report) => ({ ...report, anchors: [] }),
    (report) => ({ ...report, anchors: [{ ...report.anchors[0], threadId: "unknown-thread" }] }),
    (report) => ({ ...report, reviewId: "foreign-review" }),
  ]) {
    const invalid = corrupt(await page.evaluate(() => window.anchorReports.at(-1)));
    await frame.locator("body").evaluate((_node, report) => parent.postMessage(report, "*"), invalid);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(target).toBeEnabled();
    // Refresh reads retain diagnostics. A fresh shell/frame recovers this mixed-wire fixture.
    await page.reload();
    await waitForSdk(page);
    await expect.poll(() => page.evaluate(() => window.anchorReports.at(-1)?.anchors.length)).toBe(1);
    await feedback(page);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(target).toBeEnabled();
  }
});
