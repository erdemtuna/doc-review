import fs from "node:fs";
import http from "node:http";
import { test, expect, enterEditMode, openReview, reviewApi, waitForSdk, writeFile } from "./helpers.js";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function selectText(frame, selector) {
  await frame.locator(selector).evaluate((element) => {
    const range = document.createRange();
    const node = element.firstChild || element;
    range.setStart(node, 0);
    range.setEnd(node, node.nodeType === Node.TEXT_NODE ? node.nodeValue.length : node.childNodes.length);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

async function pollBatch(review, target) {
  const response = await reviewApi(review, `/api/poll?target=${encodeURIComponent(target)}`);
  expect(response.status, response.raw).toBe(200);
  return response.json();
}

async function acknowledgeBatch(review, target, batchId) {
  const response = await fetch(
    `http://127.0.0.1:${review.port}/api/poll?target=${encodeURIComponent(target)}&ack=${encodeURIComponent(batchId)}`,
    { headers: { "x-human-review-token": review.token } }
  );
  await response.body.cancel();
}

async function addSelectionComment(page, frame, selector, feedback) {
  await selectText(frame, selector);
  await frame.locator("#commentAction").click();
  await page.locator("#composeText").fill(feedback);
  await page.locator("#composeAdd").click();
}

test("View is default and writable HTML switches through Edit back to View", async ({ page, review }) => {
  const file = writeFile(review, "mode.html", "<!doctype html><p id=\"copy\">Original</p>");
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await expect(page.locator("#modeLabel")).toHaveText("View");
  await expect(frame.locator("body")).not.toHaveAttribute("contenteditable", "true");

  await enterEditMode(page);
  await selectText(frame, "#copy");
  await expect(frame.locator("#commentAction")).toBeVisible();
  await frame.locator("#copy").evaluate((element) => {
    element.textContent = "Edited";
    element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await page.locator("#modeButton").click();
  await page.getByRole("menuitemradio", { name: /^View/ }).click();
  await expect(frame.locator("body")).not.toHaveAttribute("contenteditable", "true");
  await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("Edited");
});

test("Markdown Edit is feedback-only and View preserves application interactions", async ({ page, review }) => {
  const markdown = writeFile(review, "notes.md", "# Draft\n\nOriginal");
  await openReview(page, review, markdown);
  let frame = await enterEditMode(page);
  await frame.locator("p").evaluate((element) => {
    element.textContent = "Changed in review";
    element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await page.locator("#modeButton").click();
  await page.getByRole("menuitemradio", { name: /^View/ }).click();
  await expect.poll(() => fs.readFileSync(markdown, "utf8")).toBe("# Draft\n\nOriginal");

  const app = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url.startsWith("/search")) {
      const query = new URL(req.url, "http://localhost").searchParams.get("q");
      res.end(`<!doctype html><p id="searchResult">Search: ${query}</p>`);
      return;
    }
    res.end(`<!doctype html><button id="button" onclick="this.textContent='Worked'">Run</button>
      <details><summary>More</summary><p>Details</p></details>
      <div role="button" tabindex="0" id="tab" onclick="this.dataset.active='yes'">Tab</div>
      <form id="search" action="/search"><input name="q" value="review"><button type="submit">Search</button></form>
      <form id="handled" onsubmit="event.preventDefault(); this.dataset.handled='yes'"><button type="submit">Handle in app</button></form>
      <a id="hash" href="#destination">Jump</a><div style="height:900px"></div><p id="destination">There</p>`);
  });
  const port = await listen(app);
  try {
    const localSession = await openReview(page, review, `http://localhost:${port}/`);
    frame = await waitForSdk(page);
    await frame.locator("#button").focus();
    await expect(frame.locator("#commentAction")).toBeVisible();
    await frame.locator("#button").click();
    await expect(frame.locator("#button")).toHaveText("Worked");
    await frame.locator("#button").press("Control+Alt+m");
    await expect(page.locator("#compose")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect.poll(() => frame.locator("#button").evaluate((element) => document.activeElement === element)).toBe(true);
    await frame.locator("summary").click();
    await expect(frame.locator("details")).toHaveAttribute("open", "");
    await frame.locator("#tab").click();
    await expect(frame.locator("#tab")).toHaveAttribute("data-active", "yes");
    await frame.locator("#handled button").click();
    await expect(frame.locator("#handled")).toHaveAttribute("data-handled", "yes");
    await frame.locator("#hash").click();
    await expect.poll(() => frame.locator("html").evaluate(() => location.hash)).toBe("#destination");
    await enterEditMode(page);
    await frame.locator("#tab").evaluate((element) => {
      element.textContent = "Edited tab";
      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    });
    await expect.poll(async () => {
      const response = await reviewApi(review, `/api/page/${localSession.key}`);
      return response.json().edits.length;
    }).toBeGreaterThan(0);
    await page.locator("#modeButton").click();
    await page.getByRole("menuitemradio", { name: /^View/ }).click();
    await frame.locator("#search button").click();
    await waitForSdk(page);
    frame = page.frameLocator("#frame");
    await expect(frame.locator("#searchResult")).toHaveText("Search: review");
  } finally {
    app.close();
  }
});

test("selection comments use explicit action, keyboard shortcut, aligned card, and shared drawer", async ({ page, review }) => {
  const file = writeFile(review, "comments.html", "<!doctype html><main><p id=\"first\">First selected sentence.</p><p id=\"second\">Second sentence.</p></main>");
  const session = await openReview(page, review, file);
  const frame = await waitForSdk(page);

  await selectText(frame, "#first");
  await expect(frame.locator("#commentAction")).toBeVisible();
  await expect(page.locator("#compose")).toBeHidden();
  await frame.locator("#commentAction").click();
  await expect(page.locator("#compose")).toBeVisible();
  await expect(page.locator("#composeQuote")).toContainText("First selected");
  await page.locator("#composeText").fill("Make this clearer.");
  await page.locator("#composeAdd").click();
  await expect(page.locator("#toolbarCount")).toHaveText("1");
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(1);
  await expect(frame.locator("mark.eh-active")).toHaveCount(0);
  await expect(page.locator("#alignedCard")).toBeHidden();

  await page.locator("#commentsButton").click();
  await expect(page.locator("#commentsButton")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#drawer")).toHaveClass(/open/);
  await expect(page.locator("#commentsSection")).toBeFocused();
  await expect(page.locator("#alignedCard")).toBeHidden();
  await expect(frame.locator("mark.eh-active")).toHaveCount(0);
  await expect(page.locator("#cards").getByRole("button", { name: "Jump to" })).toBeVisible();
  await expect(page.locator("#cards").getByRole("button", { name: "Edit comment" })).toBeVisible();
  await expect(page.locator("#cards").getByRole("button", { name: "More" })).toBeVisible();
  await expect(page.locator("#cards").getByRole("button", { name: "Delete" })).toHaveCount(0);
  await page.locator("#drawerClose").click();
  await expect(page.locator("#commentsButton")).toBeFocused();
  await expect(page.locator("#commentsButton")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#alignedCard")).toBeHidden();
  await frame.locator("mark[data-eh-mark]").click();
  await expect(page.locator("#alignedCard")).toBeVisible();
  await expect(page.locator("#alignedCard").getByRole("button", { name: "Edit comment" })).toBeVisible();
  await expect(page.locator("#alignedCard").getByRole("button", { name: "Close comment card" })).toBeVisible();
  await expect(page.locator("#alignedCard").getByRole("button", { name: "More" })).toBeVisible();
  await expect(page.locator("#alignedCard").getByRole("button", { name: "Delete" })).toHaveCount(0);

  await selectText(frame, "#second");
  await frame.locator("body").dispatchEvent("keydown", { key: "m", ctrlKey: true, altKey: true });
  await expect(page.locator("#compose")).toBeVisible();
  await expect(page.locator("#composeQuote")).toContainText("Second sentence");
  await expect(page.locator("#alignedCard")).toBeHidden();
  await expect(frame.locator("mark.eh-active")).toHaveCount(0);
  await page.keyboard.press("Escape");

  const persisted = await reviewApi(review, `/api/page/${session.key}`);
  expect(persisted.status).toBe(200);
  expect(JSON.stringify(persisted.json())).not.toMatch(/rects|viewport|targetGeneration|relation|clip|horizontal/);
});

test("submission restores exact element focus and stays closed through drawer rerenders", async ({ page, review }) => {
  const file = writeFile(review, "closed-focus.html", "<!doctype html><button id=\"target\">Focusable target</button>");
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await frame.locator("#target").focus();
  await expect(frame.locator("#commentAction")).toBeVisible();
  await frame.locator("#commentAction").click();
  await page.locator("#composeText").fill("Keep this durable but closed");
  await page.locator("#composeAdd").click();

  await expect(page.locator("#compose")).toBeHidden();
  await expect(page.locator("#toolbarCount")).toHaveText("1");
  await expect(frame.locator("#target")).toHaveAttribute("data-eh-el");
  await expect.poll(() => frame.locator("#target").evaluate((element) => document.activeElement === element)).toBe(true);
  await expect(page.locator("#alignedCard")).toBeHidden();

  await page.locator("#commentsButton").click();
  await expect(page.locator("#alignedCard")).toBeHidden();
  await page.locator("#cards").getByRole("button", { name: "Jump to" }).click();
  await page.locator("#drawerClose").click();
  await expect(page.locator("#alignedCard")).toBeVisible();
});

test("More owns focus and ARIA, and delete requires one confirmed request", async ({ page, review }) => {
  const file = writeFile(review, "comment-menu.html", "<!doctype html><p id=\"copy\">Menu target</p>");
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await addSelectionComment(page, frame, "#copy", "Menu feedback");
  await frame.locator("mark[data-eh-mark]").click();

  let deletes = 0;
  page.on("request", (request) => {
    if (request.method() === "DELETE" && request.url().includes("/comment/")) deletes += 1;
  });
  const more = page.locator("#alignedCard").getByRole("button", { name: "More" });
  const menuId = await more.getAttribute("aria-controls");
  await expect(more).toHaveAttribute("aria-haspopup", "menu");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  const menu = page.locator(`#${menuId}`);
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(menu).toHaveAttribute("role", "menu");
  await expect(menu).toHaveAttribute("aria-labelledby", await more.getAttribute("id"));
  await expect(menu.getByRole("menuitem", { name: "Delete" })).toBeFocused();
  expect(deletes).toBe(0);

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  await more.click();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await more.click();
  await page.locator("#frame").click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole("menu")).toHaveCount(0);

  await more.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.locator("#alignedCard")).toContainText("Delete this comment?");
  expect(deletes).toBe(0);
  await page.locator("#alignedCard").getByRole("button", { name: "Cancel" }).click();
  await expect(more).toBeFocused();
  expect(deletes).toBe(0);

  await page.route("**/api/page/*/comment/*", (route) => {
    if (route.request().method() === "DELETE") return route.abort();
    return route.continue();
  });
  await more.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.locator("#alignedCard").getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("#alignedCard")).toContainText("Delete this comment?");
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(1);
  await page.unroute("**/api/page/*/comment/*");

  let releaseDelete;
  const gate = new Promise((resolve) => {
    releaseDelete = resolve;
  });
  await page.route("**/api/page/*/comment/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    await gate;
    await route.continue();
  });
  await page.locator("#alignedCard").getByRole("button", { name: "Delete" }).evaluate((button) => {
    button.click();
    button.click();
  });
  await expect.poll(() => deletes).toBe(2);
  releaseDelete();
  await expect(page.locator("#toolbarCount")).toHaveText("0");
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(0);
  await page.unroute("**/api/page/*/comment/*");
});

test("Escape performs exactly one prioritized comment transition", async ({ page, review }) => {
  const file = writeFile(review, "escape-priority.html", "<!doctype html><p id=\"copy\">Escape target</p>");
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await addSelectionComment(page, frame, "#copy", "Escape feedback");
  await page.locator("#commentsButton").click();
  await page.locator("#cards").getByRole("button", { name: "Jump to" }).click();
  await page.locator("#cards").getByRole("button", { name: "More" }).click();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator("#drawer")).toHaveClass(/open/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#drawer")).not.toHaveClass(/open/);
  await expect(page.locator("#alignedCard")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#alignedCard")).toBeHidden();
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(1);
});

test("another card cannot steal an unsaved edit", async ({ page, review }) => {
  const file = writeFile(review, "edit-owner.html", "<!doctype html><p>Owned edits</p>");
  const session = await openReview(page, review, file);
  const first = (await reviewApi(review, `/api/page/${session.key}/comment`, {
    method: "POST",
    body: { kind: "element", quote: "First quote", anchor: { selector: "p", label: "First" }, feedback: "First comment" },
  })).json().comment;
  const second = (await reviewApi(review, `/api/page/${session.key}/comment`, {
    method: "POST",
    body: { kind: "element", quote: "Second quote", anchor: { selector: "p", label: "Second" }, feedback: "Second comment" },
  })).json().comment;
  await page.reload();
  await waitForSdk(page);
  await page.locator("#commentsButton").click();

  const firstCard = page.locator(`#cards [data-id="${first.id}"]`);
  const secondCard = page.locator(`#cards [data-id="${second.id}"]`);
  await firstCard.getByRole("button", { name: "Edit comment" }).click();
  await firstCard.locator("textarea").fill("Unsaved first draft");
  await expect(secondCard.getByRole("button", { name: "Edit comment" })).toBeDisabled();
  await expect(secondCard.getByRole("button", { name: "More" })).toBeDisabled();
  await secondCard.locator(".body").click();
  await expect(firstCard.locator("textarea")).toHaveValue("Unsaved first draft");
  await expect(page.locator("#cards textarea")).toHaveCount(1);
});

test("closing the drawer moves its edit to the edited comment's aligned card", async ({ page, review }) => {
  const file = writeFile(review, "edit-drawer-owner.html", "<!doctype html><p id=\"one\">First owner</p><p id=\"two\">Second owner</p>");
  const session = await openReview(page, review, file);
  const first = (await reviewApi(review, `/api/page/${session.key}/comment`, {
    method: "POST",
    body: { kind: "selection", quote: "First owner", anchor: { quote: "First owner", selector: "#one" }, feedback: "First active" },
  })).json().comment;
  const second = (await reviewApi(review, `/api/page/${session.key}/comment`, {
    method: "POST",
    body: { kind: "selection", quote: "Second owner", anchor: { quote: "Second owner", selector: "#two" }, feedback: "Second edited" },
  })).json().comment;
  await page.reload();
  const frame = await waitForSdk(page);
  await page.locator("#commentsButton").click();
  await page.locator(`#cards [data-id="${first.id}"]`).click();
  const secondCard = page.locator(`#cards [data-id="${second.id}"]`);
  await secondCard.getByRole("button", { name: "Edit comment" }).click();
  await secondCard.locator("textarea").fill("Draft for second");
  await page.locator("#drawerClose").click();

  await expect(page.locator("#alignedCard")).toContainText("Second owner");
  await expect(page.locator("#alignedCard textarea")).toHaveValue("Draft for second");
  await expect(page.locator("#alignedCard textarea")).toBeFocused();
  await expect(frame.locator("mark.eh-active")).toHaveCount(1);
});

test("nested scrollers update and hide the contextual target", async ({ page, review }) => {
  const file = writeFile(review, "scroller.html", `<!doctype html>
    <div id="scroll" style="height:160px;overflow:auto"><div style="height:300px"></div>
    <button id="target">Comment target</button><div style="height:300px"></div></div>`);
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await frame.locator("#scroll").evaluate((element) => { element.scrollTop = 210; });
  await frame.locator("#target").dispatchEvent("mouseover");
  await expect(frame.locator("#commentAction")).toBeVisible();
  await frame.locator("#scroll").evaluate((element) => { element.scrollTop += 30; });
  await expect(frame.locator("#commentAction")).toBeVisible();
  await frame.locator("#scroll").evaluate((element) => { element.scrollTop = 0; });
  await expect(frame.locator("#commentAction")).toBeHidden();
});

test("draft retarget submits first and a failed submit blocks retargeting", async ({ page, review }) => {
  const file = writeFile(review, "retarget.html", "<!doctype html><p id=\"one\">One target</p><p id=\"two\">Two target</p><p id=\"three\">Three target</p><p id=\"four\">Four target</p>");
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await selectText(frame, "#three");
  await frame.locator("#commentAction").click();
  await page.locator("#composeText").fill("First draft");
  await frame.locator("#two").scrollIntoViewIfNeeded();
  await selectText(frame, "#two");
  await page.locator("#frame").focus();
  await expect(frame.locator("#commentAction")).toBeVisible();
  await frame.locator("#commentAction").click();
  await expect(page.locator("#toolbarCount")).toHaveText("1");
  await expect(page.locator("#composeQuote")).toContainText("Two target");

  await page.locator("#composeText").fill("Second draft");
  await page.route("**/api/page/*/comment", (route) => route.abort());
  await selectText(frame, "#one");
  await page.locator("#frame").focus();
  await frame.locator("#commentAction").click();
  await expect(page.locator("#composeQuote")).toContainText("Two target");
  await expect(page.locator("#composeText")).toHaveValue("Second draft");
  await expect(page.locator("#composeError")).toBeVisible();
  await expect(page.locator("#toolbarCount")).toHaveText("1");
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(1);
  await page.unroute("**/api/page/*/comment");

  await page.locator("#composeCancel").click();
  await selectText(frame, "#four");
  await expect(frame.locator("#commentAction")).toBeVisible();
  await frame.locator("#commentAction").click();
  await expect(page.locator("#composeQuote")).toContainText("Four target");
});

test("retargeting an empty composer preserves the new target", async ({ page, review }) => {
  const file = writeFile(review, "empty-retarget.html", "<!doctype html><p id=\"one\">First target</p><p id=\"two\">Second target</p>");
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await selectText(frame, "#one");
  await frame.locator("#commentAction").click();
  await expect(page.locator("#composeQuote")).toContainText("First target");

  await selectText(frame, "#two");
  await page.locator("#frame").focus();
  await expect(frame.locator("#commentAction")).toBeVisible();
  await frame.locator("#commentAction").click();
  await expect(page.locator("#composeQuote")).toContainText("Second target");
  await page.locator("#composeText").fill("Comment on the second target");
  await page.locator("#composeAdd").click();

  await expect(frame.locator("mark[data-eh-mark]")).toHaveText("Second target");
  await expect(page.locator("#alignedCard")).toBeHidden();
});

test("submitting disables cancellation until the durable comment is committed", async ({ page, review }) => {
  const file = writeFile(review, "submit-cancel-race.html", "<!doctype html><p id=\"copy\">Durable target</p>");
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  let releaseSubmit;
  let submitStarted;
  const started = new Promise((resolve) => {
    submitStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseSubmit = resolve;
  });
  await page.route("**/api/page/*/comment", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submitStarted();
    await gate;
    await route.continue();
  });

  await selectText(frame, "#copy");
  await frame.locator("#commentAction").click();
  await page.locator("#composeText").fill("Cannot cancel midway");
  await page.locator("#composeText").press("Enter");
  await started;
  await expect(page.locator("#composeCancel")).toBeDisabled();
  await expect(page.locator("#composeClose")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.locator("#compose")).toBeVisible();

  releaseSubmit();
  await expect(page.locator("#toolbarCount")).toHaveText("1");
  await expect(page.locator("#alignedCard")).toBeHidden();
  await expect(frame.locator("mark[data-eh-mark]")).toHaveText("Durable target");
  await page.unroute("**/api/page/*/comment");
});

test("Close and Escape deactivate an aligned card without deleting its comment", async ({ page, review }) => {
  const file = writeFile(review, "close-card.html", "<!doctype html><p id=\"copy\">Keep this highlight</p>");
  const session = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  const deletes = [];
  page.on("request", (request) => {
    if (request.method() === "DELETE" && request.url().includes("/comment/")) deletes.push(request.url());
  });

  await selectText(frame, "#copy");
  await frame.locator("#commentAction").click();
  await page.locator("#composeText").fill("A durable comment");
  await page.locator("#composeText").press("Enter");
  await frame.locator("mark[data-eh-mark]").click();
  await expect(page.locator("#alignedCard")).toBeVisible();

  await page.locator("#alignedCard").getByRole("button", { name: "Close comment card" }).click();
  await expect(page.locator("#alignedCard")).toBeHidden();
  await expect(page.locator("#frame")).toBeFocused();
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(1);
  await expect(frame.locator("mark.eh-active")).toHaveCount(0);
  expect(deletes).toHaveLength(0);
  expect((await reviewApi(review, `/api/page/${session.key}`)).json().comments).toHaveLength(1);

  await frame.locator("mark[data-eh-mark]").click();
  await expect(page.locator("#alignedCard")).toBeVisible();
  await page.locator("#alignedCard").getByRole("button", { name: "Close comment card" }).focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#alignedCard")).toBeHidden();
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(1);
  expect(deletes).toHaveLength(0);
});

test("a selection common clipping ancestor controls edge placement", async ({ page, review }) => {
  const file = writeFile(review, "selection-clip.html", `<!doctype html>
    <div style="height:90px"></div>
    <div id="scroll" style="height:180px;width:560px;overflow:auto;border:2px solid">
      <span id="first">First line</span><span id="second"> and second line</span>
      <div style="height:500px"></div>
    </div>`);
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await frame.locator("#scroll").evaluate((scroll) => {
    const range = document.createRange();
    range.setStart(document.querySelector("#first").firstChild, 0);
    const second = document.querySelector("#second").firstChild;
    range.setEnd(second, second.nodeValue.length);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(frame.locator("#commentAction")).toBeVisible();
  await frame.locator("#commentAction").click();
  const scroller = await frame.locator("#scroll").boundingBox();
  await frame.locator("#scroll").evaluate((element) => {
    element.scrollTop = 350;
  });
  await expect(page.locator("#compose")).toHaveClass(/edge-top/);
  const compose = await page.locator("#compose").boundingBox();
  expect(Math.abs(compose.y - (scroller.y + 14))).toBeLessThanOrEqual(5);
});

test("layout shifts reposition an attached composer without scroll or resize", async ({ page, review }) => {
  const file = writeFile(review, "layout-shift.html", `<!doctype html>
    <div id="spacer" style="height:20px"></div><p id="copy">Moving target</p>`);
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await selectText(frame, "#copy");
  await frame.locator("#commentAction").click();
  const before = await page.locator("#compose").boundingBox();
  const targetBefore = await frame.locator("#copy").boundingBox();
  await frame.locator("#spacer").evaluate((element) => {
    element.style.height = "240px";
  });
  await expect.poll(async () => (await frame.locator("#copy").boundingBox()).y).toBeGreaterThan(targetBefore.y + 150);
  await expect.poll(async () => (await page.locator("#compose").boundingBox()).y).toBeGreaterThan(before.y + 10);
});

test("desktop composer pins to nested clipping edges, never sheets, and reveals an element", async ({ page, review }) => {
  const file = writeFile(review, "edge-pin.html", `<!doctype html>
    <div style="height:80px"></div>
    <div id="scroll" style="height:220px;width:620px;overflow:auto;border:2px solid">
      <div style="height:320px"></div><button id="target">Pinned target</button><div style="height:420px"></div>
    </div>`);
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await frame.locator("#scroll").evaluate((element) => { element.scrollTop = 260; });
  await frame.locator("#target").dispatchEvent("mouseover");
  await frame.locator("#commentAction").click();
  await expect(page.locator("#compose")).toBeVisible();
  await page.evaluate(() => {
    window.__composerSheetSeen = document.querySelector("#compose").classList.contains("sheet");
    new MutationObserver(() => {
      if (document.querySelector("#compose").classList.contains("sheet")) window.__composerSheetSeen = true;
    }).observe(document.querySelector("#compose"), { attributes: true, attributeFilter: ["class"] });
  });

  const scroller = await frame.locator("#scroll").boundingBox();
  await frame.locator("#scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(async () => {
    const target = await frame.locator("#target").boundingBox();
    return target.y + target.height < scroller.y;
  }).toBe(true);
  await expect(page.locator("#compose")).toHaveClass(/edge-top/);
  await expect(page.locator("#composeDirectionText")).toHaveText("Selection is above");
  let compose = await page.locator("#compose").boundingBox();
  expect(Math.abs(compose.y - (scroller.y + 14))).toBeLessThanOrEqual(4);

  await frame.locator("#scroll").evaluate((element) => { element.scrollTop = 0; });
  await expect(page.locator("#compose")).toHaveClass(/edge-bottom/);
  await expect(page.locator("#composeDirectionText")).toHaveText("Selection is below");
  compose = await page.locator("#compose").boundingBox();
  expect(Math.abs((compose.y + compose.height) - (scroller.y + scroller.height - 14))).toBeLessThanOrEqual(5);
  expect(await page.evaluate(() => window.__composerSheetSeen)).toBe(false);

  await page.locator("#composeReveal").click();
  await expect(page.locator("#compose")).toHaveClass(/contextual-compose(?!.*edge-)/);
  await expect(frame.locator("#target")).toBeInViewport();
  await expect(page.locator("#composeText")).toHaveValue("");
});

test("Back to selection reveals a nested selection and rejects a stale generation", async ({ page, review }) => {
  const file = writeFile(review, "reveal-selection.html", `<!doctype html>
    <div id="scroll" style="height:180px;overflow:auto">
      <div style="height:280px"></div><p id="one">First selection</p>
      <div style="height:260px"></div><p id="two">Second selection</p><div style="height:260px"></div>
    </div>`);
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await frame.locator("#scroll").evaluate((element) => { element.scrollTop = 240; });
  await selectText(frame, "#one");
  await frame.locator("#commentAction").click();
  await frame.locator("#scroll").evaluate((element) => { element.scrollTop = 600; });
  await expect(page.locator("#compose")).toHaveClass(/edge-top/);
  await page.locator("#composeText").fill("Draft remains");

  await frame.locator("body").evaluate(() => {
    window.__oldReveal = null;
    window.__revealDiagnostics = [];
    const originalInfo = console.info.bind(console);
    console.info = (...args) => {
      if (args[0] === "[human-review-frame]" && args[1]?.event) {
        window.__revealDiagnostics.push(args[1].event);
      }
      originalInfo(...args);
    };
    window.addEventListener("message", (event) => {
      if (event.data?.type === "eh:revealTarget" && !window.__oldReveal) window.__oldReveal = event.data;
    });
  });
  await page.locator("#composeReveal").click();
  await expect(frame.locator("#one")).toBeInViewport();
  await expect(page.locator("#composeText")).toHaveValue("Draft remains");
  expect(await frame.locator("body").evaluate(() => !!window.__oldReveal)).toBe(true);

  await frame.locator("#two").scrollIntoViewIfNeeded();
  await selectText(frame, "#two");
  await page.locator("#frame").focus();
  await frame.locator("#commentAction").click();
  await expect(page.locator("#composeQuote")).toContainText("Second selection");
  await frame.locator("body").evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", {
      source: parent,
      origin: `${location.protocol}//${location.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1"}:${location.port}`,
      data: window.__oldReveal,
    }));
  });
  await expect(page.locator("#composeQuote")).toContainText("Second selection");
  await expect.poll(() => frame.locator("body").evaluate(
    () => window.__revealDiagnostics.includes("reveal-target-failed")
  )).toBe(true);
});

