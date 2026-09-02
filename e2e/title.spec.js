import http from "node:http";
import { test, expect, openReview, waitForSdk, writeFile } from "./helpers.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

test("the real browser render path updates safe titles for files, Markdown, and localhost routes", async ({ page, review }) => {
  writeFile(review, "notes.md", "# Notes\n\nMarkdown page.");
  const file = writeFile(
    review,
    "index.html",
    '<!doctype html><a id="notes" href="./notes.md">Notes</a><p>HTML page</p>'
  );
  await openReview(page, review, file);
  await waitForSdk(page);
  await expect(page).toHaveTitle("index.html");

  await page.frameLocator("#frame").locator("#notes").evaluate((link) => {
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
  });
  await waitForSdk(page);
  await expect(page).toHaveTitle("notes.md");

  const app = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/"
        ? '<!doctype html><a id="next" href="/next">Next</a>'
        : "<!doctype html><p>Next route</p>"
    );
  });
  const appPort = await listen(app);
  try {
    await openReview(page, review, `http://localhost:${appPort}/`);
    await waitForSdk(page);
    await expect(page).toHaveTitle("/");
    await page.frameLocator("#frame").locator("#next").evaluate((link) => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    await waitForSdk(page);
    await expect(page).toHaveTitle("/next");
  } finally {
    await close(app);
  }
});

test("title assignment treats markup as text and keeps the empty fallback", async ({ page, review }) => {
  const file = writeFile(review, "title.html", "<!doctype html><p>Title</p>");
  let replacement = "<img src=x onerror=window.__titleOwned=1>";
  await page.route("**/api/page/*?session=*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.filename = replacement;
    await route.fulfill({ response, json: body });
  });

  await openReview(page, review, file);
  await waitForSdk(page);
  await expect(page).toHaveTitle(replacement);
  expect(await page.evaluate(() => window.__titleOwned)).toBeUndefined();

  replacement = "";
  await page.reload();
  await waitForSdk(page);
  await expect(page).toHaveTitle("human-review");
});
