import { test, expect, enterEditMode, openReview, reviewApi, waitForSdk, writeFile } from "./helpers.js";

const source = `<!doctype html><html><body>
<p id="copy">Original paragraph for feedback.</p>
<label>Authored draft <input aria-label="Authored draft"></label>
</body></html>`;

async function addComment(review, key, feedback = "Clarify this paragraph") {
  const response = await reviewApi(review, `/api/page/${key}/comment`, {
    method: "POST", body: {
      kind: "element", anchor: { selector: "#copy", label: "Paragraph" },
      quote: "Original paragraph for feedback.", feedback,
    },
  });
  expect(response.status, response.raw).toBe(200);
}

async function addEdits(review, key, count, offset = 0) {
  for (let index = 0; index < count; index++) {
    const response = await reviewApi(review, `/api/page/${key}/edit`, {
      method: "POST", body: {
        label: `Paragraph ${offset + index + 1}`, kind: "edited",
        before: "Original wording", after: `Revised wording ${offset + index + 1}`, feedback_only: true,
      },
    });
    expect(response.status, response.raw).toBe(200);
  }
}

async function navigate(review, session, href) {
  const response = await reviewApi(review, `/api/session/${session.sessionId}/navigate`, {
    method: "POST", body: { href },
  });
  expect(response.status, response.raw).toBe(200);
  return response.json();
}

async function expectSection(page, name, open) {
  const id = name.toLowerCase();
  const toggle = page.locator(`#${id}ContentToggle`);
  await expect(toggle).toHaveRole("button");
  await expect(toggle).toHaveAccessibleName(name);
  await expect(toggle).toHaveAttribute("aria-controls", `${id}Content`);
  await expect(toggle).toHaveAttribute("aria-expanded", String(open));
  await expect(page.locator(`#${id}Content`)).toHaveCount(1);
  if (open) await expect(page.locator(`#${id}Content`)).toBeVisible();
  else await expect(page.locator(`#${id}Content`)).toBeHidden();
}

async function expectTotal(page, total) {
  const badge = page.locator("#toolbarCount");
  await expect(badge).toHaveText(total > 99 ? "99+" : String(total));
  await expect(badge).toHaveAttribute("aria-label", `${total} feedback items`);
  await expect(badge).toHaveAttribute("title", `${total} feedback items`);
  if (total) await expect(page.locator("#send")).toHaveText(`Send ${total} to agent`);
}

test("feedback disclosures preserve DOM and tab-lifetime choices, but reload expands them", async ({ page, review }) => {
  const first = "disclosure-first.html";
  const second = "disclosure-second.html";
  writeFile(review, second, source);
  const session = await openReview(page, review, writeFile(review, first, source));
  await addComment(review, session.key);
  await addEdits(review, session.key, 7);
  const other = await navigate(review, session, second);
  await addComment(review, other.key, "Feedback on the other page");
  await navigate(review, session, first);
  await page.reload();
  const frame = await waitForSdk(page);
  await frame.getByLabel("Authored draft").fill("Keep the page-owned draft");
  await page.getByRole("button", { name: "Feedback", exact: true }).click();
  await expect(page.locator("#drawerTitle")).toHaveText("Feedback");
  await expect(page.locator("#drawer").getByText("Review", { exact: true })).toHaveCount(0);
  await expect(page.locator("#drawerClose")).toHaveAccessibleName("Close feedback");
  await expectSection(page, "Comments", true);
  await expectSection(page, "Edits", true);
  await expect(page.locator("#editList li")).toHaveCount(5);
  await page.getByRole("button", { name: "2 more…" }).click();
  await expect(page.locator("#editList li")).toHaveCount(7);
  await page.locator("#note").fill("Keep note identity and caret");
  await page.locator("#note").evaluate((element) => {
    window.feedbackNodes = {
      note: element, frame: document.getElementById("frame"),
      comments: document.getElementById("commentsContent"), edits: document.getElementById("editsContent"),
      editButton: document.querySelector('#cards button[aria-label="Edit comment"]'),
    };
    element.setSelectionRange(2, 8);
    element.dispatchEvent(new Event("select", { bubbles: true }));
  });
  await page.locator("#commentsContentToggle").focus();
  await page.keyboard.press("Enter");
  await page.locator("#editsContentToggle").focus();
  await page.keyboard.press("Space");
  await expectSection(page, "Comments", false);
  await expectSection(page, "Edits", false);
  await expect(page.locator("#cards article")).toHaveCount(1);
  await expect(page.locator("#editList li")).toHaveCount(7);
  await expect(page.locator("#othersList")).toBeVisible();
  await page.locator("#drawerClose").click();
  await page.locator("#theme").click();
  await page.locator("#seeChanges").click();
  await expect(page.locator("#historyPanel")).toBeVisible();
  await page.locator("#latestVersion").click();
  await page.locator("#commentsButton").click();
  await expectSection(page, "Comments", false);
  await expectSection(page, "Edits", false);
  expect(await page.evaluate(() => ({
    note: document.getElementById("note") === window.feedbackNodes.note,
    frame: document.getElementById("frame") === window.feedbackNodes.frame,
    comments: document.getElementById("commentsContent") === window.feedbackNodes.comments,
    edits: document.getElementById("editsContent") === window.feedbackNodes.edits,
    editButton: document.querySelector('#cards button[aria-label="Edit comment"]') === window.feedbackNodes.editButton,
    selection: [window.feedbackNodes.note.selectionStart, window.feedbackNodes.note.selectionEnd],
  }))).toEqual({ note: true, frame: true, comments: true, edits: true, editButton: true, selection: [2, 8] });
  await expect(frame.getByLabel("Authored draft")).toHaveValue("Keep the page-owned draft");
  await page.locator("#editsContentToggle").click();
  await expect(page.locator("#editList li")).toHaveCount(7);
  await expect(page.getByRole("button", { name: "Show fewer" })).toBeVisible();
  await page.locator("#editsContentToggle").click();

  await page.locator("#othersList").getByRole("button").click();
  await waitForSdk(page);
  await expect(page.locator("#cards")).toContainText("Feedback on the other page");
  await expectSection(page, "Comments", false);
  await expect(page.locator("#editsBox")).toBeHidden();
  await page.locator("#othersList").getByRole("button").click();
  await waitForSdk(page);
  await expect(page.locator("#editCount")).toHaveText("7");
  await expectSection(page, "Comments", false);
  await expectSection(page, "Edits", false);
  await expect(page.locator("#note")).toHaveValue("Keep note identity and caret");
  expect(await page.locator("#note").evaluate((element) => element === window.feedbackNodes.note)).toBe(true);

  await page.reload();
  await waitForSdk(page);
  await page.locator("#commentsButton").click();
  await expectSection(page, "Comments", true);
  await expectSection(page, "Edits", true);
});

