import fs from "node:fs";
import { threadAction } from "./conversation-actions.js";
import { test, expect, openReview, waitForSdk, enterEditMode, writeFile, selectText, listed, compose, selectionMessage, feedback, intercept, failure, conversation, handled, sendPending, selectReviewMode } from "./helpers.js";

async function setup(page, review, name, source = "<p id='copy'>First paragraph to review.</p><p id='other'>Second paragraph to review.</p><button id='action'>Authored control</button>") {
  const file = writeFile(review, name, source);
  const ref = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  return { file, ref, frame };
}
const panel = (page) => page.getByRole("complementary", { name: "Feedback" });
const draft = (page) => page.getByRole("textbox", { name: "New message", exact: true });
const card = (page) => page.locator(".conversation-thread").first();
async function begin(page, frame, selector = "#copy") { await selectText(frame, selector); await frame.locator("#commentAction").click(); await expect(draft(page)).toBeVisible(); }
async function close(page) {
  if (await page.locator(".conversation-panel").isVisible()) {
    await page.locator(".conversation-panel").getByRole("button", { name: /^(Close|Close comment)$/, exact: true }).click();
  } else await expect(page.locator(".conversation-panel")).toBeHidden(); // Save closes contextual composition.
}

for (const mode of ["view", "edit"]) test(`explicit selection and keyboard block targeting share the durable inventory in ${mode}`, async ({ page, review }) => {
  const { ref, frame } = await setup(page, review, `targeting-${mode}.html`);
  if (mode === "edit") await enterEditMode(page);
  await begin(page, frame); await compose(page, "Selection feedback");
  await feedback(page);
  await expect(card(page)).toContainText("Selection feedback");
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(1);
  await close(page);
  await frame.locator("#action").focus(); await frame.locator("#action").press("Control+Alt+m");
  await compose(page, "Control feedback");
  await feedback(page);
  expect((await listed(review, ref, "threads")).items.map((item) => item.thread.target.kind).sort()).toEqual(["element", "selection"]);
  await page.getByRole("button", { name: /Overall note \(optional\)/ }).click();
  await expect(page.getByRole("textbox", { name: "Overall note" })).toHaveValue("");
});

test("Save and Cancel restore the exact authored control, and later renders do not reopen composition", async ({ page, review }) => {
  const { frame } = await setup(page, review, "restored-control.html");
  await frame.locator("#action").focus(); await frame.locator("#action").press("Control+Alt+m");
  await compose(page, "Review control");
  await expect(frame.locator("#action")).toBeFocused();
  await page.locator("#theme").click(); await expect(draft(page)).toHaveCount(0);
  await close(page);
  await frame.locator("#action").focus(); await frame.locator("#action").press("Control+Alt+m");
  await draft(page).fill("Discard local"); await draft(page).press("Escape");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(frame.locator("#action")).toBeFocused();
});

test("only confirmed deletion removes a never-submitted thread and returns reachable focus", async ({ page, review }) => {
  const { frame, ref } = await setup(page, review, "delete-thread.html");
  await selectionMessage(page, frame, "#copy", "Delete this only when confirmed");
  await (await threadAction(page, card(page), "Delete thread")).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  expect((await listed(review, ref, "threads")).items).toHaveLength(1);
  await (await threadAction(page, card(page), "Delete thread")).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Confirm" }).click();
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator("#commentsButton")).toBeFocused();
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(0);
});

test("Escape cancels only the current draft; closing a host never resolves its thread", async ({ page, review }) => {
  const { frame, ref } = await setup(page, review, "escape-priority.html");
  await selectionMessage(page, frame, "#copy", "Keep thread");
  await card(page).getByRole("button", { name: "Reply", exact: true }).click();
  const reply = page.getByRole("textbox", { name: "Reply", exact: true });
  await reply.fill("Cancelled"); await reply.press("Escape");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(reply).toHaveCount(0); await expect(panel(page)).toBeVisible();
  await card(page).getByRole("button", { name: "Focus", exact: true }).click();
  await card(page).getByRole("button", { name: "Close conversation" }).press("Escape");
  await expect(panel(page)).toBeHidden();
  expect((await listed(review, ref, "threads")).items[0].thread.status).toBe("open");
});