test("Back to selection reports unavailable when clipping cannot reveal the target", async ({ page, review }) => {
  const file = writeFile(review, "reveal-clipped.html", `<!doctype html>
    <div style="height:80px"></div>
    <div id="clip" style="height:120px;overflow:clip;border:2px solid">
      <p id="copy">Clipped target</p>
    </div>`);
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await selectText(frame, "#copy");
  await frame.locator("#commentAction").click();
  await frame.locator("#copy").evaluate((element) => {
    element.style.marginTop = "220px";
  });
  await expect(page.locator("#compose")).toHaveClass(/edge-bottom/);
  await page.locator("#composeReveal").click();
  await expect(page.locator("#liveRegion")).toHaveText("Selection is no longer available");
  await expect(page.locator("#compose")).toHaveClass(/edge-bottom/);
});

test("mode selector is centered and light-dismisses across parent and hostile iframe handlers", async ({ page, review }) => {
  const file = writeFile(review, "menu-dismiss.html", `<!doctype html><button id="hostile">Interact</button>
    <script>
      const button = document.querySelector('#hostile');
      button.addEventListener('pointerdown', event => event.stopPropagation());
      button.addEventListener('focusin', event => event.stopPropagation());
    </script>`);
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await frame.locator("#hostile").evaluate((button) => {
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("focusin", (event) => event.stopPropagation());
  });

  for (const size of [{ width: 1200, height: 700 }, { width: 680, height: 700 }]) {
    await page.setViewportSize(size);
    const mode = await page.locator("#modeButton").boundingBox();
    expect(Math.abs((mode.x + mode.width / 2) - size.width / 2)).toBeLessThanOrEqual(2);
  }
  await page.locator("#modeButton").click();
  await expect(page.getByRole("menuitemradio", { name: "View Editing off, comments enabled" })).toBeVisible();
  await expect(page.getByRole("menuitemradio", { name: "Edit Direct editing on" })).toBeVisible();
  await expect(page.locator("#feedbackButton")).toHaveCount(0);

  await expect(page.locator("#modeButton")).toHaveAttribute("aria-expanded", "true");
  await page.locator("#commentsButton").click();
  await expect(page.locator("#modeMenu")).toBeHidden();
  await expect(page.locator("#modeButton")).toHaveAttribute("aria-expanded", "false");
  await page.locator("#drawerClose").click();

  await page.locator("#modeButton").click();
  await page.locator("#commentsButton").focus();
  await expect(page.locator("#modeMenu")).toBeHidden();
  await page.locator("#modeButton").click();
  await frame.locator("#hostile").click();
  await expect(page.locator("#modeMenu")).toBeHidden();
  await page.locator("#modeButton").click();
  await frame.locator("#hostile").focus();
  await expect(page.locator("#modeMenu")).toBeHidden();

  await page.locator("#commentsButton").click();
  await page.locator("#modeButton").click();
  await page.getByRole("menuitemradio", { name: /^View/ }).focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#modeMenu")).toBeHidden();
  await expect(page.locator("#drawer")).toHaveClass(/open/);
  await page.locator("#drawerClose").click();
});

