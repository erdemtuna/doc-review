import fs from "node:fs";
import { test, expect, openReview, waitForSdk, writeFile, seedThread, feedback, sendPending, handled, mutate, beginComment, conversation, setReviewTheme } from "./helpers.js";
import { threadAction } from "./conversation-actions.js";

test("Feedback and History share Review and Changes navigation styling and stay reachable at every size", async ({ page, review }, info) => {
  test.setTimeout(60_000);
  await openReview(page, review, writeFile(review, "panel-navigation.html", "<p>Review navigation</p>"));
  await waitForSdk(page); await feedback(page);
  const destination = page.getByRole("group", { name: "Feedback destination" });
  const feedbackButton = destination.getByRole("button", { name: "Feedback", exact: true });
  const historyButton = destination.getByRole("button", { name: "History", exact: true });
  const history = page.getByRole("region", { name: "Submission history" });
  await feedbackButton.focus(); await feedbackButton.press("Tab");
  await expect(historyButton).toBeFocused();
  await historyButton.press("Enter"); await historyButton.press("Enter");
  await expect(history).toBeVisible();
  await expect(historyButton).toHaveAttribute("aria-pressed", "true");
  for (const [width, height] of [[1280, 720], [900, 600], [390, 480], [320, 400]]) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await setReviewTheme(page);
      for (const pane of ["Feedback", "History"]) {
        const selected = pane === "Feedback" ? feedbackButton : historyButton;
        const inactive = pane === "Feedback" ? historyButton : feedbackButton;
        await selected.click(); await selected.click();
        await expect(selected).toHaveAttribute("aria-pressed", "true");
        await expect(inactive).toHaveAttribute("aria-pressed", "false");
        await expect(feedbackButton).toBeInViewport(); await expect(historyButton).toBeInViewport();
        if (pane === "Feedback") {
          await expect(history).toBeHidden();
          await expect(page.locator("#send")).toBeInViewport();
        } else await expect(history).toBeVisible();
        await expect.poll(() => page.evaluate(() => {
          const style = (element) => {
            const css = getComputedStyle(element), inset = getComputedStyle(element, "::before");
            return [css.minHeight, css.borderRadius, css.paddingLeft, css.paddingRight, css.color, inset.backgroundColor, inset.borderRadius];
          };
          return JSON.stringify(style(document.querySelector(".conversation-panel-header [aria-pressed='true']"))) ===
            JSON.stringify(style(document.querySelector("#latestVersion")));
        })).toBe(true);
        const bounds = await destination.boundingBox();
        const close = await page.locator(".conversation-panel-header").getByRole("button", { name: "Close feedback", exact: true }).boundingBox();
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(close.x);
        expect(Math.abs(bounds.y - close.y)).toBeLessThan(1);
        await page.screenshot({ path: info.outputPath(`panel-navigation-${pane.toLowerCase()}-${theme}-${width}.png`), animations: "disabled", caret: "initial" });
      }
    }
  }
});