test("another explicit target cannot steal a nonempty new-message draft, including failed Save", async ({ page, review }) => {
  const { frame, ref } = await setup(page, review, "retarget-draft.html");
  await begin(page, frame); await draft(page).fill("Keep original owner");
  await close(page);
  await page.getByRole("button", { name: "Keep editing" }).click();
  await feedback(page);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await selectText(frame, "#other"); await frame.locator("#commentAction").click();
  await feedback(page);
  await expect(draft(page)).toHaveValue("Keep original owner");
  await expect(page.locator(".conversation-new-target")).toContainText("First paragraph");
  await intercept(page, "create-thread", (route) => failure(route, "Retain draft", "VERSION_CONFLICT"));
  await draft(page).press("Enter");
  await expect(page.getByRole("alert")).toContainText("Retain draft");
  expect((await listed(review, ref, "threads")).items).toHaveLength(0);
  await expect(draft(page)).toHaveValue("Keep original owner");
});

test("empty new composition may retarget explicitly without inventing a saved message", async ({ page, review }) => {
  const { frame, ref } = await setup(page, review, "retarget-empty.html");
  await begin(page, frame); await close(page);
  await selectText(frame, "#other"); await frame.locator("#commentAction").click();
  await expect(page.locator(".conversation-new-target")).toContainText("Second paragraph");
  await compose(page, "Second target");
  expect((await listed(review, ref, "threads")).items[0].thread.target.anchor.quote).toBe("Second paragraph to review.");
});