test("comment Enter handling is IME-safe and single-flight for POST and PATCH", async ({ page, review }) => {
  const file = writeFile(review, "comment-keys.html", "<!doctype html><p id=\"copy\">Keyboard target</p>");
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  let posts = 0;
  let patches = 0;
  let sends = 0;
  page.on("request", (request) => {
    if (request.url().includes("/comment")) {
      if (request.method() === "POST") posts += 1;
      if (request.method() === "PATCH") patches += 1;
    }
    if (request.method() === "POST" && request.url().endsWith("/send")) sends += 1;
  });

  await selectText(frame, "#copy");
  await frame.locator("#commentAction").click();
  await page.locator("#composeText").fill("Line one");
  await page.locator("#composeText").press("Shift+Enter");
  await expect(page.locator("#composeText")).toHaveValue("Line one\n");
  expect(posts).toBe(0);
  await page.locator("#composeText").evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
  });
  expect(posts).toBe(0);

  await page.route("**/api/page/*/comment", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue();
  });
  await page.locator("#composeText").fill("Submit once");
  await page.locator("#composeText").evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await expect(page.locator("#toolbarCount")).toHaveText("1");
  expect(posts).toBe(1);
  expect(sends).toBe(0);
  await page.keyboard.press("Control+Enter");
  expect(sends).toBe(0);
  await page.unroute("**/api/page/*/comment");

  await frame.locator("mark[data-eh-mark]").click();
  await page.locator("#alignedCard").getByRole("button", { name: "Edit comment" }).click();
  await page.locator("#alignedCard textarea").fill("Edited once");
  await page.locator("#alignedCard textarea").evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: false, bubbles: true }));
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
  expect(patches).toBe(0);
  await page.route("**/api/page/*/comment/*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue();
  });
  await page.locator("#alignedCard textarea").evaluate((element) => {
    const save = element.parentElement.querySelector("button.btn-primary");
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    save.click();
  });
  await expect(page.locator("#alignedCard")).toContainText("Edited once");
  expect(patches).toBe(1);
  await page.unroute("**/api/page/*/comment/*");
});

