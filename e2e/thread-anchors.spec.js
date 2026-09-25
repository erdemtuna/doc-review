import { test, expect, openReview, waitForSdk, writeFile, seedThread } from "./helpers.js";
import { validateFrameAnchorStates, validateFrameThreadAction } from "../lib/contracts/frame.js";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error(error.stack));
  page.on("console", (message) => { if (message.type() === "error") console.error(message.text()); });
  await page.addInitScript(() => {
    if (window !== window.top) return;
    window.anchorMessages = [];
    window.addEventListener("message", ({ source, data }) => {
      if (source !== document.querySelector("#frame")?.contentWindow) return;
      if (["eh:threadAnchorStates", "eh:threadAction"].includes(data?.type)) window.anchorMessages.push(data);
    });
  });
});

async function send(page, message) {
  await page.evaluate((message) => document.querySelector("#frame").contentWindow.postMessage(message, "*"), message);
}
const logicalIds = new WeakMap();
async function project(page, review, ref, anchors) {
  const names = new Map(), actual = [];
  for (const item of anchors) {
    const { threadId } = await seedThread(review, ref, item.threadId, item.target);
    actual.push({ ...item, threadId }); names.set(threadId, item.threadId);
  }
  await expect.poll(() => page.evaluate(() => window.anchorMessages.filter((m) => m.type === "eh:threadAnchorStates").at(-1)?.anchors.length)).toBe(anchors.length);
  const report = await page.evaluate(() => window.anchorMessages.filter((m) => m.type === "eh:threadAnchorStates").at(-1));
  const { anchors: _states, ...scope } = report;
  const projection = { ...scope, type: "eh:threadAnchors", anchors: actual };
  logicalIds.set(projection, names);
  return projection;
}
async function states(page, projection) {
  const report = await page.evaluate(() => window.anchorMessages.filter((m) => m.type === "eh:threadAnchorStates").at(-1));
  return report ? validateFrameAnchorStates(report, projection).anchors.map((state) => ({
    ...state, threadId: logicalIds.get(projection).get(state.threadId),
  })).sort((a, b) => [...logicalIds.get(projection).values()].indexOf(a.threadId) - [...logicalIds.get(projection).values()].indexOf(b.threadId)) : [];
}
const id = (projection, name) => [...logicalIds.get(projection)].find(([, logical]) => logical === name)[0];
const selection = (threadId, quote, context = {}) => ({ threadId, target: { kind: "selection", anchor: { quote, ...context } } });
const element = (threadId, selector) => ({ threadId, target: { kind: "element", anchor: { selector } } });

test("real SDK reports exact, normalized, repeated, hidden, unmeasurable and offscreen targets", async ({ page, review }, testInfo) => {
  const ref = await openReview(page, review, writeFile(review, "thread-states.html", `<!doctype html>
    <p id="copy">Original unique text</p><p>Reformatted
    phrase</p><p>Repeated words</p><p>Repeated words</p>
    <p hidden id="secret">Hidden phrase</p><p id="zero" style="width:0;height:0;overflow:hidden"></p>
    <p class="reused">First</p><p class="reused">Second</p>
    <p id="right" style="position:absolute;left:2500px;top:20px">Right side</p>
    <p id="bottom" style="position:absolute;top:3000px">Below screen</p>`));
  const frame = await waitForSdk(page);
  const projection = await project(page, review, ref, [
    selection("exact", "Original unique text"), selection("normalized", "Reformatted phrase"),
    selection("repeat", "Repeated words"), selection("gone", "Absent phrase"), selection("hidden", "Hidden phrase"),
    element("zero", "#zero"), element("duplicate", ".reused"), element("right", "#right"), element("bottom", "#bottom"),
    element("invalid", "["),
  ]);
  await expect.poll(async () => (await states(page, projection)).map(({ threadId, state, reason, relation }) =>
    [threadId, state, reason || relation || null])).toEqual([
    ["exact", "found", "visible"], ["normalized", "found", "visible"], ["repeat", "ambiguous", null],
    ["gone", "missing", null], ["hidden", "unavailable", "hidden"], ["zero", "unavailable", "not-measurable"],
    ["duplicate", "ambiguous", null], ["right", "found", "right"], ["bottom", "found", "below"],
    ["invalid", "unavailable", "invalid-selector"],
  ]);
  for (const name of ["repeat", "hidden", "gone"]) await expect(frame.locator(`mark[data-eh-mark="${id(projection, name)}"]`)).toHaveCount(0);
  await expect(frame.locator(`mark[data-eh-mark="${id(projection, "exact")}"]`)).toHaveCount(1);
  await testInfo.attach("frame-boundary", {
    body: Buffer.from(JSON.stringify({ projection, states: await states(page, projection) }, null, 2)),
    contentType: "application/json",
  });
  await page.screenshot({ path: testInfo.outputPath("thread-anchor-boundary.png") });
});