test("compact inline editing preserves one editor across hosts and waiting hides internal bookkeeping", async ({ page, review }, info) => {
  const ref = await openReview(page, review, writeFile(review, "compact-inline.html", "<h1>Review notes</h1><p id='copy'>A clear passage to discuss.</p>"));
  await waitForSdk(page);
  const { threadId } = await seedThread(review, ref, "Original saved comment", {
    kind: "element", anchor: { selector: "#copy", label: "Review notes · p 1" },
  });
  await feedback(page);
  const card = page.locator(`[data-thread="${threadId}"]`);
  await expect(page.getByRole("button", { name: "New message", exact: true })).toHaveCount(0);
  await card.getByRole("button", { name: "Edit message", exact: true }).click();
  const editor = card.getByRole("textbox", { name: "Edit message", exact: true });
  await editor.fill("An inline correction, not a duplicate comment.");
  await editor.evaluate(node => { window.inlineEditor = node; node.setSelectionRange(3, 9); node.dispatchEvent(new Event("select", { bubbles: true })); });
  await editor.dispatchEvent("compositionstart");
  for (const host of ["feedback", "focus", "adjacent"]) {
    if (host !== "feedback") await (await threadAction(page, card, host === "focus" ? "Focus" : "Beside target")).click();
    for (const [width, height] of [[1280, 720], [900, 600]]) {
      await page.setViewportSize({ width, height });
      for (const theme of ["light", "dark"]) {
        if (await page.locator("html").getAttribute("data-theme") !== theme) await setReviewTheme(page);
        await expect(card.locator(".conversation-exchange textarea")).toHaveCount(1);
        await expect(card.locator(".conversation-body")).toHaveCount(0);
        await expect(card.getByText("Original saved comment", { exact: true })).toHaveCount(0);
        expect(await editor.evaluate(node => [node === window.inlineEditor, node.selectionStart, node.selectionEnd])).toEqual([true, 3, 9]);
        await expect(card.getByRole("button", { name: "Update comment", exact: true })).toBeDisabled();
        await expect(card.locator(".conversation-source")).toHaveText("Review notes");
        await expect(card.getByRole("button", { name: host === "adjacent" ? "Open in Feedback" : "Show in document" })).toHaveText("");
        await expect(editor).toBeInViewport();
        await editor.focus();
        expect(await editor.evaluate(node => {
          const style = getComputedStyle(node), box = node.getBoundingClientRect();
          const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
          const clipped = [];
          for (let parent = node.parentElement; parent; parent = parent.parentElement) {
            const css = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
            if (/(auto|scroll|hidden|clip)/.test(css.overflowX) &&
              (box.left - ring < bounds.left + parent.clientLeft - 0.5 ||
                box.right + ring > bounds.left + parent.clientLeft + parent.clientWidth + 0.5)) clipped.push(parent.className);
          }
          return { focused: node.matches(":focus-visible"), ring, clipped };
        })).toEqual({ focused: true, ring: 4, clipped: [] });
        await page.screenshot({ path: info.outputPath(`compact-edit-${host}-${theme}-${width}.png`), caret: "initial" });
      }
    }
  }
  await editor.dispatchEvent("compositionend");
  await card.getByRole("button", { name: "Update comment", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(card.locator(".conversation-body")).toHaveText("An inline correction, not a duplicate comment.");
  await (await threadAction(page, card, "Open in Feedback")).click();
  await card.getByRole("button", { name: "Edit message", exact: true }).click();
  await editor.fill("Discard this correction.");
  await card.getByRole("button", { name: "Close edit" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard", exact: true }).click();
  await expect(card.locator(".conversation-body")).toHaveText("An inline correction, not a duplicate comment.");
  await page.locator("#send").click();
  const lifecycle = page.getByRole("status", { name: "Waiting for agent", exact: true });
  await expect(lifecycle).toHaveAccessibleDescription(/Your feedback is waiting for the agent/);
  await expect(page.locator(".conversation-status")).toBeHidden();
  const blockers = page.locator(".conversation-blockers");
  await expect(blockers).toBeHidden();
  await expect(page.locator("#send")).toBeDisabled();
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await setReviewTheme(page);
    expect(await page.locator(".conversation-panel").innerText()).not.toMatch(/You can keep commenting|Technical details|review_|submission_/);
    await page.screenshot({ path: info.outputPath(`compact-waiting-${theme}.png`), animations: "disabled", caret: "initial" });
  }
  await page.getByRole("button", { name: "History", exact: true }).click();
  const history = page.getByRole("region", { name: "Submission history" });
  await expect(history.locator("pre, code")).toHaveCount(0);
  expect(await history.textContent()).not.toMatch(/You can keep commenting|Technical details|Agent command|Receipt details|Advanced actions|review_|submission_|doc-review poll/);
  await expect(history.getByRole("button", { name: "Abandon", exact: true })).toBeVisible();
  await expect(history.locator("[aria-haspopup='menu']")).toHaveCount(0);
  const submission = history.locator(".conversation-submission");
  await submission.locator("summary").click();
  await expect(submission).not.toHaveAttribute("open");
  await expect(history.getByRole("button", { name: "Abandon", exact: true })).toBeVisible();
  await submission.locator("summary").click();
  await expect(submission).toHaveAttribute("open");
  await expect(history.getByRole("button", { name: "Abandon", exact: true })).toBeVisible();
  for (const [width, height] of [[1280, 720], [720, 480]]) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await setReviewTheme(page);
      await page.screenshot({ path: info.outputPath(`clean-history-${theme}-${width}.png`), animations: "disabled", caret: "initial" });
    }
  }
  await page.getByRole("group", { name: "Feedback destination" }).getByRole("button", { name: "Feedback", exact: true }).click();
  await expect(blockers).toBeHidden();
  expect(await page.locator(".conversation-panel").innerText()).not.toMatch(/You can keep commenting|Technical details|review_|submission_/);
  const work = (await conversation(review, ref, "poll")).submission;
  expect(work.messages[0].message.body).toBe("An inline correction, not a duplicate comment.");
  await expect(lifecycle).toHaveAccessibleDescription(/The agent has your feedback\. Waiting for a response\./);
  await expect(lifecycle).not.toHaveAccessibleDescription(/proof|read receipt|currently working/);
  await expect(blockers).toBeHidden();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(history).toContainText("Waiting for a response");
  await expect(history.getByRole("button", { name: "Abandon", exact: true })).toBeVisible();
});

test("History timeline has connected status icons and visible confirmed abandonment in both themes", async ({ page, review }, info) => {
  const ref = await openReview(page, review, writeFile(review, "timeline.html", "<h1>Review timeline</h1><p>A passage to review.</p>"));
  await waitForSdk(page);
  for (const [body, overallOutcome] of [
    ["Explain the wording.", "answered"],
    ["Refine the wording.", "applied"],
    ["Clarify the scope first.", "clarification-needed"],
  ]) {
    await sendPending(review, ref, { body, intent: "request-change" });
    await handled(review, ref, { overallOutcome, resultNote: body });
  }
  await sendPending(review, ref, { body: "Withdraw this request.", intent: "discuss" });
  await feedback(page);
  await page.getByRole("button", { name: "History", exact: true }).click();
  const history = page.getByRole("region", { name: "Submission history" });
  const abandon = history.getByRole("button", { name: "Abandon", exact: true });
  await abandon.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Stop the old agent");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(abandon).toBeFocused();
  await expect(history.locator("[data-state='queued']")).toHaveCount(1);
  await abandon.click();
  await dialog.getByRole("button", { name: "Abandon submission", exact: true }).click();
  await expect(history.locator("[data-state='abandoned']")).toHaveCount(1);
  await history.locator("[data-state='abandoned'] summary").click();
  await sendPending(review, ref, { body: "The next review request.", intent: "discuss" });
  const timeline = history.getByRole("list", { name: "Review timeline" });
  const entries = timeline.locator(":scope > li");
  await expect(entries).toHaveCount(5);
  await expect(entries.first()).toHaveAttribute("data-state", "queued");
  await expect(entries.nth(1)).toHaveAttribute("data-state", "abandoned");
  await expect(entries.nth(2)).toHaveAttribute("data-tone", "waiting");
  await expect(entries.nth(2)).toContainText("Response needs follow-up");
  await expect(entries.nth(3)).toHaveAttribute("data-tone", "changed");
  await expect(entries.nth(4)).toHaveAttribute("data-tone", "response");
  await expect(timeline.locator("[data-slot='timeline-marker'] svg")).toHaveCount(5);
  await expect(timeline.locator("[aria-haspopup='menu']")).toHaveCount(0);
  await expect(abandon).toHaveCount(1);
  for (const [width, height] of [[1280, 720], [720, 480]]) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await setReviewTheme(page);
      await expect(abandon).toBeInViewport();
      const geometry = await entries.evaluateAll(nodes => nodes.map(node => {
        const marker = node.querySelector("[data-slot='timeline-marker']");
        const bounds = marker.getBoundingClientRect();
        const connector = getComputedStyle(node, "::before");
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
          line: connector.display, lineWidth: connector.borderLeftWidth, color: getComputedStyle(marker).color,
          overflow: node.scrollWidth > node.clientWidth };
      }));
      expect(new Set(geometry.map(item => item.x)).size).toBe(1);
      expect(new Set(geometry.map(item => item.color)).size).toBe(4);
      for (const [index, item] of geometry.entries()) {
        expect(item.width).toBe(24); expect(item.height).toBe(24); expect(item.overflow).toBe(false);
        if (index < geometry.length - 1) {
          expect(item.line).not.toBe("none"); expect(item.lineWidth).toBe("1px");
          expect(geometry[index + 1].y).toBeGreaterThan(item.y + item.height);
        } else expect(item.line).toBe("none");
      }
      await page.screenshot({ path: info.outputPath(`history-timeline-${theme}-${width}.png`), animations: "disabled", caret: "initial" });
    }
  }
  await conversation(review, ref, "poll");
  await expect(entries.first()).toHaveAttribute("data-state", "delivered");
  await expect(entries.first()).toContainText("Waiting for a response");
  await expect(abandon).toBeVisible();
  await entries.nth(3).locator("summary").click();
  await expect(entries.nth(3).getByRole("button", { name: "View changes", exact: true })).toBeVisible();
});

  for (const host of ["feedback", "history", "focus", "adjacent"]) test(`Back restores ${host} locally across failed and late comparison reads`, async ({ page, review }, info) => {
    const ref = await openReview(page, review, writeFile(review, `return-${host}.html`, "<p id='copy'>Keep the document state</p><input aria-label='Authored input'>"));
    const frame = await waitForSdk(page);
    const { threadId } = await seedThread(review, ref, "Explain this paragraph.");
    await sendPending(review, ref, { body: "Change the paragraph.", intent: "request-change" });
    await handled(review, ref, { overallOutcome: "applied" });
    await feedback(page);
    await frame.getByRole("textbox", { name: "Authored input" }).fill("Preserved native input");
    const card = page.locator(`[data-thread="${threadId}"]`);
    await expect(card.locator(".conversation-response")).toBeVisible();
    if (host === "focus" || host === "adjacent") await (await threadAction(page, card, host === "focus" ? "Focus" : "Beside target")).click();
    await card.getByRole("button", { name: "Reply", exact: true }).click();
    const draft = card.getByRole("textbox", { name: "Reply", exact: true, includeHidden: true });
    await draft.fill("Preserve this reply");
    await draft.evaluate(node => { window.returnDraft = node; node.setSelectionRange(2, 7); node.dispatchEvent(new Event("select", { bubbles: true })); });
    let trigger = page.locator("#seeChanges");
    if (host === "feedback") trigger = page.getByRole("region", { name: "Latest submission result" }).getByRole("button", { name: "View changes" });
    if (host === "history") {
      await page.getByRole("button", { name: "History", exact: true }).click();
      await page.locator(".conversation-submission > summary").click();
      trigger = page.getByRole("region", { name: "Submission history" }).getByRole("button", { name: "View changes" });
    }
    const panel = page.locator(".conversation-panel");
    const previousHost = await panel.getAttribute("data-host");
    const inventory = page.locator(".conversation-inventory");
    await trigger.evaluate(node => node.addEventListener("click", () => {
      window.comparisonReturnScroll = document.querySelector(".conversation-inventory").scrollTop;
    }, { once: true }));
    await page.route("**/api/conversation/comparison", route => route.abort("failed"));
    await trigger.click();
    const previousScroll = await page.evaluate(() => window.comparisonReturnScroll);
    const result = page.getByRole("region", { name: "Saved comparison" });
    await expect(result.locator(".changes-controls[role='alert']")).toContainText("Couldn't load the change preview.");
    await page.screenshot({ path: info.outputPath(`failed-${host}.png`) });
    await result.getByRole("button", { name: "Back to review" }).click();
    await expect(panel).toHaveAttribute("data-host", previousHost);
    await expect(trigger).toBeFocused();
    await expect.poll(() => inventory.evaluate(node => node.scrollTop)).toBe(previousScroll);
    expect(await draft.evaluate(node => [node === window.returnDraft, node.value, node.selectionStart, node.selectionEnd]))
      .toEqual([true, "Preserve this reply", 2, 7]);
    await expect(frame.getByRole("textbox")).toHaveValue("Preserved native input");
    await page.unroute("**/api/conversation/comparison");
    let release, requested = false;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/api/conversation/comparison", async route => { requested = true; await gate; await route.continue(); });
    try {
      await trigger.click();
      await expect.poll(() => requested).toBe(true);
      await expect(result).toContainText("Loading saved comparison");
      await result.getByRole("button", { name: "Back to review" }).press("Escape");
      await expect(result).toBeHidden();
      release();
      await expect(trigger).toBeFocused();
      await page.waitForTimeout(250);
      await expect(result).toBeHidden();
      await expect(panel).toHaveAttribute("data-host", previousHost);
    } finally { release(); }
  });

  test("historical replies reveal the exact older exchange even when resolved and filtered out", async ({ page, review }) => {
    const ref = await openReview(page, review, writeFile(review, "older-reply.html", "<p id='copy'>Original target</p>"));
    await waitForSdk(page);
    const { threadId } = await seedThread(review, ref, "Original question");
    for (let index = 0; index < 4; index++) {
      if (index) await mutate(review, ref, "reply", { threadId, body: `Follow-up ${index}`, intent: "discuss" });
      await sendPending(review, ref);
      await handled(review, ref);
    }
    await mutate(review, ref, "set-thread-status", { threadId, status: "resolved" });
    await feedback(page);
    const card = page.locator(`[data-thread="${threadId}"]`);
    const resolvedFilter = page.getByRole("button", { name: "Resolved (1)", exact: true });
    await expect(resolvedFilter).toHaveAttribute("aria-pressed", "false");
    await expect(card).toBeHidden();
    await resolvedFilter.click();
    await expect(card).toBeVisible();
    await expect(card).not.toContainText("Original question");
    await resolvedFilter.click();
    await expect(card).toBeHidden();
    await page.getByRole("button", { name: "History", exact: true }).click();
    const oldest = page.locator(".conversation-submission").last();
    await oldest.locator("summary").first().click();
    await oldest.getByRole("button", { name: "Replies (1)", exact: true }).click();
    await oldest.getByRole("button", { name: /Original question/ }).click();
    await expect(card).toBeVisible();
    const exchange = card.locator(".conversation-exchange").filter({ hasText: "Original question" });
    await expect(exchange).toBeFocused();
    await expect(exchange.locator(".conversation-response")).toBeVisible();
  });
