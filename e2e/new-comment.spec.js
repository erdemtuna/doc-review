import fs from "node:fs";
import { test, expect, openReview, waitForSdk, writeFile, feedback, listed } from "./helpers.js";
import { fieldNotes } from "../test/fixtures/readme-review.js";

const source = `<!doctype html><style>body{padding:36px;font:16px/1.5 system-ui}p{width:420px;margin:60px 0}#space{height:1800px}</style>
<p id="copy">A concise selection for a new comment.</p><button id="origin">Authored control</button>
<p id="other">A different target that must not steal a draft.</p><div id="space"></div>`;
async function start(page, review) {
  const ref = await openReview(page, review, writeFile(review, `new-comment-${review.references.length}.html`, source));
  const frame = await waitForSdk(page);
  return { ref, frame };
}
const composer = (page) => page.locator(".conversation-new-message");
const editor = (page) => composer(page).getByRole("textbox", { name: "New message" });
async function select(page, frame) {
  await frame.locator("#copy").click({ clickCount: 3 });
  await frame.locator("#commentAction").click();
  await expect(editor(page)).toBeVisible();
}

test("UX baseline: empty close can change targets, whitespace cannot; heading label differs from its exact selector", async ({ page, review }, info) => {
  await openReview(page, review, writeFile(review, "heading-label-baseline.html",
    "<!doctype html><style>body{padding:40px}h2{margin:40px 0;width:420px}</style><h2 id='previous'>Previous section</h2><h2 id='chosen' tabindex='0'>Chosen heading itself</h2><p id='other' tabindex='0'>Another precise target</p>"));
  const frame = await waitForSdk(page);
  await page.evaluate(() => {
    window.uxTargets = [];
    window.addEventListener("message", ({ data }) => {
      if (data?.type === "eh:openComment") window.uxTargets.push(data);
    });
  });
  const open = async selector => {
    await frame.locator(selector).focus();
    await frame.locator(selector).press("Control+Alt+m");
    await expect(editor(page)).toBeVisible();
  };
  await open("#chosen");
  const heading = await page.evaluate(() => window.uxTargets.at(-1));
  expect(heading.anchor.label).toContain("Previous section");
  expect(await frame.locator(heading.anchor.selector).evaluate(node => node.id)).toBe("chosen");
  await composer(page).getByRole("checkbox", { name: "Request a change" }).check();
  await composer(page).getByRole("button", { name: "Close comment" }).click();
  await open("#other");
  const focusOnly = await page.evaluate(() => window.uxTargets.at(-1));
  expect(focusOnly.anchor.selector).toBe(heading.anchor.selector);
  await composer(page).getByRole("button", { name: "Close comment" }).click();
  await frame.locator("#other").click({ clickCount: 3 });
  await frame.locator("#commentAction").click();
  await expect(editor(page)).toBeVisible();
  const other = await page.evaluate(() => window.uxTargets.at(-1));
  expect(other.anchor.quote).toContain("Another precise target");
  await expect(composer(page).getByRole("checkbox", { name: "Request a change" })).not.toBeChecked();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await editor(page).fill("   ");
  await expect(composer(page).getByRole("button", { name: "Save message" })).toBeDisabled();
  await composer(page).getByRole("button", { name: "Close comment" }).click();
  await frame.locator("#chosen").click({ clickCount: 3 });
  await frame.locator("#chosen").press("Control+Alt+m");
  await feedback(page);
  await expect(page.getByRole("alert")).toContainText("Save or cancel");
  await expect(editor(page)).toHaveValue("   ");
  await page.screenshot({ path: info.outputPath("whitespace-retarget-baseline.png") });
  fs.writeFileSync(info.outputPath("heading-and-draft-baseline.json"), JSON.stringify({
    heading: { selector: heading.anchor.selector, label: heading.anchor.label, actualId: "chosen" },
    focusOnlyAfterClose: "reopens previous element target and its permission; selecting new prose creates a new target",
    emptyCloseRetarget: "accepted; permission reset", whitespaceCloseRetarget: "rejected; whitespace retained",
    originalLiveEmptyBlocker: "not reproduced by a genuinely empty draft",
  }, null, 2));
});

