import fs from "node:fs";
import { test, expect, openReview, waitForSdk, enterEditMode, writeFile, reviewApi } from "./helpers.js";

const html = `<!doctype html><html><body>
  <nav role="tablist" id="sections">
    <button role="tab" id="first" aria-controls="first-panel" aria-selected="true">First</button>
    <button role="tab" id="second" aria-controls="second-panel" aria-selected="false">Second</button>
  </nav>
  <section role="tabpanel" id="first-panel"><p id="copy">Original source</p></section>
  <section role="tabpanel" id="second-panel" hidden><p>Second section</p></section>
  <script>
    document.body.dataset.executed = 'yes';
    document.getElementById('copy').textContent = 'Runtime wording';
    for (const tab of document.querySelectorAll('[role="tab"]')) tab.addEventListener('click', () => {
      for (const candidate of document.querySelectorAll('[role="tab"]')) {
        const active = candidate === tab;
        candidate.setAttribute('aria-selected', String(active));
        document.getElementById(candidate.getAttribute('aria-controls')).hidden = !active;
      }
    });
  </script>
</body></html>`;

async function approve(page) {
  await page.getByRole("switch", { name: "Enable page scripts", checked: false }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Enable page scripts" })).toBeChecked();
  const frame = await waitForSdk(page);
  await expect(frame.locator("body")).toHaveAttribute("data-executed", "yes");
  await expect(page.locator("#previousFrame")).toHaveCount(0);
  await expect(frame.locator('[data-eh-ui="trust-notice"]')).toHaveCount(0);
  return frame;
}

test("explicit version trust enables real tabs without autosaving runtime or human preview edits", async ({ page, review }) => {
  const file = writeFile(review, "trusted-tabs.html", html);
  const session = await openReview(page, review, file);
  let frame = await waitForSdk(page);
  await expect(frame.locator("#copy")).toHaveText("Original source");
  await frame.locator("#second").click();
  await expect(frame.locator("#second-panel")).toBeHidden();
  frame = await approve(page);
  await expect(frame.locator("#copy")).toHaveText("Runtime wording");
  await frame.locator("#second").click();
  await expect(frame.locator("#second-panel")).toBeVisible();
  await expect(page.locator("#frame")).not.toHaveAttribute("sandbox", /allow-same-origin/);
  expect(review.store.page(session.key).edits).toEqual([]);
  await frame.locator("#first").click();
  await enterEditMode(page);
  await frame.locator("#copy").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" plus my feedback");
  await expect.poll(() => review.store.page(session.key).edits.length).toBeGreaterThan(0);
  expect(fs.readFileSync(file, "utf8")).toBe(html);
  const forbidden = await reviewApi(review, `/api/page/${session.key}/save`, {
    method: "POST", body: { html: "<p>Do not write</p>" },
  });
  expect(forbidden.status).toBe(409);
  expect(fs.readFileSync(file, "utf8")).toBe(html);
});

test("a changed HTML version blocks scripts again and requires explicit renewed approval", async ({ page, review }) => {
  const file = writeFile(review, "trust-change.html", html);
  await openReview(page, review, file);
  await waitForSdk(page);
  await approve(page);
  fs.writeFileSync(file, html.replace("Original source", "Changed source"));
  const frame = page.frameLocator("#frame");
  await expect(frame.locator("#copy")).toHaveText("Changed source");
  await expect(page.getByRole("switch", { name: "Enable page scripts" })).not.toBeChecked();
  await expect(page.locator("#scriptStatus")).toContainText("File changed - enable again.");
  await frame.locator("#second").click();
  await expect(frame.locator("#second-panel")).toBeHidden();
  await approve(page);
  await frame.locator("#second").click();
  await expect(frame.locator("#second-panel")).toBeVisible();
  await page.getByRole("switch", { name: "Enable page scripts", checked: true }).click();
  await expect(frame.locator("#copy")).toHaveText("Changed source");
  await expect(page.getByRole("switch", { name: "Enable page scripts" })).not.toBeChecked();
});