test("saved comment editing locks disclosure through validation and save, then Cancel or Save unlocks", async ({ page, review }) => {
  const session = await openReview(page, review, writeFile(review, "disclosure-edit.html", source));
  await addComment(review, session.key);
  await page.reload();
  const frame = await waitForSdk(page);
  await page.locator("#commentsButton").click();
  await page.locator("#commentsContentToggle").click();
  await page.locator("#drawerClose").click();
  await frame.locator(".block-badge").click();
  await page.locator("#alignedCard").getByRole("button", { name: "Edit comment", exact: true }).click();
  await page.locator("#commentsButton").click();
  const toggle = page.locator("#commentsContentToggle");
  const card = page.locator("#cards article");
  const editor = card.getByLabel("Edit comment text");
  await expectSection(page, "Comments", true);
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  await expect(toggle).toHaveAccessibleDescription(/save|cancel|finish/i);
  await editor.fill("Retain this draft and caret");
  await editor.evaluate((element) => {
    window.feedbackEditor = element;
    element.setSelectionRange(3, 9);
    element.dispatchEvent(new Event("select", { bubbles: true }));
  });
  // A DOM click bypasses Playwright's disabled guard to exercise the controller's lock.
  await toggle.evaluate((element) => element.click());
  await page.locator("#theme").click();
  await expectSection(page, "Comments", true);
  expect(await editor.evaluate((element) => ({
    same: element === window.feedbackEditor, selection: [element.selectionStart, element.selectionEnd],
  }))).toEqual({ same: true, selection: [3, 9] });
  await editor.fill("   ");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("Comment text is required.");
  await expect(editor).toBeFocused();
  await toggle.evaluate((element) => element.click());
  await expectSection(page, "Comments", true);
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(toggle).not.toHaveAttribute("aria-disabled", "true");
  await expectSection(page, "Comments", true);
  await toggle.click();
  await expectSection(page, "Comments", false);
  await toggle.click();
  await card.getByRole("button", { name: "Edit comment", exact: true }).click();
  await editor.fill("Saved revised feedback");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/page/*/comment/*", async (route) => {
    if (route.request().method() === "PATCH") await gate;
    await route.continue();
  });
  try {
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveJSProperty("readOnly", true);
    await expect(toggle).toHaveAttribute("aria-disabled", "true");
    await toggle.evaluate((element) => element.click());
    await expectSection(page, "Comments", true);
  } finally { release(); }
  await expect(card.locator("textarea")).toHaveCount(0);
  await expect(card.locator(".body")).toHaveText("Saved revised feedback");
  await expect(toggle).not.toHaveAttribute("aria-disabled", "true");
  await expectSection(page, "Comments", true);
  await toggle.click();
  await page.locator("#drawerClose").click();
  await expect(page.locator("#alignedCard")).toBeVisible();
  await expect(page.locator("#alignedCard")).toContainText("Saved revised feedback");
  await page.locator("#alignedCard").getByRole("button", { name: "Delete comment", exact: true }).click();
  await page.locator("#commentsButton").click();
  await expectSection(page, "Comments", true);
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  await toggle.evaluate((element) => element.click());
  await expect(card.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(toggle).not.toHaveAttribute("aria-disabled", "true");
  await expectSection(page, "Comments", true);
  await toggle.click();
  await expectSection(page, "Comments", false);
});

test("a save error remains visible outside collapsed Edits and clears after a real retry", async ({ page, review }) => {
  const session = await openReview(page, review, writeFile(review, "disclosure-save.html", source));
  await addEdits(review, session.key, 1);
  await page.reload();
  await waitForSdk(page);
  await page.locator("#commentsButton").click();
  await page.locator("#editsContentToggle").click();
  await page.locator("#commentsContentToggle").click();
  await page.locator("#drawerClose").click();
  const frame = await enterEditMode(page);
  await page.route("**/api/page/*/save", (route) => route.fulfill({
    status: 503, json: { error: "Source save unavailable" },
  }));
  await frame.locator("#copy").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" changed");
  await expect(page.locator("#saveLine")).toHaveAttribute("data-error", "true");
  await page.locator("#commentsButton").click();
  await expectSection(page, "Edits", false);
  await expectSection(page, "Comments", false);
  await expect(page.locator("#saveLine")).toHaveRole("alert");
  await expect(page.locator("#saveText")).toBeVisible();
  await expect(page.locator("#saveText")).toContainText("Couldn't save");
  await expect(page.locator("#send")).toBeVisible();
  await expect(page.locator("#endReview")).toBeVisible();
  await page.unroute("**/api/page/*/save");
  await page.locator("#drawerClose").click();
  await page.locator("#modeButton").click();
  await page.getByRole("menuitemradio", { name: /^View/ }).click();
  await expect(page.locator("#modeLabel")).toHaveText("View");
  await page.locator("#commentsButton").click();
  await expect(page.locator("#saveLine")).toHaveAttribute("data-error", "false");
  await expectSection(page, "Edits", false);
  await page.locator("#editsContentToggle").click();
  await expect(page.locator("#saveText")).toContainText("Saved to");
});

test("toolbar feedback total matches Send across notes, drafts, edits, other pages and the 99+ cap", async ({ page, review }) => {
  test.setTimeout(60_000);
  const first = "feedback-total-first.html";
  const second = "feedback-total-second.html";
  writeFile(review, second, source);
  const session = await openReview(page, review, writeFile(review, first, source));
  const frame = await waitForSdk(page);
  await page.locator("#commentsButton").click();
  await page.locator("#note").fill("A note is sendable but is not counted");
  await expectTotal(page, 0);
  await expect(page.locator("#send")).toHaveText("Send note to agent");
  await expect(page.locator("#send")).toBeEnabled();
  await page.locator("#drawerClose").click();
  await frame.locator("#copy").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await frame.locator("#commentAction").click();
  await page.locator("#composeText").fill("Unsaved contextual draft is not counted");
  await page.locator("#commentsButton").click();
  await expect(page.locator("#draftWarning")).toContainText("1 open draft is not included");
  await expectTotal(page, 0);
  await expect(page.locator("#send")).toHaveText("Send note to agent");
  await page.locator("#drawerClose").click();
  await page.locator("#composeCancel").click();
  await addEdits(review, session.key, 1);
  await page.reload();
  await waitForSdk(page);
  await page.locator("#commentsButton").click();
  await expect(page.locator("#count")).toHaveText("0");
  await expect(page.locator("#editCount")).toHaveText("1");
  await expectTotal(page, 1);
  await addEdits(review, session.key, 99, 1);
  await addComment(review, session.key);
  const other = await navigate(review, session, second);
  await addComment(review, other.key, "Other-page comment");
  await addEdits(review, other.key, 2);
  await navigate(review, session, first);
  await page.reload();
  await waitForSdk(page);
  await page.locator("#commentsButton").click();
  await expect(page.locator("#count")).toHaveText("1");
  await expect(page.locator("#editCount")).toHaveText("100");
  await expect(page.locator("#othersCount")).toHaveText("1");
  await expectTotal(page, 104);
  await page.locator("#commentsContentToggle").click();
  await page.locator("#editsContentToggle").click();
  await expectTotal(page, 104);
  await page.locator("#othersList").getByRole("button").click();
  await waitForSdk(page);
  await expect(page.locator("#editCount")).toHaveText("2");
  await expect(page.locator("#count")).toHaveText("1");
  await expectTotal(page, 104);
});