test("editing is explicit and follows geometry plus aligned-drawer switching", async ({ page, review }) => {
  const file = writeFile(review, "edit-state.html", `<!doctype html>
    <div id="spacer" style="height:20px"></div><p id="copy">Geometry edit target</p>`);
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await addSelectionComment(page, frame, "#copy", "Original wording");
  await frame.locator("mark[data-eh-mark]").click();

  let patches = 0;
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().includes("/comment/")) patches += 1;
  });
  await page.locator("#alignedCard").getByRole("button", { name: "Edit comment" }).click();
  await expect(page.locator("#alignedCard").getByRole("button", { name: "Save" })).toBeVisible();
  await expect(page.locator("#alignedCard").getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(page.locator("#alignedCard").getByRole("button", { name: "More" })).toHaveCount(0);
  await expect(page.locator("#alignedCard").getByRole("button", { name: "Close comment card" })).toHaveCount(0);

  await page.locator("#alignedCard textarea").fill("Draft follows the card");
  await page.locator("#frame").focus();
  await page.waitForTimeout(50);
  expect(patches).toBe(0);
  const textarea = page.locator("#alignedCard textarea");
  await textarea.focus();
  await textarea.evaluate((element) => element.setSelectionRange(3, 9));
  const topBefore = (await page.locator("#alignedCard").boundingBox()).y;
  await frame.locator("#spacer").evaluate((element) => {
    element.style.height = "220px";
  });
  await expect.poll(async () => (await page.locator("#alignedCard").boundingBox()).y).toBeGreaterThan(topBefore + 80);
  await expect(textarea).toBeFocused();
  expect(await textarea.evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual([3, 9]);
  await expect(textarea).toHaveValue("Draft follows the card");

  await page.locator("#commentsButton").click();
  const drawerEdit = page.locator("#cards textarea");
  await expect(drawerEdit).toBeFocused();
  await expect(drawerEdit).toHaveValue("Draft follows the card");
  expect(await drawerEdit.evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual([3, 9]);
  await page.locator("#drawerClose").click();
  await expect(page.locator("#alignedCard textarea")).toBeFocused();
  await expect(page.locator("#alignedCard textarea")).toHaveValue("Draft follows the card");

  await page.locator("#alignedCard").getByRole("button", { name: "Cancel" }).click();
  expect(patches).toBe(0);
  await expect(page.locator("#alignedCard")).toContainText("Original wording");
  await page.locator("#alignedCard").getByRole("button", { name: "Edit comment" }).click();
  await page.locator("#alignedCard").getByRole("button", { name: "Save" }).click();
  expect(patches).toBe(0);

  await page.locator("#alignedCard").getByRole("button", { name: "Edit comment" }).click();
  await page.locator("#alignedCard textarea").fill("   ");
  await page.locator("#alignedCard").getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#alignedCard")).toContainText("Comment text is required.");
  await expect(page.locator("#alignedCard textarea")).toBeFocused();
  expect(patches).toBe(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("#alignedCard textarea")).toHaveCount(0);
});

test("middle-truncated quote tails are visibly rendered in every comment surface", async ({ page, review }) => {
  const tail = "FINAL TAIL PHRASE";
  const quote = `BEGIN PHRASE ${"middle content ".repeat(60)}${tail}`;
  const file = writeFile(review, "quote-tail.html", `<!doctype html><p id="copy">${quote}</p>`);
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await selectText(frame, "#copy");
  await frame.locator("#commentAction").click();

  const assertTailVisible = async (locator) => {
    await expect(locator).toContainText("BEGIN PHRASE");
    await expect(locator).toContainText(tail);
    expect(await locator.evaluate((element, finalPhrase) => {
      const style = getComputedStyle(element);
      const text = element.textContent;
      const at = text.lastIndexOf(finalPhrase);
      const range = document.createRange();
      range.setStart(element.firstChild, at);
      range.setEnd(element.firstChild, at + finalPhrase.length);
      const phrase = range.getBoundingClientRect();
      const quoteRect = element.getBoundingClientRect();
      return {
        unclamped: !style.webkitLineClamp || style.webkitLineClamp === "none",
        overflowVisible: style.overflow !== "hidden",
        inside: phrase.top >= quoteRect.top - 1 && phrase.bottom <= quoteRect.bottom + 1,
      };
    }, tail)).toEqual({ unclamped: true, overflowVisible: true, inside: true });
  };

  await assertTailVisible(page.locator("#composeQuote"));
  await page.locator("#composeText").fill("Preserve both ends");
  await page.locator("#composeAdd").click();
  await page.locator("#commentsButton").click();
  await assertTailVisible(page.locator("#cards .quote"));
  await page.locator("#drawerClose").click();
  await frame.locator("mark[data-eh-mark]").click();
  await assertTailVisible(page.locator("#alignedCard .quote"));
});

test("acknowledgement clears idle and in-flight edit or delete state without resurrection", async ({ page, review }) => {
  const file = writeFile(review, "ack-races.html", "<!doctype html><p id=\"copy\">Race target</p>");
  const session = await openReview(page, review, file);
  const frame = await waitForSdk(page);

  const deliverCurrent = async () => {
    await reviewApi(review, `/api/page/${session.key}/send`, {
      method: "POST",
      body: { sessionId: session.sessionId, note: "" },
    });
    return pollBatch(review, file);
  };

  await addSelectionComment(page, frame, "#copy", "Idle edit");
  await frame.locator("mark[data-eh-mark]").click();
  let batch = await deliverCurrent();
  await page.locator("#alignedCard").getByRole("button", { name: "Edit comment" }).click();
  await acknowledgeBatch(review, file, batch.batch_id);
  await expect(page.locator("#toolbarCount")).toHaveText("0");
  await expect(page.locator("textarea[data-comment-edit]")).toHaveCount(0);
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(0);

  await addSelectionComment(page, frame, "#copy", "Patch race");
  await frame.locator("mark[data-eh-mark]").click();
  batch = await deliverCurrent();
  let releasePatch;
  let patchStarted;
  const patchGate = new Promise((resolve) => {
    releasePatch = resolve;
  });
  const patchStart = new Promise((resolve) => {
    patchStarted = resolve;
  });
  await page.route("**/api/page/*/comment/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    patchStarted();
    await patchGate;
    await route.continue();
  });
  await page.locator("#alignedCard").getByRole("button", { name: "Edit comment" }).click();
  await page.locator("#alignedCard textarea").fill("Late patch");
  await page.locator("#alignedCard").getByRole("button", { name: "Save" }).click();
  await patchStart;
  await acknowledgeBatch(review, file, batch.batch_id);
  await expect(page.locator("#toolbarCount")).toHaveText("0");
  releasePatch();
  await page.waitForTimeout(150);
  await expect(page.locator("#toolbarCount")).toHaveText("0");
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(0);
  await page.unroute("**/api/page/*/comment/*");

  await addSelectionComment(page, frame, "#copy", "Confirmation race");
  await frame.locator("mark[data-eh-mark]").click();
  batch = await deliverCurrent();
  await page.locator("#alignedCard").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await acknowledgeBatch(review, file, batch.batch_id);
  await expect(page.locator("#toolbarCount")).toHaveText("0");
  await expect(page.getByText("Delete this comment?")).toHaveCount(0);

  await addSelectionComment(page, frame, "#copy", "Delete race");
  await frame.locator("mark[data-eh-mark]").click();
  batch = await deliverCurrent();
  let releaseDelete;
  let deleteStarted;
  const deleteGate = new Promise((resolve) => {
    releaseDelete = resolve;
  });
  const deleteStart = new Promise((resolve) => {
    deleteStarted = resolve;
  });
  await page.route("**/api/page/*/comment/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    deleteStarted();
    await deleteGate;
    await route.continue();
  });
  await page.locator("#alignedCard").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.locator("#alignedCard").getByRole("button", { name: "Delete" }).click();
  await deleteStart;
  await acknowledgeBatch(review, file, batch.batch_id);
  await expect(page.locator("#toolbarCount")).toHaveText("0");
  releaseDelete();
  await page.waitForTimeout(150);
  await expect(page.locator("#toolbarCount")).toHaveText("0");
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(0);
  await page.unroute("**/api/page/*/comment/*");
});

