import fs from "node:fs";
import { createHash } from "node:crypto";
import { test, expect, openReview, waitForSdk, writeFile, enterEditMode, selectText, listed, seedThread, setReviewTheme } from "./helpers.js";

for (const theme of ["light", "dark"]) for (const authored of [false, true]) test(`${theme} native annotation edits preserve ${authored ? "authored colors and underline" : "only intentional formatting"}`, async ({ page, review }) => {
  const style = authored ? ' style="color:#75470e;background-color:rgb(245, 214, 163);text-decoration:underline"' : "";
  const file = writeFile(review, `annotation-edit-${theme}-${authored}.html`, `<!doctype html><html><head><title>Edit</title></head><body><p id="copy"${style}>Original annotated words</p></body></html>`);
  const ref = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await setReviewTheme(page, theme);
  await seedThread(review, ref, "Discuss this wording", { kind: "selection", anchor: { quote: "Original annotated words" } });
  if (authored) await seedThread(review, ref, "A second discussion on the same wording", { kind: "selection", anchor: { quote: "Original annotated words" } });
  await expect(frame.locator("mark[data-eh-mark]")).toHaveCount(authored ? 2 : 1);
  await enterEditMode(page);
  await frame.locator("#copy").click();
  if (theme === "dark") {
    const box = await frame.locator("mark[data-eh-mark]").first().boundingBox();
    await page.mouse.move(box.x, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 2, box.y + box.height / 2, { steps: 15 });
    await page.mouse.up();
  }
  else {
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
  }
  await expect.poll(() => frame.locator("#copy").evaluate(() => getSelection().toString())).toBe("Original annotated words");
  await page.keyboard.insertText("retained findings");
  await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("retained findings");
  await selectText(frame, "#copy");
  await page.keyboard.press("Control+b");
  await expect.poll(() => fs.readFileSync(file, "utf8")).toMatch(/<(b|strong)>retained findings<\/(b|strong)>/);
  const saved = fs.readFileSync(file, "utf8");
  expect(saved).not.toMatch(/data-eh-mark/);
  if (authored) expect(saved).toContain(style);
  else expect(saved).not.toMatch(/<font|<u>|color:|background|text-decoration/);
  await page.keyboard.press("Control+z");
  await expect.poll(() => fs.readFileSync(file, "utf8")).not.toMatch(/<(b|strong)>retained findings/);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => fs.readFileSync(file, "utf8")).toMatch(/<(b|strong)>retained findings/);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.reload();
  const restored = await waitForSdk(page);
  await expect(restored.locator("#copy")).toHaveText("retained findings");
  await expect(restored.locator("#copy b, #copy strong")).toHaveText("retained findings");
  await expect(restored.locator("mark[data-eh-mark]")).toHaveCount(0);
});

test("unrecorded page attributes still reject saves with an accurate recoverable notice", async ({ page, review }) => {
  const original = '<html><head><title>Proof</title></head><body><p id="copy">Original</p></body></html>';
  const file = writeFile(review, "unrecorded-attribute.html", original);
  const ref = await openReview(page, review, file), frame = await waitForSdk(page);
  await enterEditMode(page);
  await frame.locator("body").evaluate(body => body.addEventListener("input", () => body.setAttribute("style", ""), { once: true }));
  await frame.locator("#copy").click(); await selectText(frame, "#copy");
  await page.keyboard.insertText("Recorded replacement");
  await expect(page.getByText(/page contains changes that do not match the recorded edits/).first()).toBeVisible();
  expect(fs.readFileSync(file, "utf8")).toBe(original);
  const edits = (await listed(review, ref, "edits")).items;
  expect(edits).toHaveLength(1);
  expect(edits[0].source.state).toBe("pending");
  expect(edits[0].content.after).toBe("Recorded replacement");
});

