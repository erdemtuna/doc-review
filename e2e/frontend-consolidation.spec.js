import { test, expect, openReview, waitForSdk, writeFile, seedThread, feedback, beginComment,
  listed, sendPending, handled, intercept, failure, mutate, enterEditMode, submissionHistory, renderedContrast } from "./helpers.js";
import { selectChoice } from "./choice-helpers.js";

async function naturalTextVisible(locator) {
  return locator.evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    let top = 0, bottom = innerHeight, left = 0, right = innerWidth;
    for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), box = ancestor.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, box.top + ancestor.clientTop);
        bottom = Math.min(bottom, box.top + ancestor.clientTop + ancestor.clientHeight);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, box.left + ancestor.clientLeft);
        right = Math.min(right, box.left + ancestor.clientLeft + ancestor.clientWidth);
      }
    }
    const lines = [...range.getClientRects()].filter(rect => rect.width && rect.height);
    return lines.length > 0 && lines.every(rect => rect.top >= top - .5 && rect.bottom <= bottom + .5 && rect.left >= left - .5 && rect.right <= right + .5);
  });
}
async function semanticInk(locator, token) {
  const color = await locator.evaluate((node, name) => {
    const sample = document.createElement("span"); sample.style.color = `var(--${name})`; node.append(sample);
    const expected = getComputedStyle(sample).color; sample.remove();
    return expected;
  }, token);
  await expect(locator).toHaveCSS("color", color);
  for (const svg of await locator.locator("svg").all()) await expect(svg).toHaveCSS("color", color);
  expect(await renderedContrast(locator)).toBeGreaterThanOrEqual(4.5);
  return color;
}

for (const theme of ["light", "dark"]) for (const [width, height] of [[390, 480], [320, 400]]) {
  for (const kind of ["new", "edit"]) test(`collapsed note exposes excluded ${kind} draft and exact Send membership ${width}x${height} ${theme}`, async ({ page, review }, info) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(value => localStorage.setItem("doc-review:theme", value), theme);
    const ref = await openReview(page, review, writeFile(review, `exclusion-${kind}-${width}-${theme}.html`, "<p id='copy'>A saved passage</p>"));
    await waitForSdk(page);
    const { threadId } = await seedThread(review, ref, "Saved version included in Send");
    const context = await listed(review, ref, "context", { threadId });
    const saved = context.items[0].reviewer;
    await feedback(page);
    let editor;
    if (kind === "new") {
      await beginComment(page);
      editor = page.locator('[data-composer="new"] textarea');
    } else {
      await page.locator(`[data-thread="${threadId}"]`).getByRole("button", { name: "Edit message", exact: true }).click();
      editor = page.getByRole("textbox", { name: "Edit message", exact: true });
    }
    await editor.fill("Unfinished wording must not be sent");
    await expect(page.getByRole("button", { name: /Note to agent/ })).toHaveAttribute("aria-expanded", "false");
    const warning = page.locator("#sendDraftExclusion");
    await expect(warning).toHaveText("1 unfinished draft excluded from Send.");
    expect(await naturalTextVisible(warning)).toBe(true);
    await expect(page.locator("#send")).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`excluded-${kind}-${theme}-${width}.png`) });
    const sent = page.waitForRequest(request => request.url().endsWith("/api/conversation") && request.postDataJSON().operation === "send");
    await page.locator("#send").click();
    const payload = (await sent).postDataJSON();
    expect(payload.messages).toEqual([{ threadId, messageId: saved.messageId, version: saved.version }]);
    expect(payload.edits).toEqual([]);
    expect(payload.pageKeys).toEqual([ref.key]);
    expect(payload).not.toHaveProperty("overallNote");
    expect(JSON.stringify(payload)).not.toContain("Unfinished wording");
    await expect(editor).toHaveValue("Unfinished wording must not be sent");
  });
}