test("drawer inventory and secondary handoff scroll without moving primary send controls", async ({ page, review }) => {
  await page.setViewportSize({ width: 900, height: 430 });
  const file = writeFile(review, "drawer-layout.html", "<!doctype html><p>Drawer layout</p>");
  const session = await openReview(page, review, file);
  for (let index = 0; index < 18; index += 1) {
    await reviewApi(review, `/api/page/${session.key}/comment`, {
      method: "POST",
      body: {
        kind: "element",
        quote: `Item ${index}`,
        anchor: { selector: "p", label: "Drawer layout" },
        feedback: `Feedback ${index}`,
      },
    });
  }
  await page.reload();
  await waitForSdk(page);
  await page.locator("#commentsButton").click();
  const noteBefore = await page.locator("#note").boundingBox();
  const sendBefore = await page.locator("#send").boundingBox();
  await page.locator("#commentsSection").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect((await page.locator("#note").boundingBox()).y).toBe(noteBefore.y);
  expect((await page.locator("#send").boundingBox()).y).toBe(sendBefore.y);

  await page.locator("#note").fill("Send this batch");
  await page.locator("#send").click();
  await expect(page.locator("#handoff")).toBeVisible();
  const primaryAfterSend = await page.locator("#send").boundingBox();
  const secondaryScrollable = await page.locator(".send-secondary").evaluate(
    (element) => element.scrollHeight > element.clientHeight
  );
  expect(secondaryScrollable).toBe(true);
  await page.locator(".send-secondary").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator("#endReview")).toBeVisible();
  expect((await page.locator("#send").boundingBox()).y).toBe(primaryAfterSend.y);
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth &&
    document.documentElement.scrollHeight <= window.innerHeight
  )).toBe(true);
});

