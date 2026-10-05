import fs from "node:fs";
import { test, expect, openReview, writeFile, seedThread, conversation } from "./helpers.js";

for (const variant of ["first", "second"]) test(`same-named documents have independent test identity: ${variant}`, async ({ page, review }) => {
  const source = writeFile(review, "same-name.html", "<p id='copy'>Independent review.</p>");
  const ref = await openReview(page, review, source);
  expect((await conversation(review, ref, "status")).openThreadCount).toBe(0);
  await seedThread(review, ref, variant);
  expect((await conversation(review, ref, "status")).openThreadCount).toBe(1);
  expect(writeFile(review, "same-name.html", "<p>Updated within the same test.</p>")).toBe(source);
  expect(fs.readFileSync(source, "utf8")).toContain("Updated within the same test.");
});