for (const theme of ["light", "dark"]) test(`current comparison owns rich-content and selected-rail styles in ${theme}`, async ({ page, review }, info) => {
  await page.addInitScript(value => localStorage.setItem("doc-review:theme", value), theme);
  const ref = await openReview(page, review, writeFile(review, `rich-${theme}.html`, "<p id='copy'>Live document</p>"));
  await waitForSdk(page); await seedThread(review, ref, "Review rich content");
  await sendPending(review, ref, { body: "Update the rich content", intent: "request-change" });
  await handled(review, ref, { overallOutcome: "applied" });
  const blocks = [
    { tag: "blockquote", text: "Saved quotation" },
    { tag: "hr", text: "" },
    { tag: "p", text: "Marked link", runs: [{ text: "Marked ", marks: ["mark"] }, { text: "link", marks: [], href: "/historical" }] },
    { tag: "td", text: "Real table cell", selector: "body > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(1) > td:nth-of-type(1)" },
  ];
  const rows = blocks.map((block, index) => ({ id: `rich-${index}`, kind: "modified", changeId: `rich-${index}`, beforeBlock: block, afterBlock: block }));
  await page.route("**/api/conversation/comparison", route => route.fulfill({ json: {
    available: true, mode: "content", version: 2, rows, changes: rows.map(row => ({ id: row.id, kind: row.kind, beforeBlock: row.beforeBlock, afterBlock: row.afterBlock })),
    counts: { added: 0, modified: 4, removed: 0 }, limitations: [], viewComparison: { status: "unverified", message: "Fixture saved content" },
  } }));
  await feedback(page); await page.getByRole("button", { name: "View changes", exact: true }).click();
  const host = page.locator(".comparison-host");
  await expect(host.locator("blockquote").first()).toHaveCSS("border-left-width", "3px");
  await expect(host.locator("hr").first()).toHaveCSS("border-top-width", "1px");
  await expect(host.locator(".saved-table td")).toHaveCount(2);
  await expect(host.locator(".saved-table td").first()).toHaveCSS("border-top-width", "1px");
  await semanticInk(host.locator("mark").first(), "review-modified-foreground");
  await semanticInk(host.locator(".saved-link").first(), "primary");
  await expect(host.locator(".saved-link").first()).toHaveCSS("text-decoration-line", "underline");
  await expect(host.locator(".comparison-current > .comparison-before")).toHaveCSS("box-shadow", /inset/);
  await expect(host.locator("a, script, img, iframe")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`rich-comparison-${theme}.png`), fullPage: true });
});