test("feedback-only edit persistence blocks mode changes until retry succeeds", async ({ page, review }) => {
  const markdown = writeFile(review, "durable.md", "# Draft\n\nOriginal");
  const session = await openReview(page, review, markdown);
  const frame = await enterEditMode(page);
  await page.route("**/api/page/*/edit", (route) => route.abort());
  await frame.locator("p").evaluate((element) => {
    element.textContent = "Queued edit";
    element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });

  await page.locator("#modeButton").click();
  await page.getByRole("menuitemradio", { name: /^View/ }).click();
  await expect(page.locator("#modeLabel")).toHaveText("Edit");
  await expect(frame.locator("body")).toHaveAttribute("contenteditable", "true");
  await expect(page.locator(".toast").last()).toContainText("Stay in Edit");

  await page.unroute("**/api/page/*/edit");
  await page.locator("#modeButton").click();
  await page.getByRole("menuitemradio", { name: /^View/ }).click();
  await expect(page.locator("#modeLabel")).toHaveText("View");
  await expect.poll(async () => {
    const response = await reviewApi(review, `/api/page/${session.key}`);
    return response.json().edits.length;
  }).toBeGreaterThan(0);
});

test("correction replacement stays active and acknowledgement removes only shipped anchors", async ({ page, review }) => {
  const file = writeFile(review, "ack-anchors.html", "<!doctype html><p id=\"copy\">Selected sentence</p>");
  const session = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await selectText(frame, "#copy");
  await frame.locator("#commentAction").click();
  await page.locator("#composeText").fill("Original feedback");
  await page.locator("#composeAdd").click();
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(1);
  await frame.locator("mark[data-eh-mark]").click();

  await reviewApi(review, `/api/page/${session.key}/send`, {
    method: "POST",
    body: { sessionId: session.sessionId, note: "" },
  });
  const delivered = await pollBatch(review, file);

  await page.locator("#alignedCard").getByRole("button", { name: "Edit comment" }).click();
  await page.locator("#alignedCard textarea").fill("Corrected feedback");
  await page.locator("#alignedCard textarea").press("Enter");
  await expect(page.locator("#alignedCard")).toContainText("Corrected feedback");
  await expect(frame.locator("mark.eh-active")).toHaveCount(1);

  await acknowledgeBatch(review, file, delivered.batch_id);
  await expect(page.locator("#toolbarCount")).toHaveText("1");
  await expect(page.locator("#alignedCard")).toContainText("Corrected feedback");
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(1);

  await reviewApi(review, `/api/page/${session.key}/send`, {
    method: "POST",
    body: { sessionId: session.sessionId, note: "" },
  });
  const correction = await pollBatch(review, file);
  await acknowledgeBatch(review, file, correction.batch_id);
  await expect(page.locator("#toolbarCount")).toHaveText("0");
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(0);
});