test("same-target threads, movement, changed content and reused selectors never retain a false mark", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "thread-movement.html",
    '<!doctype html><p id="copy">Original unique quote</p><div id="block">Original block</div><section id="destination"></section>'));
  const frame = await waitForSdk(page);
  const projection = await project(page, review, ref, [
    selection("one", "Original unique quote"), selection("two", "Original unique quote"), element("block", "#block"),
  ]);
  await expect.poll(async () => (await states(page, projection)).map((s) => s.state)).toEqual(["found", "found", "found"]);
  await frame.locator("#copy").evaluate((node) => document.querySelector("#destination").append(node));
  await expect(frame.locator(`#destination mark[data-eh-mark="${id(projection, "one")}"]`)).toHaveCount(1);
  await frame.locator("#copy").evaluate((node) => {
    node.textContent = "Changed original";
    const replacement = document.createElement("p");
    replacement.id = "replacement"; replacement.textContent = "Original unique quote"; document.body.prepend(replacement);
  });
  await expect(frame.locator(`#replacement mark[data-eh-mark="${id(projection, "one")}"]`)).toHaveCount(1);
  await expect(frame.locator(`#replacement mark[data-eh-mark="${id(projection, "two")}"]`)).toHaveCount(1);
  await frame.locator("#block").evaluate((node) => { node.outerHTML = '<div id="block">Unrelated replacement</div>'; });
  await expect.poll(async () => (await states(page, projection)).find((s) => s.threadId === "block"))
    .toEqual({ threadId: "block", state: "unavailable", reason: "render-changed" });
  await frame.locator("#replacement").evaluate((node) => node.remove());
  await expect.poll(async () => (await states(page, projection)).slice(0, 2).map((s) => s.state)).toEqual(["missing", "missing"]);
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(0);
});

test("typed keyboard actions and geometry reject stale identities without revealing hidden authored controls", async ({ page, review }) => {
  const ref = await openReview(page, review, writeFile(review, "thread-actions.html", `<!doctype html><p id="copy">Keyboard target</p>
    <button aria-controls="secret" onclick="document.querySelector('#secret').hidden=false">Reveal secret</button>
    <p id="secret" hidden>Private target</p>`));
  const frame = await waitForSdk(page);
  const projection = await project(page, review, ref, [selection("one", "Keyboard target"), element("hidden", "#secret")]);
  await expect.poll(async () => (await states(page, projection)).length).toBe(2);
  const { anchors, ...scope } = projection;
  const action = { ...scope, type: "eh:threadAction", action: "activate", threadId: id(projection, "one") };
  const mark = frame.locator(`mark[data-eh-mark="${action.threadId}"]`);
  await mark.evaluate((node) => node.dispatchEvent(new KeyboardEvent("keydown", {
    bubbles: true, key: "Enter", isComposing: true,
  })));
  expect(await page.evaluate(() => window.anchorMessages.filter((m) => m.type === "eh:threadAction").length)).toBe(0);
  await mark.press("Enter");
  await expect.poll(() => page.evaluate(() => window.anchorMessages.filter((m) => m.type === "eh:threadAction").length)).toBe(1);
  expect(validateFrameThreadAction(await page.evaluate(() => window.anchorMessages.find((m) => m.type === "eh:threadAction")), projection))
    .toEqual(action);
  await send(page, action);
  await expect(mark).toHaveClass(/eh-active/);
  await mark.press("Escape");
  await expect(mark).not.toHaveClass(/eh-active/);
  const reportsBefore = await page.evaluate(() => window.anchorMessages.filter((m) => m.type === "eh:threadAnchorStates").length);
  await send(page, { ...action, generation: action.generation + 1 });
  await send(page, { ...action, renderId: "old-render" });
  await send(page, { ...action, reviewId: "foreign-review" });
  await send(page, { ...action, threadId: "foreign-thread" });
  await send(page, { ...action, body: "not allowed" });
  await send(page, { ...scope, type: "eh:activate", id: "one", scroll: true });
  await send(page, { ...scope, type: "eh:anchors", comments: [] });
  await send(page, { ...projection, renderId: "old-render", anchors: [] });
  await send(page, { ...action, action: "reveal", threadId: id(projection, "hidden") });
  await send(page, projection);
  await expect.poll(() => page.evaluate(() => window.anchorMessages.filter((m) => m.type === "eh:threadAnchorStates").length))
    .toBeGreaterThan(reportsBefore);
  await expect(mark).not.toHaveClass(/eh-active/);
  await expect(frame.locator("#secret")).toHaveAttribute("hidden", "");
  await send(page, { ...action, action: "reveal" });
  await expect(mark).toHaveClass(/eh-active/);
  await frame.locator("body").evaluate(() => Object.defineProperty(document, "readyState", { configurable: true, value: "loading" }));
  await expect.poll(async () => (await states(page, projection)).map((s) => s.reason)).toEqual(["render-loading", "render-loading"]);
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(0);
});