for (const action of ["save", "edit"]) test(`${action} retains editable input and selection while one logical acceptance is in flight`, async ({ page, review }) => {
  const { frame, ref } = await setup(page, review, `flight-${action}.html`);
  await begin(page, frame);
  if (action === "edit") { await compose(page, "Before"); await feedback(page); await card(page).getByRole("button", { name: "Edit message" }).click(); }
  const input = action === "save" ? draft(page) : page.getByRole("textbox", { name: "Edit message" });
  let release, requests = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  await intercept(page, action === "save" ? "create-thread" : "update-message", async (route) => { requests++; const response = await route.fetch(); await gate; await route.fulfill({ response }); });
  await input.fill("Accepted body"); await input.press("Enter"); await input.press("Enter");
  await expect.poll(() => requests).toBe(1);
  await input.fill("Newer typing");
  await input.evaluate((element) => { window.savedComposer = element; element.setSelectionRange(2, 7); element.dispatchEvent(new Event("select", { bubbles: true })); });
  await page.locator("#theme").click(); release();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  expect(await input.evaluate((element) => element === window.savedComposer)).toBe(true);
  expect(await input.evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual([2, 7]);
  await expect(input).toHaveValue("Newer typing");
  expect((await listed(review, ref, "threads")).items).toHaveLength(1);
});

for (const [width, height] of [[320, 480], [600, 700], [900, 300], [1440, 400]]) test(`one reachable composer without source overlay at ${width}x${height}`, async ({ page, review }) => {
  await page.setViewportSize({ width, height });
  const { frame } = await setup(page, review, `composer-${width}-${height}.html`);
  await begin(page, frame); await draft(page).fill("Preserved text");
  await expect(page.getByRole("textbox", { name: "New message", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Save", exact: true }).scrollIntoViewIfNeeded();
  const box = await page.getByRole("button", { name: "Save", exact: true }).boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await draft(page).press("Escape");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(draft(page)).toHaveCount(0);
});

test("saved correction remains immutable on handling; a newer pending follow-up and both anchors survive", async ({ page, review }) => {
  const { frame, ref } = await setup(page, review, "immutable-correction.html");
  await selectionMessage(page, frame, "#copy", "Original message");
  await card(page).getByRole("button", { name: "Edit message" }).click();
  await page.getByRole("textbox", { name: "Edit message" }).fill("Corrected before Send");
  await page.getByRole("textbox", { name: "Edit message" }).press("Enter");
  await page.locator("#send").click(); await expect(page.getByText("Queued; not received", { exact: true })).toBeVisible();
  await card(page).getByRole("button", { name: "Reply", exact: true }).click();
  await page.getByRole("textbox", { name: "Reply", exact: true }).fill("Next round"); await page.getByRole("button", { name: "Save", exact: true }).click();
  await handled(review, ref);
  await expect(card(page)).toContainText("Corrected before Send");
  await expect(card(page)).toContainText("Next round");
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(1);
  await expect(card(page).getByRole("button", { name: "Edit message" })).toHaveCount(1);
  expect((await conversation(review, ref, "status")).pendingMessageCount).toBe(1);
});

test("multiple same-block conversations preserve authored dark styles and expose a keyboard chooser", async ({ page, review }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
  const source = fs.readFileSync("spec.html", "utf8");
  const { file, frame, ref } = await setup(page, review, "dark-spec.html", source);
  const authored = await frame.locator("body").innerHTML();
  for (const text of ["First block feedback", "Second block feedback"]) {
    await frame.locator("h1.title").hover();
    await expect.poll(async () => {
      const target = await frame.locator("h1.title").boundingBox(), outline = await frame.locator("#outline").boundingBox();
      return outline && { top: outline.y - target.y, left: outline.x - target.x };
    }).toEqual({ top: -2, left: -2 });
    await frame.locator("#commentAction").click();
    await compose(page, text); await close(page);
  }
  const targets = (await listed(review, ref, "threads")).items.map(item => item.thread.target);
  expect(targets).toHaveLength(2);
  expect(targets[1]).toEqual(targets[0]);
  const badge = frame.getByRole("button", { name: "Open 2 conversations", exact: true });
  await expect(badge).toBeVisible();
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
    await expect(frame.locator("[data-eh-ui]")).toHaveAttribute("data-review-theme", theme);
    await expect(frame.locator("body")).toHaveCSS("background-color", "rgb(23, 23, 15)");
    expect(await frame.locator("body").innerHTML()).toBe(authored);
    await badge.focus(); await badge.press("Enter");
    const chooser = page.getByRole("combobox", { name: "Conversation at this target" });
    await expect(chooser).toBeVisible();
    const values = await chooser.locator("option").evaluateAll((nodes) => nodes.map((node) => node.value));
    await chooser.selectOption(values[1]);
    await expect(panel(page)).toContainText("Second block feedback");
    await page.screenshot({ path: testInfo.outputPath(`block-conversations-${theme}.png`), animations: "disabled" });
    await panel(page).getByRole("button", { name: "Close conversation" }).click();
  }
  expect(fs.readFileSync(file, "utf8")).toBe(source);
  await page.reload(); await waitForSdk(page);
  await expect(page.frameLocator("#frame").getByRole("button", { name: "Open 2 conversations", exact: true })).toBeVisible();
});

test("Markdown direct changes stay source-pending through View and immutable completion", async ({ page, review }) => {
  const source = "# Markdown\n\nOriginal paragraph.\n";
  const { file, ref, frame } = await setup(page, review, "markdown-mode.md", source);
  await enterEditMode(page); await frame.locator("p").click(); await selectText(frame, "p"); await page.keyboard.insertText("Exact preview wording");
  await expect.poll(async () => (await listed(review, ref, "edits")).items.length).toBe(1);
  await selectReviewMode(page, "View");
  expect(fs.readFileSync(file, "utf8")).toBe(source);
  await feedback(page); await page.locator("#send").click();
  await expect(page.getByText("Queued; not received", { exact: true })).toBeVisible();
  const { work } = await handled(review, ref);
  expect(work.edits[0].content.after).toBe("Exact preview wording");
  await expect(page.getByRole("region", { name: "Latest submission result" })).toBeVisible();
  await page.locator(".conversation-submission").first().locator(":scope > summary").click();
  await expect(page.getByText(/deferred: Preserved/)).toBeVisible();
  expect(fs.readFileSync(file, "utf8")).toBe(source);
});

test("comment action keeps its paragraph owner across a real pointer approach", async ({ page, review }) => {
  const file = writeFile(review, "comment-approach.html", `<!doctype html>
    <style>body { margin:40px; font:18px/1.5 Arial } main { width:650px; padding:30px }
      p { width:360px; margin:20px 0 }</style>
    <main id="container"><p id="copy">Alpha beta gamma paragraph with several words to select.</p>
      <p>Another paragraph below the first.</p></main>`);
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await page.evaluate(() => {
    window.commentTargets = [];
    window.addEventListener("message", (event) => {
      if (event.data?.type === "eh:target") window.commentTargets.push(event.data);
    });
  });
  await frame.locator("#copy").hover({ position: { x: 100, y: 12 } });
  const action = frame.locator("#commentAction");
  await expect(action).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.commentTargets.at(-1)?.anchor.selector)).toBe("#copy");
  const generation = await page.evaluate(() => window.commentTargets.at(-1).targetGeneration);
  const original = await action.boundingBox();
  await page.mouse.move(original.x + 15, original.y + 15, { steps: 30 });
  await expect(action).toBeVisible();
  expect(await action.boundingBox()).toEqual(original);
  expect(await page.evaluate(() => window.commentTargets.at(-1).targetGeneration)).toBe(generation);
  await action.click();
  await expect(page.locator(".conversation-new-target")).toHaveAttribute("data-new-target-kind", "element");
  await expect(page.locator(".conversation-new-target")).toContainText("Alpha");
  await page.keyboard.press("Escape");
  await close(page);

  await frame.locator("#copy").hover({ position: { x: 100, y: 12 } });
  await expect(action).toBeVisible();
  const container = await frame.locator("#container").boundingBox();
  const copy = await frame.locator("#copy").boundingBox();
  await page.mouse.move(copy.x + copy.width + 3, copy.y + 10, { steps: 20 });
  await page.mouse.move(container.x + container.width - 5, copy.y + 10, { steps: 20 });
  await expect.poll(() => page.evaluate(() => window.commentTargets.at(-1)?.anchor.selector)).toBe("#container");
});

test("native word and paragraph selections comment in View and Edit", async ({ page, review }) => {
  for (const mode of ["view", "edit"]) {
    const file = writeFile(review, `native-selection-${mode}.html`, `<!doctype html>
      <style>body { margin:40px; font:18px/1.5 Arial } p { width:360px }</style>
      <p id="copy">Alpha beta gamma paragraph with several words to select.</p>
      <p id="next">Next paragraph must not be included.</p>`);
    await openReview(page, review, file);
    const frame = mode === "edit" ? await enterEditMode(page) : await waitForSdk(page);
    await frame.locator("#copy").dblclick({ position: { x: 15, y: 12 } });
    await expect(frame.locator("#commentAction")).toBeVisible();
    await frame.locator("#commentAction").click();
    await expect(page.locator(".conversation-new-target")).toHaveAttribute("data-new-target-kind", "selection");
    await expect(page.locator(".conversation-new-target")).toHaveText("Alpha");
    await page.keyboard.press("Escape");
    await close(page);

    await frame.locator("#copy").click({ clickCount: 3, position: { x: 15, y: 12 } });
    await expect(frame.locator("#commentAction")).toBeVisible();
    await frame.locator("#copy").press("Control+Alt+m");
    await expect(page.locator(".conversation-new-target")).toHaveAttribute("data-new-target-kind", "selection");
    await expect(page.locator(".conversation-new-target")).toHaveText("Alpha beta gamma paragraph with several words to select.");
    await page.getByRole("textbox", { name: "New message", exact: true }).fill(`Native paragraph in ${mode}`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.locator("#copy mark[data-eh-mark]")).toHaveText("Alpha beta gamma paragraph with several words to select.");
    await expect(frame.locator("#next mark[data-eh-mark]")).toHaveCount(0);
  }
});

test("equivalent selection events keep one generation and collapse restores the element action", async ({ page, review }) => {
  const file = writeFile(review, "selection-generation.html", `<!doctype html>
    <style>body { margin:40px; font:18px/1.5 Arial } p { width:360px }</style>
    <p id="copy">Alpha <strong>bold words</strong> and ending.</p><p>Another paragraph.</p>`);
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await page.evaluate(() => {
    window.selectionGenerations = [];
    window.addEventListener("message", (event) => {
      if (event.data?.type === "eh:target" && event.data.kind === "selection") {
        window.selectionGenerations.push(event.data.targetGeneration);
      }
    });
  });
  await frame.locator("#copy").hover();
  await frame.locator("#copy").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await expect(frame.locator("#commentAction")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.selectionGenerations.length)).toBeGreaterThan(0);
  const generation = await page.evaluate(() => window.selectionGenerations.at(-1));
  await frame.locator("#copy").evaluate(async (element) => {
    const selection = document.getSelection();
    selection.setBaseAndExtent(element.lastChild, element.lastChild.length, element.firstChild, 0);
    document.dispatchEvent(new Event("selectionchange"));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  await expect(frame.locator("#commentAction")).toBeVisible();
  await frame.locator("#commentAction").click();
  await expect(page.locator(".conversation-new-target")).toHaveText("Alpha bold words and ending.");
  expect(await page.evaluate(() => [...new Set(window.selectionGenerations)])).toEqual([generation]);
  await page.keyboard.press("Escape");
  await close(page);

  await frame.locator("#copy").click({ position: { x: 15, y: 12 } });
  await expect(frame.locator("#commentAction")).toBeVisible();
  const copy = await frame.locator("#copy").boundingBox();
  await page.mouse.move(copy.x + 25, copy.y + 12, { steps: 5 });
  await frame.locator("#commentAction").click();
  await expect(page.locator(".conversation-new-target")).toHaveAttribute("data-new-target-kind", "element");
});

test("block overlays follow geometry without covering authored controls or leaking into edits", async ({ page, review }) => {
  const file = writeFile(review, "block-controls.html", `<!doctype html>
    <style>body { margin:60px; font:18px/1.5 Arial } button { width:240px; height:45px }</style>
    <button id="target">Authored action</button><p id="copy">Editable words</p>`);
  const session = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await frame.locator("#target").focus();
  await frame.locator("#target").press("Control+Alt+m");
  await page.getByRole("textbox", { name: "New message", exact: true }).fill("Button feedback");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const badge = frame.locator(".block-badge");
  await expect(badge).toBeVisible();
  await close(page);
  const original = await frame.locator("#target").boundingBox();
  const badgeBox = await badge.boundingBox();
  expect(badgeBox.x + badgeBox.width <= original.x || badgeBox.x >= original.x + original.width ||
    badgeBox.y + badgeBox.height <= original.y || badgeBox.y >= original.y + original.height).toBe(true);
  await frame.locator("#target").evaluate((button) => {
    button.addEventListener("click", () => { button.textContent = "Authored action worked"; });
  });
  await frame.locator("#target").click();
  await expect(frame.locator("#target")).toHaveText("Authored action worked");
  await frame.locator("#target").evaluate((button) => { button.style.marginTop = "80px"; });
  await expect.poll(async () => (await frame.locator(".block-marker").boundingBox()).y).toBe(original.y + 80);
  await enterEditMode(page);
  await frame.locator("#copy").evaluate((element) => {
    element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
    element.textContent = "Human edit";
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await expect.poll(async () => (await listed(review, session, "edits")).items.length).toBeGreaterThan(0);
  const persisted = { edits: (await listed(review, session, "edits")).items };
  expect(JSON.stringify(persisted.edits)).not.toMatch(/block-marker|block-badge|data-eh-el|blockAnnotations/);
  await frame.locator("#target").evaluate((button) => button.remove());
  await expect(badge).toHaveCount(0);
});

test("pointer sweeps wait for dwell while selection, composition, and navigation cancel intent", async ({ page, review }) => {
  const file = writeFile(review, "hover-intent.html", `<!doctype html>
    <style>body { margin:40px; font:18px/1.5 Arial } p { width:360px; margin:40px 0 }</style>
    <p id="one">First candidate paragraph.</p><p id="two">Second candidate paragraph.</p>
    <button id="keyboard">Immediate keyboard target</button>`);
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await frame.locator("#one").evaluate((element) => {
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  await expect(frame.locator("#commentAction")).toBeHidden();
  await frame.locator("#two").hover();
  await expect(frame.locator("#commentAction")).toBeVisible();
  await frame.locator("#commentAction").click();
  await expect(page.locator(".conversation-new-target")).toContainText("Second");
  await page.keyboard.press("Escape");
  await close(page);
  await frame.locator("#one").evaluate((element) => {
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  await page.waitForTimeout(220);
  await expect(frame.locator("#commentAction")).toBeHidden();
  await frame.locator("#one").evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    location.hash = "cancel-hover";
  });
  await page.waitForTimeout(220);
  await expect(frame.locator("#commentAction")).toBeHidden();
  await frame.locator("#keyboard").focus();
  await expect(frame.locator("#commentAction")).toBeVisible();
  await selectText(frame, "#one");
  await frame.locator("#two").hover();
  await page.waitForTimeout(220);
  await frame.locator("#commentAction").click();
  await expect(page.locator(".conversation-new-target")).toHaveAttribute("data-new-target-kind", "selection");
  await expect(page.locator(".conversation-new-target")).toContainText("First candidate");
});

async function observeSdkMessages(page, frame) {
  await page.evaluate(() => {
    window.sdkMessages = [];
    window.addEventListener("message", (event) => {
      if (event.source === document.querySelector("#frame").contentWindow) {
        window.sdkMessages.push({ ...event.data, receivedAt: Date.now() });
      }
    });
  });
  await frame.locator('[role="tab"]').first().focus();
  await expect.poll(() => page.evaluate(() => window.sdkMessages.some((msg) => msg.type === "eh:target"))).toBe(true);
}

async function requestSdkSnapshot(page, requestId, requireStable = false) {
  await page.evaluate(({ requestId, requireStable }) => {
    const channel = window.sdkMessages.find((msg) => msg.type === "eh:target");
    document.querySelector("#frame").contentWindow.postMessage({
      ...channel, type: "eh:captureSnapshot", requestId, requireStable,
    }, "*");
  }, { requestId, requireStable });
}

test("SDK snapshot carries observed view and debounced identity changes retain frame generation", async ({ page, review }) => {
  const file = writeFile(review, "view-signals.html", `<!doctype html>
    <div id="tabs" role="tablist"><button id="a" role="tab" aria-selected="true" aria-controls="pa">Alpha</button>
      <button id="b" role="tab" aria-selected="false" aria-controls="pb">Beta</button></div>
    <section id="pa" role="tabpanel"><p id="copy-a">Alpha content.</p></section>
    <section id="pb" role="tabpanel" hidden><p>Beta content.</p></section>`);
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await observeSdkMessages(page, frame);
  await requestSdkSnapshot(page, "view-before");
  await expect.poll(() => page.evaluate(() => window.sdkMessages.find((msg) => msg.requestId === "view-before")?.view?.tabs[0]?.tabId)).toBe("a");
  await frame.locator("#b").evaluate((tab) => {
    document.querySelector("#a").setAttribute("aria-selected", "false");
    document.querySelector("#pa").hidden = true;
    tab.setAttribute("aria-selected", "true");
    document.querySelector("#pb").hidden = false;
  });
  await expect.poll(() => page.evaluate(() => window.sdkMessages.filter((msg) => msg.type === "eh:viewChanged").length)).toBe(1);
  const changed = await page.evaluate(() => window.sdkMessages.find((msg) => msg.type === "eh:viewChanged"));
  expect(changed.view.tabs[0].tabId).toBe("b");
  const before = await page.evaluate(() => window.sdkMessages.find((msg) => msg.requestId === "view-before"));
  expect(changed.generation).toBe(before.generation);
  await frame.locator("#b").evaluate((tab) => {
    tab.textContent = "Renamed label";
    document.querySelector("#pb").append(document.createElement("p"));
  });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.sdkMessages.filter((msg) => msg.type === "eh:viewChanged").length)).toBe(1);
  await requestSdkSnapshot(page, "view-after");
  await expect.poll(() => page.evaluate(() => window.sdkMessages.find((msg) => msg.requestId === "view-after")?.view?.tabs[0]?.label)).toBe("Renamed label");

  await frame.locator("#b").evaluate(() => {
    const original = window.getComputedStyle;
    let switched = false;
    window.getComputedStyle = function (element, ...args) {
      if (!switched && element.id === "copy-a") {
        switched = true;
        document.querySelector("#a").setAttribute("aria-selected", "false");
        document.querySelector("#b").setAttribute("aria-selected", "true");
        document.querySelector("#pa").hidden = true;
        document.querySelector("#pb").hidden = false;
      }
      return original.call(this, element, ...args);
    };
    document.querySelector("#a").setAttribute("aria-selected", "true");
    document.querySelector("#b").setAttribute("aria-selected", "false");
    document.querySelector("#pa").hidden = false;
    document.querySelector("#pb").hidden = true;
  });
  await requestSdkSnapshot(page, "view-raced");
  await expect.poll(() => page.evaluate(() => window.sdkMessages.find((msg) => msg.requestId === "view-raced")?.error?.code)).toBe("VIEW_CHANGED");
});

test("identical semantic content cannot settle capture while selected tab identity changes", async ({ page, review }) => {
  const file = writeFile(review, "view-stability.html", `<!doctype html>
    <div id="tabs" role="tablist"><button id="a" role="tab" aria-selected="true" aria-controls="panel">Same</button>
      <button id="b" role="tab" aria-selected="false" aria-controls="panel">Same</button></div>
    <section id="panel" role="tabpanel"><p>Unchanged visible content.</p></section>`);
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await observeSdkMessages(page, frame);
  await frame.locator("#a").evaluate(() => {
    let count = 0;
    window.lastViewSwitch = Date.now();
    const timer = setInterval(() => {
      count += 1;
      document.querySelector("#a").setAttribute("aria-selected", String(count % 2 === 0));
      document.querySelector("#b").setAttribute("aria-selected", String(count % 2 !== 0));
      window.lastViewSwitch = Date.now();
      if (count === 8) clearInterval(timer);
    }, 100);
  });
  await requestSdkSnapshot(page, "view-stable", true);
  await expect.poll(() => page.evaluate(() => window.sdkMessages.some((msg) => msg.requestId === "view-stable"))).toBe(true);
  const captured = await page.evaluate(() => window.sdkMessages.find((msg) => msg.requestId === "view-stable"));
  expect(captured.error).toBeUndefined();
  const lastSwitch = await frame.locator("#a").evaluate(() => window.lastViewSwitch);
  expect(captured.capturedAt - lastSwitch).toBeGreaterThanOrEqual(280);
  expect(captured.view.tabs[0].tabId).toBe("a");
});