test("a delayed correction exposes only disabled Save and Cancel until it settles", async ({ page, review }) => {
  const file = writeFile(review, "close-correction-race.html", "<!doctype html><p id=\"copy\">Selected sentence</p>");
  const session = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await selectText(frame, "#copy");
  await frame.locator("#commentAction").click();
  await page.locator("#composeText").fill("Original feedback");
  await page.locator("#composeText").press("Enter");
  await frame.locator("mark[data-eh-mark]").click();
  await reviewApi(review, `/api/page/${session.key}/send`, {
    method: "POST",
    body: { sessionId: session.sessionId, note: "" },
  });
  await pollBatch(review, file);

  let releasePatch;
  let patchStarted;
  const started = new Promise((resolve) => {
    patchStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    releasePatch = resolve;
  });
  await page.route("**/api/page/*/comment/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    patchStarted();
    await gate;
    await route.continue();
  });
  await page.locator("#alignedCard").getByRole("button", { name: "Edit comment" }).click();
  await page.locator("#alignedCard textarea").fill("Corrected feedback");
  await page.locator("#alignedCard").getByRole("button", { name: "Save" }).click();
  await started;
  await expect(page.locator("#alignedCard").getByRole("button", { name: "Saving…" })).toBeDisabled();
  await expect(page.locator("#alignedCard").getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(page.locator("#alignedCard").getByRole("button", { name: "Close comment card" })).toHaveCount(0);
  await expect(page.locator("#alignedCard").getByRole("button", { name: "More" })).toHaveCount(0);
  releasePatch();
  await expect(page.locator("#toolbarCount")).toHaveText("1");
  await expect(page.locator("#alignedCard")).toContainText("Corrected feedback");
  await page.locator("#alignedCard").getByRole("button", { name: "Close comment card" }).click();
  await expect(page.locator("#alignedCard")).toBeHidden();
  await expect(frame.locator("mark.eh-active")).toHaveCount(0);
  await page.unroute("**/api/page/*/comment/*");
});

