import { test, expect, enterEditMode, openReview, waitForSdk, writeFile } from "./helpers.js";

async function connectSdk(page, frame) {
  await page.evaluate(() => {
    window.sdkMessages = [];
    window.addEventListener("message", (event) => {
      if (event.source !== document.querySelector("#frame").contentWindow) return;
      if (event.data?.type === "eh:target") {
        const { capability, generation, pageKey } = event.data;
        window.sdkEnvelope = { capability, generation, pageKey };
      }
      if (["eh:snapshot", "eh:historyJumpResult", "eh:flushed", "eh:edit", "eh:html"].includes(event.data?.type)) {
        window.sdkMessages.push(event.data);
      }
    });
  });
  await frame.locator("#copy").dispatchEvent("mouseover");
  await expect.poll(() => page.evaluate(() => !!window.sdkEnvelope)).toBe(true);
}

async function request(page, payload) {
  await page.evaluate((payload) => {
    document.querySelector("#frame").contentWindow.postMessage({ ...window.sdkEnvelope, ...payload }, "*");
  }, payload);
}

async function response(page, requestId) {
  await expect.poll(() => page.evaluate((id) =>
    window.sdkMessages.some((message) => message.type === "eh:snapshot" && message.requestId === id), requestId
  )).toBe(true);
  return page.evaluate((id) =>
    window.sdkMessages.find((message) => message.type === "eh:snapshot" && message.requestId === id), requestId);
}

test("SDK flush echoes a bounded request ID without changing legacy flush replies", async ({ page, review }) => {
  await openReview(page, review, writeFile(review, "sdk-flush-id.html", '<!doctype html><p id="copy">Flush</p>'));
  const frame = await waitForSdk(page);
  await connectSdk(page, frame);
  await request(page, { type: "eh:flush", requestId: "send-flush-1" });
  await request(page, { type: "eh:flush" });
  await expect.poll(() => page.evaluate(() =>
    window.sdkMessages.filter((message) => message.type === "eh:flushed").length
  )).toBe(2);
  expect(await page.evaluate(() =>
    window.sdkMessages.filter((message) => message.type === "eh:flushed").map((message) => message.requestId ?? null)
  )).toEqual(["send-flush-1", null]);
});

test("SDK captures the current DOM, ignores review UI churn, and preserves selection", async ({ page, review }) => {
  const file = writeFile(review, "sdk-capture.html", `<!doctype html><p id="copy">Original text</p>
    <input type="password" value="private-password"><textarea>private-draft</textarea>`);
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await connectSdk(page, frame);
  const before = await frame.locator("#copy").evaluate((element) => {
    element.textContent = "Actual browser DOM";
    const range = document.createRange();
    range.selectNodeContents(element);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    const hint = document.querySelector("[data-eh-ui]").shadowRoot.querySelector("#hint");
    window.uiChurn = setInterval(() => { hint.textContent = `review-only-${Date.now()}`; }, 20);
    return { html: document.body.innerHTML, selection: document.getSelection().toString() };
  });
  const requestedAt = Date.now();
  await request(page, { type: "eh:captureSnapshot", requestId: "current-dom", requireStable: true });
  const result = await response(page, "current-dom");
  expect(result.error).toBeUndefined();
  expect(Number.isSafeInteger(result.capturedAt)).toBe(true);
  expect(result.capturedAt).toBeGreaterThanOrEqual(requestedAt);
  expect(result.capturedAt).toBeLessThanOrEqual(Date.now());
  expect(result.snapshot.blocks.some((block) => block.text === "Actual browser DOM")).toBe(true);
  expect(JSON.stringify(result.snapshot)).not.toMatch(/private-password|private-draft|review-only|rects|viewport/);
  expect(await frame.locator("body").evaluate(() => {
    clearInterval(window.uiChurn);
    return { html: document.body.innerHTML, selection: document.getSelection().toString() };
  })).toEqual(before);
});

