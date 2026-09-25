import fs from "node:fs";
import { test, expect, openReview, waitForSdk, enterEditMode, writeFile, reviewApi, listed } from "./helpers.js";

const html = `<!doctype html><html><head><style>
body{font:16px/1.6 system-ui;margin:24px;max-width:760px}button{min-width:44px;min-height:44px}
</style></head><body>
  <h1>Release readiness review</h1>
  <nav role="tablist" id="sections">
    <button role="tab" id="first" aria-controls="first-panel" aria-selected="true">Overview</button>
    <button role="tab" id="second" aria-controls="second-panel" aria-selected="false">Rollout</button>
  </nav>
  <section role="tabpanel" id="first-panel"><p id="copy">Original source</p>
    <p>Validate production alerts, regional ownership, and rollback procedures before increasing traffic.</p>
  </section>
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

async function changeCopy(page, frame, text) {
  await enterEditMode(page);
  await frame.locator("#copy").click();
  await frame.locator("#copy").evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.insertText(text);
}

test("self-contained interactions run automatically; runtime and human edits remain feedback-only", async ({ page, review }) => {
  const approvals = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/trust")) approvals.push(request.url());
  });
  const file = writeFile(review, "automatic-tabs.html", html);
  const session = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await expect(frame.locator("#copy")).toHaveText("Runtime wording");
  await expect(page.getByRole("switch")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await frame.locator("#second").click();
  await expect(frame.locator("#second-panel")).toBeVisible();
  await expect(page.locator("#frame")).not.toHaveAttribute("sandbox", /allow-same-origin/);
  expect((await listed(review, session, "edits")).items).toEqual([]);
  await frame.locator("#first").click();
  await changeCopy(page, frame, "Human feedback on runtime wording");
  await expect.poll(async () => (await listed(review, session, "edits")).totalCount).toBeGreaterThan(0);
  expect(fs.readFileSync(file, "utf8")).toBe(html);
  const metadata = (await reviewApi(review, `/api/page/${session.key}?session=${session.sessionId}`)).json();
  expect(metadata.savePolicy).toBe("feedback-only");
  expect(metadata.executionMode).toBe("interactive");
  expect(approvals).toEqual([]);
});

test("inert examples and data scripts retain static HTML autosave", async ({ page, review }) => {
  const source = `<!doctype html><p id="copy">Static source</p>
    <!-- <script>not executable</script> -->
    <pre>&lt;script&gt;example&lt;/script&gt;</pre>
    <script type="application/ld+json">{"name":"Example"}</script>
    <script type="application/json">{"enabled":true}</script>
    <template><script>window.inertExample = true;</script></template>`;
  const file = writeFile(review, "static-data.html", source);
  const session = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await changeCopy(page, frame, "Saved static edit");
  await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("Saved static edit");
  expect((await reviewApi(review, `/api/page/${session.key}?session=${session.sessionId}`)).json().savePolicy).toBe("writable");
  expect(await frame.locator("body").evaluate(() => window.inertExample)).toBeUndefined();
});

test("source script addition and removal automatically reclassify the displayed frame", async ({ page, review }) => {
  const staticSource = '<!doctype html><p id="copy">Static source</p>';
  const file = writeFile(review, "source-transitions.html", staticSource);
  const session = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  fs.writeFileSync(file, html);
  await expect(frame.locator("#copy")).toHaveText("Runtime wording");
  await waitForSdk(page);
  expect((await reviewApi(review, `/api/page/${session.key}?session=${session.sessionId}`)).json().savePolicy).toBe("feedback-only");
  fs.writeFileSync(file, staticSource.replace("Static source", "New static source"));
  await expect(frame.locator("#copy")).toHaveText("New static source");
  await waitForSdk(page);
  await changeCopy(page, frame, "Autosave restored");
  await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("Autosave restored");
  expect((await reviewApi(review, `/api/page/${session.key}?session=${session.sessionId}`)).json().savePolicy).toBe("writable");
});

test("a source transition preserves conversation drafts and configures the new frame with its served policy", async ({ page, review }) => {
  await page.addInitScript(() => {
    window.reviewConfigurations = [];
    window.addEventListener("message", (event) => {
      if (event.data?.type === "eh:configureReview") window.reviewConfigurations.push(event.data);
    });
  });
  const file = writeFile(review, "held-source-transition.html", '<!doctype html><p id="copy">Original source</p>');
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await frame.locator("#copy").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await frame.locator("#commentAction").click();
  await page.getByRole("textbox", { name: "New message", exact: true }).fill("Keep this source-directed draft");
  const rendered = await page.locator("#frame").getAttribute("src");
  fs.writeFileSync(file, html);
  await expect(page.locator("#frame")).not.toHaveAttribute("src", rendered);
  await expect(frame.locator("#copy")).toHaveText("Runtime wording");
  await waitForSdk(page);
  expect(await frame.locator("body").evaluate(() => window.reviewConfigurations[0].savePolicy)).toBe("feedback-only");
  await expect(page.getByRole("textbox", { name: "New message", exact: true })).toHaveValue("Keep this source-directed draft");
  expect(fs.readFileSync(file, "utf8")).toBe(html);
});

test("contextual recovery is keyboard operable and preserves feedback-only policy without normal script-policy controls", async ({ page, review }) => {
  const requests = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/execution") && request.method() === "POST") requests.push(request.postDataJSON());
  });
  const file = writeFile(review, "recovery.html", html);
  const session = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await expect(page.getByRole("button", { name: "More", exact: true })).toHaveCount(0);
  await page.route("**/api/session/*/render/*/ready", (route) => route.fulfill({ status: 503, json: { error: "Ready unavailable" } }));
  const updatedSource = `${html}\n<!-- contextual recovery -->`;
  writeFile(review, "recovery.html", updatedSource);
  const reload = page.getByRole("button", { name: "Reload source (discard local page edits)", exact: true });
  await expect(reload).toBeEnabled();
  await page.unroute("**/api/session/*/render/*/ready");
  await reload.focus(); await page.keyboard.press("Enter");
  await expect(frame.locator("#copy")).toHaveText("Runtime wording");
  await waitForSdk(page);
  await frame.locator("#second").click();
  await expect(frame.locator("#second-panel")).toBeVisible();
  await frame.locator("#first").click();
  await changeCopy(page, frame, "Recovery feedback");
  await expect.poll(async () => (await listed(review, session, "edits")).totalCount).toBeGreaterThan(0);
  expect(fs.readFileSync(file, "utf8")).toBe(updatedSource);
  expect(requests).toEqual([]);
  await page.reload();
  await waitForSdk(page);
  expect(await page.locator("body").getAttribute("data-session")).not.toBe(session.sessionId);
  await expect(frame.locator("body")).toHaveAttribute("data-executed", "yes");
  expect((await listed(review, session, "edits")).totalCount).toBeGreaterThan(0);
  const fresh = await openReview(page, review, file);
  expect(fresh.sessionId).not.toBe(session.sessionId);
  await waitForSdk(page);
  await expect(frame.locator("#copy")).toHaveText("Runtime wording");
});

test("pasted images in local scripted feedback render from staging without rewriting source", async ({ page, review }) => {
  const file = writeFile(review, "scripted-paste.html", html);
  const session = await openReview(page, review, file);
  const frame = await enterEditMode(page);
  await frame.locator("#copy").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII="), (char) => char.charCodeAt(0));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([bytes], "review.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  });
  const image = frame.locator("#copy img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => element.complete && element.naturalWidth > 0)).toBe(true);
  await expect.poll(async () => (await listed(review, session, "edits")).totalCount).toBeGreaterThan(0);
  expect(fs.readFileSync(file, "utf8")).toBe(html);
});

test("served review layout has accessible controls without overflow across widths and themes", async ({ page, review }, testInfo) => {
  await openReview(page, review, writeFile(review, "release-readiness-long-regional-rollout-review.html", html));
  await waitForSdk(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const geometry = await page.evaluate(() => {
        const bounds = (element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { id: element.id || element.tagName, x, y, width, height };
        };
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          controls: [...document.querySelectorAll(".shell-toolbar button, .shell-toolbar select")].filter((element) => element.checkVisibility()).map(bounds),
          toolbar: bounds(document.querySelector(".shell-toolbar")), frame: bounds(document.querySelector("#frame")),
        };
      });
      expect(geometry.overflow).toBe(false);
      expect(geometry.frame.y).toBeGreaterThanOrEqual(geometry.toolbar.y + geometry.toolbar.height);
      for (const [index, control] of geometry.controls.entries()) {
        expect(control.width, control.id).toBeGreaterThanOrEqual(32);
        expect(control.height, control.id).toBeGreaterThanOrEqual(32);
        expect(control.x).toBeGreaterThanOrEqual(0);
        expect(control.x + control.width).toBeLessThanOrEqual(width);
        for (const other of geometry.controls.slice(index + 1)) {
          expect(control.x < other.x + other.width && control.x + control.width > other.x &&
            control.y < other.y + other.height && control.y + control.height > other.y, `${control.id} overlaps ${other.id}`).toBe(false);
        }
      }
      await page.screenshot({ path: testInfo.outputPath(`review-${theme}-${width}.png`) });
      await page.locator("#modeButton").click();
      const menu = await page.getByRole("menu").boundingBox();
      expect(menu.x).toBeGreaterThanOrEqual(0);
      expect(menu.x + menu.width).toBeLessThanOrEqual(width);
      await page.keyboard.press("Escape");
      await expect(page.locator("#modeButton")).toHaveAttribute("aria-expanded", "false");
    }
  }
});

for (const width of [1440, 390]) {
  test(`source replacement at ${width}px keeps the prior document painted until replacement is ready`, async ({ page, review }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await openReview(page, review, writeFile(review, "painted-recovery.html", html));
    const frame = await waitForSdk(page);
    const toolbarBefore = await page.locator(".shell-toolbar").boundingBox();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/session/*/render/*/ready", async (route) => {
      await gate;
      await route.continue();
    });
    try {
      writeFile(review, "painted-recovery.html", `${html}\n<!-- source replacement -->`);
      await expect(page.locator("#previousFrame")).toBeVisible();
      await expect(page.locator("#previousFrame")).toHaveAttribute("inert", "");
      await expect(page.frameLocator("#previousFrame").locator("#copy")).toHaveText("Runtime wording");
      await expect(page.locator("#frame")).toHaveAttribute("data-replacing", "true");
      expect(await page.locator(".shell-toolbar").boundingBox()).toEqual(toolbarBefore);
      await page.screenshot({ path: testInfo.outputPath(`recovery-loading-${width}.png`) });
    } finally {
      release();
    }
    await expect(page.locator("#previousFrame")).toHaveCount(0);
    await expect(frame.locator("#copy")).toHaveText("Runtime wording");
    await waitForSdk(page);
    expect(await page.locator(".shell-toolbar").boundingBox()).toEqual(toolbarBefore);
  });
}

test("failed ready handshake exposes recovery and can reload successfully", async ({ page, review }) => {
  await openReview(page, review, writeFile(review, "failed-recovery.html", html));
  await waitForSdk(page);
  await page.route("**/api/session/*/render/*/ready", (route) => route.fulfill({
    status: 503, json: { error: "Ready unavailable" },
  }));
  writeFile(review, "failed-recovery.html", `${html}\n<!-- source replacement -->`);
  await expect(page.getByRole("alert")).toContainText("could not confirm");
  await expect(page.locator("#previousFrame")).toHaveCount(0);
  await expect(page.locator("#frame")).not.toHaveAttribute("data-replacing");
  await expect(page.getByRole("button", { name: "Reload source (discard local page edits)", exact: true })).toBeVisible();
  await page.unroute("**/api/session/*/render/*/ready");
  await page.getByRole("button", { name: "Reload source (discard local page edits)", exact: true }).click();
  const frame = await waitForSdk(page);
  await expect(frame.locator("#copy")).toHaveText("Runtime wording");
  await expect(page.getByRole("button", { name: "Reload source (discard local page edits)", exact: true })).toBeHidden();
});