for (const heading of [false, true]) test(`labels describe sibling content and stay pinned ${heading ? "under headings" : "without headings"}`, async ({ page, review }) => {
  const file = writeFile(review, `stable-labels-${heading}.html`, `${heading ? "<h2>Comparison</h2>" : ""}<p id="one">Shared wording</p><p id="two">Shared wording</p>`);
  const ref = await openReview(page, review, file), frame = await waitForSdk(page);
  await enterEditMode(page);
  for (const [selector, value] of [["#one", "First replacement"], ["#two", "Second replacement"], ["#one", "Final first replacement"]]) {
    await frame.locator(selector).click(); await selectText(frame, selector);
    await page.keyboard.insertText(value);
    await expect.poll(() => fs.readFileSync(file, "utf8")).toContain(value);
  }
  const edits = (await listed(review, ref, "edits")).items;
  expect(edits).toHaveLength(2);
  expect(new Set(edits.map(edit => edit.content.label)).size).toBe(2);
  for (const edit of edits) expect(edit.content.label).toContain("Shared wording");
  if (heading) for (const edit of edits) expect(edit.content.label).toContain("Comparison");
});

for (const scripted of [false, true]) test(`pre-head bootstrap preserves ${scripted ? "scripted feedback-only protection" : "plain-file automatic saving"} without whitespace normalization`, async ({ page, review }, info) => {
  await page.addInitScript(() => {
    window.saveMessages = [];
    addEventListener("message", event => {
      if (["eh:dynamic", "eh:html", "eh:edit"].includes(event.data?.type)) window.saveMessages.push(event.data.type);
    });
  });
  const operations = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/conversation") && request.method() === "POST") operations.push(request.postDataJSON().operation);
  });
  const original = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Plain parser whitespace</title>
</head>
<body>
  <pre id="spacing">  Keep these
    authored spaces  </pre>
  <p id="copy">Original words</p>
  ${scripted ? '<script>document.querySelector("#copy").textContent = "Script-rendered words";</script>' : ""}
</body>
</html>`;
  const file = writeFile(review, `source-save-${scripted}.html`, original);
  const ref = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await enterEditMode(page);
  await expect(frame.locator("#copy")).toHaveText(scripted ? "Script-rendered words" : "Original words");
  expect(fs.readFileSync(file, "utf8")).toBe(original);
  if (!scripted) expect(await page.evaluate(() => window.saveMessages)).not.toContain("eh:dynamic");
  await frame.locator("#copy").click(); await selectText(frame, "#copy");
  await page.keyboard.insertText("A real browser edit, automatically saved when permitted.");
  await expect.poll(() => operations.includes("record-edit")).toBe(true);
  if (scripted) {
    await expect.poll(() => page.evaluate(() => window.saveMessages.includes("eh:dynamic"))).toBe(true);
    await page.waitForTimeout(1200);
    expect(operations).not.toContain("save-edit");
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  } else {
    await expect.poll(() => fs.readFileSync(file, "utf8")).toContain("A real browser edit, automatically saved when permitted.");
    await expect.poll(() => operations.includes("save-edit")).toBe(true);
    expect(await page.evaluate(() => window.saveMessages)).not.toContain("eh:dynamic");
    expect(fs.readFileSync(file, "utf8")).toContain("<pre id=\"spacing\">  Keep these\n    authored spaces  </pre>");
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  const edits = (await listed(review, ref, "edits")).items;
  expect(edits).toHaveLength(1);
  expect(edits[0].source.state).toBe(scripted ? "pending" : "saved");
  const after = fs.readFileSync(file, "utf8");
  const sha = value => createHash("sha256").update(value).digest("hex");
  fs.writeFileSync(info.outputPath("source-save-evidence.json"), JSON.stringify({
    scripted, operations, messages: await page.evaluate(() => window.saveMessages),
    original, after, originalSha256: sha(original), afterSha256: sha(after),
    sourceState: edits[0].source.state, unchanged: original === after,
    classification: "Browser autosave/protection fixture, not authentic agent source work",
  }, null, 2));
});