test("UX baseline: dirty draft, IME, saving and uncertain acceptance preserve the exact save identity", async ({ page, review }, info) => {
  const { ref, frame } = await start(page, review);
  await select(page, frame);
  await editor(page).fill("Accepted original draft");
  await editor(page).evaluate(node => {
    window.uxSavingEditor = node;
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  await editor(page).press("Enter"); await editor(page).press("Escape");
  await expect(editor(page)).toHaveValue("Accepted original draft\n");
  await expect(composer(page).getByRole("button", { name: "Save message" })).toBeDisabled();
  await editor(page).evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await editor(page).fill("Accepted original draft");
  await composer(page).getByRole("button", { name: "Close comment" }).click();
  await feedback(page);
  expect(await editor(page).evaluate(node => node === window.uxSavingEditor)).toBe(true);
  await expect(editor(page)).toHaveValue("Accepted original draft");
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const requests = [];
  await page.route("**/api/conversation", async route => {
    const body = route.request().postDataJSON();
    if (body.operation !== "create-thread") return route.continue();
    requests.push(body);
    if (requests.length !== 1) return route.continue();
    await route.fetch();
    await gate;
    await route.abort("connectionreset");
  });
  try {
    await editor(page).press("Enter");
    await expect.poll(() => requests.length).toBe(1);
    await expect(composer(page).getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await editor(page).fill("Newer unsaved wording");
    await editor(page).press("Escape");
    await expect(editor(page)).toHaveValue("Newer unsaved wording");
    await page.screenshot({ path: info.outputPath("saving-preserves-newer-draft.png") });
    release();
    await expect(page.getByText("create-thread: acceptance unknown", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("save-acceptance-unknown.png") });
    await composer(page).getByRole("button", { name: "Close comment" }).click();
    await feedback(page);
    await expect(editor(page)).toHaveValue("Newer unsaved wording");
    await page.getByRole("button", { name: "Check receipt", exact: true }).click();
    await expect(page.getByText("create-thread: acceptance unknown", { exact: true })).toHaveCount(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    await expect(editor(page)).toHaveValue("Newer unsaved wording");
    const saved = (await listed(review, ref, "threads")).items;
    expect(saved).toHaveLength(1);
    expect(saved[0].latestExchange.reviewer.body).toBe("Accepted original draft");
    expect(saved[0].latestExchange.reviewer.submissionId).toBeNull();
    await editor(page).press("Escape");
    await expect(editor(page)).toHaveCount(0);
    fs.writeFileSync(info.outputPath("draft-save-baseline.json"), JSON.stringify({
      requests, acceptedThreads: saved.length, savedBody: saved[0].latestExchange.reviewer.body,
      observations: ["Synthetic IME Enter does not save; native textarea inserts newline; Escape does not cancel", "Close hides and preserves exact node", "Busy Cancel disabled and Escape ignored",
        "New typing preserved during lost accepted response", "Check receipt replays exact request; Save does not Send",
        "Idle dirty Escape discards without confirmation (known defect)"],
    }, null, 2));
  } finally { release(); await page.unroute("**/api/conversation"); }
});

test("selection and keyboard element composition use former adjacent chrome with durable explicit Save", async ({ page, review }, info) => {
  const { ref, frame } = await start(page, review);
  const before = await page.locator("#frame").boundingBox();
  await page.locator("#frame").evaluate((element) => { window.originalFrame = element; });
  await select(page, frame);
  await expect(page.getByRole("complementary", { name: "Add comment" })).toBeVisible();
  await expect(page.locator(".conversation-panel")).toHaveAttribute("data-host", "compose");
  expect(await page.locator("#frame").boundingBox()).toEqual(before);
  expect(await page.locator("#frame").evaluate((element) => window.originalFrame === element)).toBe(true);
  await expect(page.locator(".conversation-backdrop")).toBeHidden();
  expect(await page.locator(".stage").evaluate((node) => node.inert)).toBe(false);
  const targets = await frame.locator("#copy").evaluate(() => [...getSelection().getRangeAt(0).getClientRects()].map(r => ({
    left: r.left, right: r.right, top: r.top, bottom: r.bottom,
  })));
  const box = await composer(page).boundingBox();
  for (const target of targets) expect(box.x >= before.x + target.right || box.x + box.width <= before.x + target.left ||
    box.y >= before.y + target.bottom || box.y + box.height <= before.y + target.top).toBe(true);
  await expect(composer(page).getByRole("checkbox", { name: "Request a change" })).not.toBeChecked();
  await editor(page).fill("A contextual discussion");
  await editor(page).press("Shift+Enter");
  await page.keyboard.type("A second line");
  await frame.locator("#origin").click();
  expect((await listed(review, ref, "threads")).items).toHaveLength(0);
  await expect(editor(page)).toHaveValue("A contextual discussion\nA second line");
  await page.screenshot({ path: info.outputPath("new-selection-light.png") });
  await editor(page).press("Enter");
  await expect(editor(page)).toHaveCount(0);
  const saved = (await listed(review, ref, "threads")).items;
  expect(saved).toHaveLength(1);
  expect(saved[0].latestExchange.reviewer.intent).toBe("discuss");
  expect(saved[0].latestExchange.reviewer.submissionId).toBeNull();
  await frame.locator("#origin").focus();
  await frame.locator("#origin").press("Control+Alt+m");
  await expect(composer(page).getByText("Element", { exact: true })).toBeVisible();
  await expect(editor(page)).toBeFocused();
  await editor(page).fill("Keyboard element request");
  await composer(page).getByRole("checkbox", { name: "Request a change" }).check();
  await editor(page).press("Enter");
  await expect(editor(page)).toHaveCount(0);
  expect((await listed(review, ref, "threads")).items).toHaveLength(2);
});

test("one new editor stays readable through toolbar-focused resizing and respects deliberate inventory scrolling", async ({ page, review }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReview(page, review, writeFile(review, "new-readability.html", fieldNotes()));
  const frame = await waitForSdk(page);
  await frame.locator("#summary").dblclick();
  await page.keyboard.press("Control+Alt+m");
  await editor(page).fill("Please clarify this selected wording.");
  await editor(page).evaluate((node) => {
    window.newEditor = node; node.setSelectionRange(7, 14); node.dispatchEvent(new Event("select", { bubbles: true }));
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  await composer(page).getByRole("button", { name: "Open in Feedback" }).click();
  await expect(page.getByRole("complementary", { name: "Feedback" })).toBeVisible();
  await expect(composer(page).getByRole("button", { name: "Save message" })).toBeDisabled();
  await composer(page).getByRole("button", { name: "Beside selection" }).click();
  await expect(page.locator(".conversation-panel")).toHaveAttribute("data-host", "compose");
  expect(await editor(page).evaluate((node) => [node === window.newEditor, node.selectionStart, node.selectionEnd])).toEqual([true, 7, 14]);
  await composer(page).getByRole("button", { name: "Close comment" }).click();
  await expect(editor(page)).toBeHidden();
  await feedback(page);
  expect(await editor(page).evaluate((node) => node === window.newEditor)).toBe(true);
  await composer(page).getByRole("button", { name: "Beside selection" }).click();
  await page.locator("#theme").click(); await page.locator("#theme").click();
  const metrics = [];
  for (const [width, height] of [[1440, 900], [1280, 720], [900, 700], [899, 700], [768, 900], [390, 844], [390, 480], [320, 400]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
      if (width < 900) await expect(page.locator(".conversation-panel")).toHaveAttribute("data-host", "feedback");
      expect(await editor(page).evaluate((node) => [node === window.newEditor, node.selectionStart, node.selectionEnd])).toEqual([true, 7, 14]);
      await expect(editor(page)).toHaveValue("Please clarify this selected wording.");
      await expect(page.locator("#theme")).toBeFocused();
      const visibleHeight = () => editor(page).evaluate(node => {
        const box = node.getBoundingClientRect();
        let top = box.top, bottom = box.bottom;
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          if (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(parent).overflowY)) {
            const rect = parent.getBoundingClientRect();
            top = Math.max(top, rect.top + parent.clientTop);
            bottom = Math.min(bottom, rect.top + parent.clientTop + parent.clientHeight);
          }
        }
        return Math.max(0, Math.min(bottom, innerHeight) - Math.max(top, 0));
      });
      await expect.poll(visibleHeight).toBeGreaterThanOrEqual(18);
      await expect(page.locator("#theme")).toBeFocused();
      await expect(composer(page).getByRole("button", { name: "Save message" })).toBeDisabled();
      await page.screenshot({ path: info.outputPath(`new-comment-initial-${theme}-${width}x${height}.png`) });
      const font = await page.locator("#draft-note").evaluate(node => getComputedStyle(node).fontSize);
      // Composition extends the shared editor typography; host styles need not equal the card body's font.
      await expect(editor(page)).toHaveCSS("font-size", font);
      expect(parseFloat(font)).toBeGreaterThanOrEqual(13);
      const save = composer(page).getByRole("button", { name: "Save message" });
      const rect = await save.boundingBox();
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width);
      metrics.push({ theme, width, height, host: await page.locator(".conversation-panel").getAttribute("data-host"),
        font, visibleEditorHeight: await visibleHeight(), panel: await page.locator(".conversation-panel").boundingBox(), frame: await page.locator("#frame").boundingBox(), save: rect });
      await page.screenshot({ path: info.outputPath(`new-comment-${theme}-${width}x${height}.png`) });
    }
  }
  const permission = composer(page).getByRole("checkbox", { name: "Request a change" });
  await permission.scrollIntoViewIfNeeded();
  await expect(permission).toBeInViewport();
  const save = composer(page).getByRole("button", { name: "Save message" });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  const inventory = page.locator(".conversation-inventory");
  const bounds = await inventory.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, -1000);
  await expect.poll(() => inventory.evaluate(node => node.scrollTop)).toBe(0);
  await page.locator("#theme").click();
  await editor(page).evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await expect(composer(page).getByRole("button", { name: "Save message" })).toBeEnabled();
  expect(await inventory.evaluate(node => node.scrollTop)).toBe(0);
  await expect(page.locator("#theme")).toBeFocused();
  fs.writeFileSync(info.outputPath("new-comment-geometry.json"), JSON.stringify(metrics, null, 2));
});

test("new-target boundary rejects stale or foreign intent and keeps exact draft during geometry fallback", async ({ page, review }) => {
  await page.addInitScript(() => {
    window.targetTrace = [];
    window.addEventListener("message", ({ data }) => {
      if (["eh:openComment", "eh:commentOpenResult"].includes(data?.type)) window.targetTrace.push(data);
    });
  });
  const { frame } = await start(page, review);
  await select(page, frame);
  const opening = await page.evaluate(() => window.targetTrace.find(data => data.type === "eh:openComment"));
  const post = (data) => frame.locator("body").evaluate((_node, payload) => parent.postMessage(payload, "*"), data);
  await editor(page).fill("Must keep the exact anchor");
  await editor(page).evaluate(node => { window.newEditor = node; });
  await page.evaluate(payload => window.postMessage(payload, "*"), { ...opening, targetGeneration: 900 });
  await post({ ...opening, capability: "foreign", targetGeneration: 900 });
  await expect(editor(page)).toHaveValue("Must keep the exact anchor");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await post({ ...opening, targetGeneration: opening.targetGeneration + 1,
    anchor: { ...opening.anchor, quote: "A rejected retarget" } });
  await expect(page.getByRole("alert")).toContainText("Save or cancel");
  await composer(page).getByRole("button", { name: "Close comment" }).click();
  await post(opening); // A rejected newer intent must not invalidate the retained authoritative target.
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toBeFocused();
  await expect(editor(page)).toHaveValue("Must keep the exact anchor");
  await post({ ...opening, type: "eh:targetGeometry", anchor: { ...opening.anchor, quote: "Wrong target" } });
  await expect(page.getByRole("alert")).toContainText("cannot replace the original anchor");
  await expect(composer(page).locator("blockquote")).toContainText("A concise selection");
  await post({ ...opening, type: "eh:targetGeometry", viewport: null, clip: null });
  await expect(page.locator(".conversation-panel")).toHaveAttribute("data-host", "feedback");
  expect(await editor(page).evaluate(node => node === window.newEditor)).toBe(true);
  await expect(editor(page)).toHaveValue("Must keep the exact anchor");
  await post({ ...opening, type: "eh:targetGeometry" });
  await composer(page).getByRole("button", { name: "Beside selection" }).click();
  await expect(page.locator(".conversation-panel")).toHaveAttribute("data-host", "compose");
  await composer(page).getByRole("button", { name: "Close comment" }).click();
  await page.setViewportSize({ width: 390, height: 480 });
  await post({ ...opening, type: "eh:targetGeometry" });
  await expect(editor(page)).toBeHidden(); // Geometry/fallback must never reopen an incidentally closed draft.
  await feedback(page);
  await editor(page).press("Escape");
  await expect(editor(page)).toHaveCount(0);
  await post(opening);
  await expect(page.getByRole("alert")).toContainText("target is stale");
  await expect(editor(page)).toHaveCount(0);
  await expect.poll(() => frame.locator("body").evaluate(() => window.targetTrace.at(-1)?.accepted)).toBe(false);
});

test("nested clipping pins to the effective edge and removed targets or shared End never replace the draft", async ({ page, review }, info) => {
  await page.addInitScript(() => {
    window.revealed = null;
    window.addEventListener("message", ({ data }) => {
      if (data?.type === "eh:revealTargetResult") window.revealed = data.success;
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReview(page, review, writeFile(review, "new-clipped.html", `<!doctype html>
    <style>body{margin:40px;font:16px system-ui}#clip{height:550px;width:1100px;overflow:auto;border:2px solid}
    p{margin:40px;width:420px}#space{height:2000px}</style>
    <div id="clip"><p id="copy">A concise selection for a new comment.</p><div id="space"></div></div>`));
  const frame = await waitForSdk(page);
  await select(page, frame);
  await editor(page).fill("Retain when the target disappears");
  await editor(page).evaluate(node => { window.newEditor = node; });
  await frame.locator("#clip").evaluate(node => { node.scrollTop = 700; });
  await expect(composer(page).getByText("Selection is above", { exact: true })).toBeVisible();
  await expect(page.locator(".conversation-panel")).toHaveClass(/edge-top/);
  const clip = await frame.locator("#clip").boundingBox(), box = await composer(page).boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(clip.y);
  expect(box.y + box.height).toBeLessThanOrEqual(clip.y + clip.height);
  await page.screenshot({ path: info.outputPath("nested-offscreen-composer.png") });
  await composer(page).getByRole("button", { name: "Back to selection" }).click();
  await expect.poll(() => page.evaluate(() => window.revealed)).toBe(true);
  await expect(frame.locator("#copy")).toBeInViewport();
  await frame.locator("#copy").evaluate(node => node.remove());
  await expect(page.locator(".conversation-panel")).toHaveAttribute("data-host", "feedback");
  await expect(composer(page).getByRole("status")).toContainText("cannot currently be shown");
  expect(await editor(page).evaluate(node => node === window.newEditor)).toBe(true);
  await expect(editor(page)).toHaveValue("Retain when the target disappears");
  await expect(composer(page).getByRole("button", { name: "Beside selection" })).toBeHidden();
  await page.locator("#endReview").click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(editor(page)).toHaveAttribute("readonly", "");
  expect(await editor(page).evaluate(node => node === window.newEditor)).toBe(true);
  await expect(composer(page).getByRole("button", { name: "Save message" })).toHaveCount(0);
});