for (const theme of ["light", "dark"]) test(`neutral recovery, keyboard hints and authoritative confirmation in ${theme}`, async ({ page, review }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(value => localStorage.setItem("doc-review:theme", value), theme);
  const ref = await openReview(page, review, writeFile(review, `recovery-${theme}.html`, "<p id='copy'>Review this passage</p>"));
  await waitForSdk(page);
  await mutate(review, ref, "create-thread", { pageKey: ref.key, target: { kind: "element", anchor: { selector: "#copy", label: "Passage" } }, body: "Explicit permission", intent: "request-change" });
  await feedback(page);
  for (const [role, name, hint] of [
    ["img", "Change requested", "Change requested"],
    ["button", "Show in document", "Show the exact passage"],
    ["button", "Edit message", "Edit message"],
    ["button", "Conversation actions", "Conversation actions"],
    ["button", "Collapse conversation", "Collapse conversation"],
  ]) {
    const target = page.getByRole(role, { name, exact: true });
    await target.focus();
    await expect(page.getByRole("tooltip", { name: hint, exact: true })).toBeVisible();
    await expect(target).toHaveAccessibleName(name);
    await expect(target).not.toHaveAttribute("title");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Feedback" })).toBeVisible();
  }
  await page.getByRole("button", { name: "Edit message", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit message", exact: true }).fill("Rejected edit stays local");
  await intercept(page, "update-message", route => failure(route, "Ordinary rejected save", "INVALID_INPUT"));
  await page.getByRole("button", { name: "Update comment", exact: true }).click();
  const refresh = page.getByRole("button", { name: "Refresh review", exact: true });
  await expect(refresh).toBeVisible();
  const color = await semanticInk(refresh, "foreground");
  const feedbackStyle = await refresh.evaluate(node => { const c = getComputedStyle(node); return [c.color, c.backgroundColor, c.height, c.borderColor]; });
  await page.getByRole("button", { name: "Close feedback", exact: true }).click();
  await expect(refresh).toBeVisible();
  await expect(refresh).toHaveCSS("color", color);
  expect(await refresh.evaluate(node => { const c = getComputedStyle(node); return [c.color, c.backgroundColor, c.height, c.borderColor]; })).toEqual(feedbackStyle);
  await feedback(page);
  await intercept(page, "end", route => failure(route, "End rejected", "INVALID_INPUT"));
  await page.locator("#endReview").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("heading")).toHaveText("End shared review?");
  const confirm = dialog.getByRole("button", { name: "End review", exact: true });
  await expect(confirm).toHaveAttribute("data-variant", "destructive");
  await semanticInk(confirm, "destructive");
  await confirm.click();
  await expect(dialog).toBeVisible(); await expect(confirm).toBeEnabled();
  await page.screenshot({ path: info.outputPath(`confirmation-${theme}.png`) });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

for (const theme of ["light", "dark"]) test(`Revert and visible History Abandon retain destructive ink through hover and focus in ${theme}`, async ({ page, review }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(value => localStorage.setItem("doc-review:theme", value), theme);
  const ref = await openReview(page, review, writeFile(review, `danger-${theme}.html`, "<p id='copy'>Original passage</p>"));
  const frame = await enterEditMode(page);
  await frame.locator("#copy").click(); await page.keyboard.press("End"); await page.keyboard.insertText(" revised");
  await feedback(page);
  const revert = page.getByRole("button", { name: "Revert", exact: true });
  await expect(revert).toBeEnabled();
  for (const state of ["rest", "hover", "focus"]) {
    if (state === "hover") await revert.hover();
    if (state === "focus") { await page.mouse.move(0, 0); await revert.focus(); }
    await semanticInk(revert, "destructive");
  }
  await page.locator("#send").click(); await submissionHistory(page);
  const abandon = page.getByRole("button", { name: "Abandon", exact: true });
  await expect(abandon).toBeVisible();
  for (const state of ["rest", "hover", "focus"]) {
    if (state === "hover") await abandon.hover();
    if (state === "focus") { await page.mouse.move(0, 0); await abandon.focus(); }
    await semanticInk(abandon, "destructive");
  }
  await page.screenshot({ path: info.outputPath(`abandon-${theme}.png`) });
});

test("SDK capability permits discussion during outstanding work but forbids creation after End across reload and page changes", async ({ page, review }) => {
  await page.addInitScript(() => {
    window.configurations = [];
    window.addEventListener("message", event => { if (event.data?.type === "eh:configurationApplied") window.configurations.push(event.data); });
  });
  const ref = await openReview(page, review, writeFile(review, "capability.html", "<p id='copy'>Discuss this passage</p>"));
  const other = await mutate(review, ref, "join-page", { target: writeFile(review, "capability-other.html", "<p>Another page</p>") });
  await waitForSdk(page); await seedThread(review, ref, "Existing readable conversation");
  await sendPending(review, ref);
  await expect.poll(() => page.evaluate(() => configurations.at(-1)?.canComment)).toBe(true);
  await beginComment(page);
  await expect(page.locator('[data-composer="new"]')).toBeVisible();
  await page.getByRole("button", { name: "Close comment", exact: true }).click();
  await mutate(review, ref, "end", { confirmUnsentReadOnly: true });
  await expect.poll(() => page.evaluate(() => configurations.at(-1)?.canComment)).toBe(false);
  async function cannotCreate() {
    await waitForSdk(page);
    const frame = page.frameLocator("#frame");
    const action = frame.locator("#commentAction");
    await frame.locator("p").first().hover();
    await expect(action).toBeHidden(); await expect(action).toBeDisabled();
    await frame.locator("p").first().click();
    await frame.locator("p").first().evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.keyboard.press("Control+Alt+m");
    await expect(action).toBeHidden();
    await expect(page.locator('[data-composer="new"]')).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Close feedback", exact: true }).click();
  await cannotCreate();
  await page.reload(); await cannotCreate();
  await selectChoice(page, "reviewPage", other.value.pageKey); await cannotCreate();
  await selectChoice(page, "reviewPage", ref.key); await cannotCreate();
  await page.frameLocator("#frame").getByRole("button", { name: "Open conversation", exact: true }).click();
  await expect(page.getByText("Existing readable conversation", { exact: true })).toBeVisible();
});