test("a save conflict keeps Edit active when switching to View", async ({ page, review }) => {
  const file = writeFile(review, "conflict.html", "<!doctype html><p id=\"copy\">Original</p>");
  await openReview(page, review, file);
  const frame = await enterEditMode(page);
  await frame.locator("#copy").evaluate((element) => {
    element.textContent = "Unsaved edit";
    element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await page.route("**/api/page/*/save", (route) => route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({ error: "file changed" }),
  }));
  await page.locator("#modeButton").click();
  await page.getByRole("menuitemradio", { name: /^View/ }).click();
  await expect(page.locator("#modeLabel")).toHaveText("Edit");
  await expect(frame.locator("body")).toHaveAttribute("contenteditable", "true");
  await expect(page.locator(".toast")).toContainText("save conflict");
});

test("wide short screens keep desktop composition instead of transient sheets", async ({ page, review }) => {
  await page.setViewportSize({ width: 900, height: 300 });
  const file = writeFile(review, "wide-short.html", "<!doctype html><p id=\"copy\">Wide short selection</p>");
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await selectText(frame, "#copy");
  await frame.locator("#commentAction").click();
  await expect(page.locator("#compose")).toBeVisible();
  await expect(page.locator("#compose")).not.toHaveClass(/sheet/);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
});

test("narrow screens use compact toolbar and bottom-sheet composition", async ({ page, review }) => {
  await page.setViewportSize({ width: 600, height: 700 });
  const file = writeFile(review, "narrow.html", "<!doctype html><p id=\"copy\">Narrow selection</p>");
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await selectText(frame, "#copy");
  await frame.locator("#commentAction").click();
  await expect(page.locator("#compose")).toHaveClass(/sheet/);
  await expect(page.locator("#toolbarCount")).toBeVisible();
  await expect(page.locator(".toolbar-label").first()).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