test("SDK capture flushes pending edits before its snapshot without claiming durable save", async ({ page, review }) => {
  const file = writeFile(review, "sdk-capture-edit.html", '<!doctype html><p id="copy">Before</p>');
  await openReview(page, review, file);
  const frame = await enterEditMode(page);
  await connectSdk(page, frame);
  await frame.locator("#copy").evaluate((element) => {
    element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
    element.textContent = "Queued browser edit";
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await request(page, { type: "eh:captureSnapshot", requestId: "pending-edit", requireStable: false });
  const result = await response(page, "pending-edit");
  expect(result.snapshot.blocks.some((block) => block.text === "Queued browser edit")).toBe(true);
  const types = await page.evaluate(() => window.sdkMessages.map((message) => message.type));
  expect(types.indexOf("eh:edit")).toBeGreaterThanOrEqual(0);
  expect(types.indexOf("eh:edit")).toBeLessThan(types.indexOf("eh:snapshot"));
  await expect(frame.locator("body")).toHaveAttribute("contenteditable", "true");
});

test("changing DOM capture fails boundedly and explicit current-state capture remains available", async ({ page, review }) => {
  await openReview(page, review, writeFile(review, "sdk-changing.html", '<!doctype html><p id="copy">Changing</p>'));
  const frame = await waitForSdk(page);
  await connectSdk(page, frame);
  await frame.locator("#copy").evaluate((element) => {
    let tick = 0;
    window.contentChurn = setInterval(() => { element.textContent = `Changing ${++tick}`; }, 25);
  });
  await request(page, { type: "eh:captureSnapshot", requestId: "changing", requireStable: true });
  expect((await response(page, "changing")).error.code).toBe("CAPTURE_UNSTABLE");
  await request(page, { type: "eh:captureSnapshot", requestId: "explicit", requireStable: false });
  const result = await response(page, "explicit");
  expect(result.error).toBeUndefined();
  expect(result.snapshot.blocks.some((block) => block.text.startsWith("Changing "))).toBe(true);
  await frame.locator("body").evaluate(() => clearInterval(window.contentChurn));
});

test("capture validates IDs and rejects concurrent requests and route changes", async ({ page, review }) => {
  await openReview(page, review, writeFile(review, "sdk-capture-validation.html", '<!doctype html><p id="copy">Capture validation</p>'));
  const frame = await waitForSdk(page);
  await connectSdk(page, frame);
  await request(page, { type: "eh:captureSnapshot", requestId: "x".repeat(129), requireStable: true });
  expect((await response(page, null)).error.code).toBe("CAPTURE_INVALID_REQUEST");
  await request(page, { type: "eh:captureSnapshot", requestId: "first", requireStable: true });
  await request(page, { type: "eh:captureSnapshot", requestId: "second", requireStable: true });
  expect((await response(page, "second")).error.code).toBe("CAPTURE_BUSY");
  await frame.locator("body").evaluate(() => { location.hash = "another-route"; });
  expect((await response(page, "first")).error.code).toBe("CAPTURE_NAVIGATED");
});

test("an unready document returns an explicit bounded capture failure", async ({ page, review }) => {
  await openReview(page, review, writeFile(review, "sdk-not-ready.html", '<!doctype html><p id="copy">Not ready</p>'));
  const frame = await waitForSdk(page);
  await connectSdk(page, frame);
  await frame.locator("body").evaluate(() => {
    Object.defineProperty(document, "readyState", { configurable: true, value: "loading" });
  });
  await request(page, { type: "eh:captureSnapshot", requestId: "not-ready", requireStable: true });
  expect((await response(page, "not-ready")).error.code).toBe("CAPTURE_NOT_READY");
  await frame.locator("body").evaluate(() => { delete document.readyState; });
});

test("history jump requires one exact visible semantic target and never approximates", async ({ page, review }) => {
  await openReview(page, review, writeFile(review, "sdk-history-jump.html", `<!doctype html>
    <p id="copy">Top</p><div style="height:1200px"></div>
    <p id="destination">Exact destination</p><p hidden id="hidden">Hidden destination</p>`));
  const frame = await waitForSdk(page);
  await connectSdk(page, frame);
  await request(page, { type: "eh:captureSnapshot", requestId: "jump-target", requireStable: false });
  const snapshot = (await response(page, "jump-target")).snapshot;
  const target = snapshot.blocks.find((block) => block.text === "Exact destination");
  const selector = target.selector;
  await request(page, { type: "eh:historyJump", selector, text: target.text });
  await expect.poll(() => page.evaluate(() =>
    window.sdkMessages.filter((message) => message.type === "eh:historyJumpResult").at(-1)?.success
  )).toBe(true);
  const scroll = await frame.locator("body").evaluate(() => scrollY);
  expect(scroll).toBeGreaterThan(0);
  await page.evaluate(() => { window.sdkMessages = []; });
  await request(page, { type: "eh:historyJump", selector: "#destination", text: target.text });
  await expect.poll(() => page.evaluate(() =>
    window.sdkMessages.find((message) => message.type === "eh:historyJumpResult")?.success
  )).toBe(true);
  for (const payload of [
    { selector, text: "Not the current text" },
    { selector: "p", text: target.text },
    { selector: "#hidden", text: "Hidden destination" },
    { selector: "[", text: target.text },
  ]) {
    await page.evaluate(() => { window.sdkMessages = []; });
    await request(page, { type: "eh:historyJump", ...payload });
    await expect.poll(() => page.evaluate(() =>
      window.sdkMessages.find((message) => message.type === "eh:historyJumpResult")?.reason
    )).toBe("unresolved");
    expect(await frame.locator("body").evaluate(() => scrollY)).toBe(scroll);
  }
});