test("coherence evidence covers the reported conversation, composition and result surfaces", async ({ page, review }, info) => {
  test.setTimeout(90_000);
  const ref = await openReview(page, review, writeFile(review, "coherence.html", `<!doctype html>
    <style>body{max-width:780px;margin:56px auto;padding:0 28px;background:#f7f5ed;color:#243b38;font:19px/1.65 Georgia}h1{font-size:44px;line-height:1.2}p{margin:28px 0}</style>
    <h1>Field Notes: less noise, better decisions</h1>
    <p>A shared place for small teams to turn scattered observations into clear next steps.</p>
    <h2 id="purpose" tabindex="0">Why this exists</h2>
    <p id="copy" tabindex="0">Useful customer observations often disappear into meeting notes and chat threads. Keep the evidence beside the decision so the next reader can follow the reasoning.</p>
    <input aria-label="Document input">`));
  await waitForSdk(page);
  const title = await seedThread(review, ref, "wdyt about the title", {
    kind: "selection", anchor: { quote: "exists", prefix: "Why this ", suffix: "", selector: "#purpose" },
  });
  await seedThread(review, ref, "good 2 sentences", {
    kind: "element", anchor: { selector: "#copy", label: "Why this exists · p 2" },
  });
  await sendPending(review, ref);
  await handled(review, ref, { resultNote: "Discussed the selected heading and the two-sentence purpose paragraph. No source changes." });
  await feedback(page);
  const card = page.locator(`[data-thread="${title.threadId}"]`);
  await expect(card.locator(".conversation-response")).toBeVisible();
  const metrics = [];
  async function capture(name) {
    for (const [theme, width, height] of [["light", 1366, 800], ["dark", 720, 760]]) {
      await page.setViewportSize({ width, height });
      if (await page.locator("html").getAttribute("data-theme") !== theme) await setReviewTheme(page);
      await page.screenshot({ path: info.outputPath(`${name}-${theme}.png`), animations: "disabled", caret: "initial" });
      metrics.push(await page.evaluate(({ name, theme }) => {
        const properties = selector => {
          const node = document.querySelector(selector);
          if (!node) return null;
          const style = getComputedStyle(node);
          return { color: style.color, background: style.backgroundColor, fontSize: style.fontSize,
            lineHeight: style.lineHeight, bounds: node.getBoundingClientRect().toJSON() };
        };
        return { name, theme, host: document.querySelector(".conversation-panel").dataset.host,
          body: properties(".conversation-body"), composer: properties(".conversation-composer"),
          toolbar: properties(".shell-toolbar") };
      }, { name, theme }));
    }
  }
  await capture("answered-sidebar");
  await expect(page.getByRole("button", { name: "Choose what to send", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /Note to agent/ }).click();
  await expect(page.getByRole("textbox", { name: "Note to agent", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Choose what to send", exact: true })).toHaveCount(0);
  await capture("note");
  await page.getByRole("button", { name: /Note to agent/ }).click();
  await (await threadAction(page, card, "Beside target")).click();
  await capture("adjacent");
  await (await threadAction(page, card, "Focus")).click();
  await capture("focused");
  await card.getByRole("button", { name: "Reply", exact: true }).click();
  await card.getByRole("textbox").fill("Keep my reply draft while navigating.");
  await capture("reply");
  await card.getByRole("textbox").press("Escape");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await (await threadAction(page, card, "Open in Feedback")).click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await capture("history");
  await page.getByRole("group", { name: "Feedback destination" }).getByRole("button", { name: "Feedback", exact: true }).click();
  const latest = page.getByRole("region", { name: "Latest submission result" });
  await expect(latest).toContainText("Agent replied to 2 conversations");
  await latest.getByRole("button", { name: "Replies (2)", exact: true }).click();
  await latest.getByRole("button", { name: /wdyt about the title/ }).click();
  await expect(card).toHaveClass(/focused/);
  await expect(card.locator(".conversation-response")).toBeVisible();
  await expect(page.locator(".conversation-comparison-tools")).toHaveCount(0);
  await capture("reply-only-result");
  await page.route("**/api/**", route => route.abort("failed"));
  await page.locator("#seeChanges").click();
  const changes = page.getByRole("region", { name: "Changes", exact: true });
  await expect(changes).toContainText("No document changes reported.");
  expect((await changes.getByRole("button", { name: "Open Feedback", exact: true }).boundingBox()).x)
    .toBe((await changes.locator(".conversation-empty-result p").boundingBox()).x);
  await capture("no-change-results");
  await changes.getByRole("button", { name: "Back to review" }).click();
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/focused/);
  await page.locator("#seeChanges").click();
  await changes.getByRole("button", { name: "Open Feedback", exact: true }).click();
  await expect(page.locator(".conversation-panel")).toHaveAttribute("data-host", "feedback");
  await expect(changes).toBeHidden();
  await expect(card).not.toHaveClass(/focused/);
  await page.unroute("**/api/**");
  fs.writeFileSync(info.outputPath("surface-metrics.json"), JSON.stringify(metrics, null, 2));
});

test("shared composer styles and exact draft survive every desktop host in both themes", async ({ page, review }, info) => {
  test.setTimeout(90_000);
  const ref = await openReview(page, review, writeFile(review, "shared-style.html", "<p>A concise target.</p>"));
  await waitForSdk(page);
  const { threadId } = await seedThread(review, ref, "Explain the wording.", {
    kind: "selection", anchor: { quote: "A concise target." },
  });
  await sendPending(review, ref); await handled(review, ref); await feedback(page);
  const card = page.locator(`[data-thread="${threadId}"]`);
  await card.getByRole("button", { name: "Reply", exact: true }).click();
  const editor = card.getByRole("textbox", { name: "Reply", exact: true });
  await editor.fill("Keep my exact draft and independent permission.");
  await editor.evaluate(node => { window.parityEditor = node; node.setSelectionRange(2, 9); node.dispatchEvent(new Event("select", { bubbles: true })); });
  const samples = [];
  for (const [width, height] of [[1366, 800], [1024, 768], [900, 700], [720, 760], [1100, 550]]) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await setReviewTheme(page);
      let expectedStyles;
      for (const host of ["feedback", "focus", "adjacent"]) {
        if (host === "feedback") {
          const back = (await threadAction(page, card, "Open in Feedback"));
          if (await back.isVisible()) await back.click();
        } else await (await threadAction(page, card, host === "focus" ? "Focus" : "Beside target")).click();
        await expect(page.locator(".conversation-panel")).toHaveAttribute("data-host", host);
        // Feedback restores reading position rather than forcing a draft into view.
        if (host === "feedback") await editor.scrollIntoViewIfNeeded();
        await expect(editor).toBeInViewport();
        await page.locator("#reviewOptions").focus();
        await page.mouse.move(0, 0);
        await expect.poll(() => card.evaluate(node => node.getAnimations({ subtree: true })
          .some(animation => animation.playState === "running"))).toBe(false);
        const styles = await card.evaluate(node => {
          const properties = selector => {
            const style = getComputedStyle(node.querySelector(selector));
            return Object.fromEntries(["fontFamily", "fontSize", "lineHeight", "color", "backgroundColor", "borderTopColor", "borderRadius"]
              .map(key => [key, style[key]]));
          };
          return { message: properties(".conversation-body"), source: properties(".conversation-source"),
            editor: properties("textarea"), action: properties(".conversation-composer-actions > button:last-of-type") };
        });
        if (!expectedStyles) expectedStyles = styles;
        else expect(styles).toEqual(expectedStyles);
        expect(await card.evaluate(node => {
          const panel = node.closest(".conversation-panel");
          const outer = getComputedStyle(panel.classList.contains("is-adjacent") ? panel : node);
          const divider = getComputedStyle(panel.querySelector(".conversation-panel-header")).borderBottomColor;
          return ["Top", "Right", "Bottom", "Left"].every(side =>
            outer[`border${side}Color`] === divider && outer[`border${side}Width`] === "1px");
        })).toBe(true);
        expect(await editor.evaluate(node => [node === window.parityEditor, node.selectionStart, node.selectionEnd])).toEqual([true, 2, 9]);
        await expect(card.getByRole("checkbox", { name: "Request a change" })).not.toBeChecked();
        if (host === "feedback") {
          expect(await page.locator(".conversation-footer-support").evaluate(node => node.scrollHeight <= node.clientHeight)).toBe(true);
        }
        samples.push({ host, theme, width, height, styles });
        await page.screenshot({ path: info.outputPath(`${host}-${theme}-${width}x${height}.png`), animations: "disabled", caret: "initial" });
      }
    }
  }
  fs.writeFileSync(info.outputPath("shared-style-parity.json"), JSON.stringify(samples, null, 2));
});

for (const host of ["feedback", "focus", "adjacent"]) test(`visible Resolve and explicit Reopen work in ${host}`, async ({ page, review }, info) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const ref = await openReview(page, review, writeFile(review, `resolution-${host}.html`, '<p id="copy" tabindex="0">A reviewed passage.</p>'));
  await waitForSdk(page);
  const { threadId } = await seedThread(review, ref, "Explain this passage.\n\n" +
    "Filter before paging, keep the cursor tied to the same filters, and preserve authorization checks.\n\n".repeat(20), {
    kind: "element", anchor: { selector: "#copy", label: "Purpose · p 2" },
  });
  await sendPending(review, ref); await handled(review, ref);
  await feedback(page);
  const card = page.locator(`[data-thread="${threadId}"]`);
  await expect(card.locator(".conversation-response")).toBeVisible();
  await expect(card.locator(".conversation-source")).toHaveText("Purpose");
  await expect(card.locator(".conversation-target-quote")).toHaveAttribute("title", 'Paragraph 2 near "Purpose"');
  if (host !== "feedback") await (await threadAction(page, card, host === "focus" ? "Focus" : "Beside target")).click();
  await card.getByRole("button", { name: "Reply", exact: true }).click();
  const draft = card.getByRole("textbox", { name: "Reply", exact: true });
  await draft.fill("Preserve my exact unsent reply.");
  await card.getByRole("checkbox", { name: "Request a change" }).check();
  await (await threadAction(page, card, "Resolve conversation")).click();
  await expect(card.getByRole("status")).toContainText("draft");
  await expect(draft).toHaveValue("Preserve my exact unsent reply.");
  await expect(card.getByRole("checkbox", { name: "Request a change" })).toBeChecked();
  await card.getByRole("button", { name: "Keep reviewing" }).click();
  await card.getByRole("button", { name: "Close reply" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard", exact: true }).click();
  for (const [width, height] of [[1024, 768], [320, 400]]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height });
    if (await page.locator("html").getAttribute("data-theme") !== theme) await setReviewTheme(page);
    if (host === "adjacent" && await page.locator(".conversation-panel").getAttribute("data-host") !== "adjacent") {
      await (await threadAction(page, card, "Beside target")).click();
    }
    const popup = await page.locator(".conversation-panel").getAttribute("data-host") === "adjacent";
    const bottomResolve = card.getByRole("button", { name: "Resolve conversation", exact: true });
    const reply = card.getByRole("button", { name: "Reply", exact: true });
    await bottomResolve.scrollIntoViewIfNeeded();
    const left = await bottomResolve.boundingBox(), right = await reply.boundingBox();
    const row = await card.locator(".conversation-reply").boundingBox();
    expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(left.x - row.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(right.x + right.width - row.x - row.width)).toBeLessThanOrEqual(1);
    expect(left.y).toBeGreaterThanOrEqual(0);
    expect(left.y + left.height).toBeLessThanOrEqual(height);
    await page.screenshot({ path: info.outputPath(`bottom-actions-${host}-${theme}-${width}.png`), animations: "disabled", caret: "initial" });
    const openHeight = (await card.boundingBox()).height;
    if (theme === "light") await card.getByRole("button", { name: "Resolve conversation", exact: true }).click();
    else {
      await bottomResolve.focus();
      await bottomResolve.press("Enter");
    }
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    if (popup) {
      await expect(page.locator(".conversation-panel")).toBeHidden();
      await expect(page.locator("#commentsButton")).toBeFocused();
      await page.screenshot({ path: info.outputPath(`dismissed-${theme}-${width}.png`), animations: "disabled", caret: "initial" });
    }
    if (theme === "dark" && !popup) await expect(card.getByRole("button", { name: "Expand conversation", exact: true })).toBeFocused();
    if (popup) {
      await feedback(page);
      await expect(page.locator(".conversation-panel")).toHaveAttribute("data-host", "feedback");
    }
    if (await page.locator(".conversation-panel").getAttribute("data-host") === "feedback") {
      const resolvedFilter = page.getByRole("button", { name: "Resolved (1)", exact: true });
      if (await resolvedFilter.getAttribute("aria-pressed") === "false") {
        await expect(card).toBeHidden();
        await resolvedFilter.click();
      }
    }
    await expect(card).toHaveAttribute("data-status", "resolved");
    await expect(card.getByRole("img", { name: "Resolved", exact: true })).toHaveAccessibleName("Resolved");
    await expect(card.getByRole("button", { name: "Expand conversation", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(card.locator(".conversation-thread-content")).toBeHidden();
    await expect(await threadAction(page, card, "Reopen conversation")).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(card.getByRole("button", { name: "Mark conversation as read", exact: true })).toHaveCount(0);
    expect((await card.boundingBox()).height).toBeLessThan(openHeight);
    await page.screenshot({ path: info.outputPath(`resolved-${host}-${theme}-${width}.png`), caret: "initial" });
    await card.getByRole("button", { name: "Expand conversation", exact: true }).click();
    await expect(card.locator(".conversation-response")).toBeVisible();
    await expect(card.getByRole("img", { name: "Resolved", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Reopen conversation", exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Reopen conversation", exact: true }).click();
    await expect(card.getByRole("button", { name: "Resolve conversation", exact: true })).toBeVisible();
    await expect(card.getByRole("img", { name: "Resolved", exact: true })).toHaveCount(0);
    await expect(card.locator(".conversation-response")).toBeVisible();
  }
  await card.getByRole("button", { name: "Resolve conversation", exact: true }).click();
  await mutate(review, ref, "set-thread-status", { threadId, status: "open" });
  await expect(card.getByRole("button", { name: "Resolve conversation", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo resolve", exact: true })).toHaveCount(0);
  await mutate(review, ref, "end", { confirmUnsentReadOnly: true });
  await expect(page.getByRole("status", { name: "Review ended", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Resolve conversation", exact: true })).toHaveCount(0);
  await card.getByRole("button", { name: "Conversation actions" }).click();
  await expect(page.getByRole("menuitem", { name: /^(Resolve|Reopen) conversation$/ })).toHaveCount(0);
});

test("resolved headers stay compact and readable on reload and narrow screens", async ({ page, review }, info) => {
  const ref = await openReview(page, review, writeFile(review, "resolved-header.html", "<p id='copy'>Exact issue filtering</p>"));
  await waitForSdk(page);
  const { threadId } = await seedThread(review, ref, "Good title", {
    kind: "element", anchor: { selector: "#copy", label: "Exact issue filtering with clear permissions" },
  });
  await sendPending(review, ref); await handled(review, ref);
  await mutate(review, ref, "set-thread-status", { threadId, status: "resolved" });
  await page.reload(); await waitForSdk(page); await feedback(page);
  const card = page.locator(`[data-thread="${threadId}"]`);
  await expect(card).toBeHidden();
  await page.getByRole("button", { name: "Resolved (1)", exact: true }).click();
  for (const width of [1280, 390, 320]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 600 });
    if (await page.locator("html").getAttribute("data-theme") !== theme) await setReviewTheme(page);
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator(".conversation-thread-content")).toBeHidden();
    const source = await card.locator(".conversation-source").boundingBox();
    const badge = await card.getByRole("img", { name: "Resolved", exact: true }).boundingBox();
    const actions = await card.locator(".conversation-thread-actions").boundingBox();
    expect(source.width).toBeGreaterThan(20);
    expect(source.x + source.width).toBeLessThanOrEqual(badge.x);
    expect(badge.x + badge.width).toBeLessThanOrEqual(actions.x);
    expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`resolved-compact-${theme}-${width}.png`), animations: "disabled", caret: "initial" });
  }
  await (await threadAction(page, card, "Reopen conversation")).click();
  await expect(card.getByRole("img", { name: "Resolved", exact: true })).toHaveCount(0);
  await expect(card.locator(".conversation-response")).toBeVisible();
});

test("transient connection recovery preserves authored runtime and drafts without reloading", async ({ page, context, review }) => {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) { super(...args); window.reviewEvents = this; }
    };
  });
  await openReview(page, review, writeFile(review, "reconnect-preservation.html", "<p id='copy'>Connection fixture</p><input aria-label='Native input'><script>window.bootIdentity = Math.random()</script>"));
  const frame = await waitForSdk(page);
  await frame.getByRole("textbox").fill("Keep exact authored input");
  const boot = await frame.locator("body").evaluate(() => window.bootIdentity);
  await feedback(page);
  await beginComment(page);
  const draft = page.getByRole("textbox", { name: "New message", exact: true });
  await draft.fill("Keep my unsent comment");
  await draft.evaluate(node => { window.reconnectDraft = node; node.setSelectionRange(2, 8); node.dispatchEvent(new Event("select", { bubbles: true })); });
  await context.setOffline(true);
  try {
    // Chromium's offline emulation leaves an already-open SSE socket alive.
    await page.evaluate(() => window.reviewEvents.dispatchEvent(new Event("error")));
    await expect(page.getByText("Connection lost. Showing previously loaded information.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toHaveCount(1);
    await expect(page.getByText(/Couldn't check what's ready to send/)).toHaveCount(0);
  } finally { await context.setOffline(false); }
  if (await page.getByRole("button", { name: "Reconnect", exact: true }).isVisible()) await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByText("Connection lost. Showing previously loaded information.", { exact: true })).toHaveCount(0);
  expect(await frame.locator("body").evaluate(() => window.bootIdentity)).toBe(boot);
  await expect(frame.getByRole("textbox")).toHaveValue("Keep exact authored input");
  expect(await draft.evaluate(node => [node === window.reconnectDraft, node.value, node.selectionStart, node.selectionEnd]))
    .toEqual([true, "Keep my unsent comment", 2, 8]);
});
