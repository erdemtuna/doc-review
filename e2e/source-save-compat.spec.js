import fs from "node:fs";
import { test, expect, openReview, waitForSdk, writeFile, enterEditMode, selectText, listed } from "./helpers.js";

for (const scripted of [false, true]) test(`pre-head bootstrap preserves ${scripted ? "scripted feedback-only protection" : "plain-file automatic saving"} without whitespace normalization`, async ({ page, review }) => {
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
    expect(operations).toContain("save-edit");
    expect(await page.evaluate(() => window.saveMessages)).not.toContain("eh:dynamic");
    expect(fs.readFileSync(file, "utf8")).toContain("<pre id=\"spacing\">  Keep these\n    authored spaces  </pre>");
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  const edits = (await listed(review, ref, "edits")).items;
  expect(edits).toHaveLength(1);
  expect(edits[0].source.state).toBe(scripted ? "pending" : "saved");
});