test("script switch supports deliberate keyboard activation without hover or focus grants", async ({ page, review }) => {
  const posts = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/trust") && request.method() === "POST") posts.push(request.postDataJSON());
  });
  await openReview(page, review, writeFile(review, "keyboard-switch.html", html));
  const frame = await waitForSdk(page);
  const control = page.getByRole("switch", { name: "Enable page scripts" });
  await expect(control).toBeEnabled();
  await control.hover();
  await control.focus();
  await page.keyboard.press("Escape");
  expect(posts).toHaveLength(0);
  await page.keyboard.press("Space");
  await expect(frame.locator("body")).toHaveAttribute("data-executed", "yes");
  await expect(control).toBeChecked();
  await expect(control).toBeEnabled();
  await expect(control).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(frame.locator("body")).not.toHaveAttribute("data-executed", "yes");
  await expect(control).not.toBeChecked();
  expect(posts.map((request) => request.action)).toEqual(["grant", "revoke"]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("script switch layout and recovery states stay readable across widths and themes", async ({ page, review }, testInfo) => {
  const file = writeFile(review, "switch-layout.html", html);
  await openReview(page, review, file);
  await waitForSdk(page);
  const control = page.getByRole("switch", { name: "Enable page scripts" });
  await expect(control).toBeEnabled();
  await expect(page.locator("#scriptStatus")).toBeHidden();
  await expect(page.locator("#scriptFeedback")).toHaveCount(0);
  await expect(page.locator("#scriptHelp")).toBeHidden();
  let stableGeometry = null;
  const inspectLayout = async () => {
    const geometry = await page.evaluate(() => {
      const bounds = (selector) => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        viewport: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
        toolbar: bounds(".toolbar"), frame: bounds("#frame"),
        mode: bounds("#modeButton"),
        groups: [bounds(".toolbar-product"), bounds("#modeButton"), bounds("#documentTrustControls"), bounds("#commentsButton")],
        switch: bounds(".script-switch"),
      };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.toolbar.height).toBe(geometry.viewport > 1000 ? 53 : 91);
    expect(Math.abs(geometry.mode.x + geometry.mode.width / 2 - geometry.viewport / 2)).toBeLessThanOrEqual(1);
    expect(geometry.switch.height).toBeGreaterThanOrEqual(44);
    expect(geometry.switch.x).toBeGreaterThanOrEqual(0);
    expect(geometry.switch.x + geometry.switch.width).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.frame.y).toBeGreaterThanOrEqual(geometry.toolbar.height);
    if (stableGeometry) {
      for (const field of ["mode", "frame", "toolbar", "switch"]) {
        expect(geometry[field]).toEqual(stableGeometry[field]);
      }
    }
    for (const [i, a] of geometry.groups.entries()) {
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x + a.width).toBeLessThanOrEqual(geometry.viewport);
      for (const b of geometry.groups.slice(i + 1)) {
        const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        expect(overlaps).toBe(false);
      }
    }
    return geometry;
  };
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [1440, 1024, 680, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await inspectLayout();
      if ([1440, 390].includes(width)) {
        await page.locator(".toolbar").screenshot({ path: testInfo.outputPath(`switch-off-${theme}-${width}.png`) });
      }
    }
  }
  await page.locator("#modeButton").click();
  const menu = await page.locator("#modeMenu").boundingBox();
  expect(menu.x).toBeGreaterThanOrEqual(0);
  expect(menu.x + menu.width).toBeLessThanOrEqual(320);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  stableGeometry = await inspectLayout();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/session/*/trust", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await gate;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Permission could not be saved. Try again." }) });
  });
  await control.click();
  await expect(control).toBeDisabled();
  await expect(page.locator("#scriptStatus")).toContainText("Enabling");
  await inspectLayout();
  await page.locator(".toolbar").screenshot({ path: testInfo.outputPath("switch-busy-mobile.png") });
  release();
  await expect(page.locator("#scriptError")).toContainText("Permission could not be saved");
  await expect(control).toBeEnabled();
  await expect(control).not.toBeChecked();
  await inspectLayout();
  await page.locator(".toolbar").screenshot({ path: testInfo.outputPath("switch-error-mobile.png") });
  await page.locator(".script-details summary").click();
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.locator("#scriptError")).toBeHidden();
  await page.unroute("**/api/session/*/trust");
  await approve(page);
  await expect(page.locator("#scriptStatus")).toBeHidden();
  await inspectLayout();
  await page.locator(".toolbar").screenshot({ path: testInfo.outputPath("switch-on-mobile.png") });
  fs.writeFileSync(file, html.replace("Original source", "New source"));
  await expect(page.locator("#scriptStatus")).toContainText("File changed - enable again.");
  await inspectLayout();
  await page.locator(".toolbar").screenshot({ path: testInfo.outputPath("switch-changed-mobile.png") });
});

for (const width of [1440, 390]) {
  test(`switching at ${width}px preserves layout and keeps the prior page painted until replacement is ready`, async ({ page, review }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await openReview(page, review, writeFile(review, "stable-switch.html", html));
    const frame = await waitForSdk(page);
    const control = page.getByRole("switch", { name: "Enable page scripts" });
    await expect(control).toBeEnabled();
    await expect(page.locator("#scriptStatus")).toBeHidden();
    const copyBefore = await frame.locator("#copy").boundingBox();
    await page.evaluate(() => {
      window.switchSamples = [];
      window.sampleSwitch = true;
      const sample = () => {
        if (!window.sampleSwitch) return;
        const rect = (selector) => {
          const box = document.querySelector(selector).getBoundingClientRect();
          return [box.x, box.y, box.width, box.height];
        };
        const current = document.querySelector("#frame");
        const previous = document.querySelector("#previousFrame");
        window.switchSamples.push({
          toolbar: rect(".toolbar"), mode: rect("#modeButton"), control: rect(".script-switch"), frame: rect("#frame"),
          painted: getComputedStyle(current).opacity === "1" || (!!previous && getComputedStyle(previous).opacity === "1"),
        });
        requestAnimationFrame(sample);
      };
      sample();
    });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/session/*/render/*/ready", async (route) => {
      await gate;
      await route.continue();
    });
    await control.click();
    await expect(page.locator("#previousFrame")).toBeVisible();
    await expect(page.locator("#previousFrame")).toHaveAttribute("inert", "");
    await expect(page.frameLocator("#previousFrame").locator("#copy")).toHaveText("Original source");
    await expect(page.locator("#frame")).toHaveAttribute("data-replacing", "true");
    await page.screenshot({ path: testInfo.outputPath(`applying-${width}.png`) });
    release();
    await expect(page.locator("#previousFrame")).toHaveCount(0);
    await expect(frame.locator("#copy")).toHaveText("Runtime wording");
    await expect(frame.locator('[data-eh-ui="trust-notice"]')).toHaveCount(0);
    const copyAfter = await frame.locator("#copy").boundingBox();
    expect(copyAfter.y).toBe(copyBefore.y);
    await page.unroute("**/api/session/*/render/*/ready");
    await control.click();
    await expect(frame.locator("#copy")).toHaveText("Original source");
    await expect(page.locator("#previousFrame")).toHaveCount(0);
    await expect(page.locator("#scriptStatus")).toBeHidden();
    const samples = await page.evaluate(() => {
      window.sampleSwitch = false;
      return window.switchSamples;
    });
    expect(samples.length).toBeGreaterThan(5);
    for (const sample of samples) {
      expect(sample.painted).toBe(true);
      for (const field of ["toolbar", "mode", "control", "frame"]) {
        expect(sample[field]).toEqual(samples[0][field]);
      }
    }
    await page.getByText("?", { exact: true }).click();
    await expect(page.locator(".script-details-body")).toBeVisible();
    await expect(page.locator(".script-details-body")).toContainText("External scripts");
    const toolbar = await page.locator(".toolbar").boundingBox();
    expect(toolbar.height).toBe(samples[0].toolbar[3]);
    await page.keyboard.press("Escape");
    await expect(page.locator(".script-details-body")).toBeHidden();
  });
}

test("a failed ready handshake reveals the failure instead of leaving an old-page cover stuck", async ({ page, review }) => {
  await openReview(page, review, writeFile(review, "failed-switch.html", html));
  await waitForSdk(page);
  await page.route("**/api/session/*/render/*/ready", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: "Ready unavailable" }),
  }));
  await page.getByRole("switch", { name: "Enable page scripts" }).click();
  await expect(page.locator(".toast")).toContainText("could not confirm");
  await expect(page.locator("#previousFrame")).toHaveCount(0);
  await expect(page.locator("#frame")).not.toHaveAttribute("data-replacing");
  await expect(page.locator("#reloadNotice")).toBeVisible();
  await expect(page.locator("#scriptStatus")).toContainText("could not confirm");
  await page.unroute("**/api/session/*/render/*/ready");
  await page.locator("#safeReload").click();
  await waitForSdk(page);
  await expect(page.locator("#previousFrame")).toHaveCount(0);
  await expect(page.locator("#scriptStatus")).toBeHidden();
});
