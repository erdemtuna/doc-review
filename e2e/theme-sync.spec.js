import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { test, expect, openReview, waitForSdk, writeFile, enterEditMode } from "./helpers.js";
import { REVIEW_PALETTE } from "../src/review-palette.js";

const chromeOrigin = "http://127.0.0.1:32123";
const artifactOrigin = "http://localhost:32123";
const identity = { capability: "theme-test-capability", generation: 1, pageKey: "theme-test-page" };

async function openSdk(page, background = "#ffffff") {
  const errors = [];
  const warnings = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === chromeOrigin) {
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body>
        <iframe id="artifact" src="${artifactOrigin}/document.html"></iframe>
        <script>window.received = []; window.addEventListener("message", event => received.push(event.data));</script>
      </body></html>` });
      return;
    }
    if (url.pathname === "/document.html") {
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head>
        <style>body { background: ${background}; color: ${background === "#ffffff" ? "#111111" : "#ffffff"}; } #mixed { background: linear-gradient(90deg, #000, #fff); height: 100px; }</style>
        <script>window.bootCount = (window.bootCount || 0) + 1;</script>
      </head><body><p id="target">Keep this authored selection and document</p>
        <input id="draft" value="Page draft"><div id="mixed">Mixed background</div>
        <script data-eh-sdk data-eh-bootstrap nonce="${identity.capability}" data-generation="1" data-page-key="${identity.pageKey}"></script>
        <script type="module" data-eh-sdk src="/sdk.js"></script>
      </body></html>` });
      return;
    }
    if (!/^\/[a-z-]+\.js$/.test(url.pathname)) { await route.abort(); return; }
    const file = path.join(process.cwd(), "src", url.pathname.slice(1));
    let body;
    try {
      body = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      body = ts.transpileModule(await fs.readFile(file.replace(/\.js$/, ".ts"), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      }).outputText;
    }
    await route.fulfill({ contentType: "text/javascript", body });
  });
  await page.goto(chromeOrigin);
  await expect.poll(() => page.evaluate(() => received.some((message) => message.type === "eh:ready"))).toBe(true);
  const frame = page.frames().find((candidate) => candidate.url() === `${artifactOrigin}/document.html`);
  expect(errors).toEqual([]);
  return { frame, errors, warnings };
}

async function command(page, payload, envelope = identity) {
  await page.evaluate(({ payload, envelope, artifactOrigin }) => {
    document.querySelector("iframe").contentWindow.postMessage({ ...envelope, ...payload }, artifactOrigin);
  }, { payload, envelope, artifactOrigin });
  // A parent round trip drains the same frame message task queue.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 25)));
}
async function applied(page) {
  return page.evaluate(() => received.filter((message) => message.type === "eh:themeApplied"));
}
const rgb = (hex) => `rgb(${[1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)).join(", ")})`;

test("SDK ready precedes theme, strict admission gates tools, and revisions are idempotent", async ({ page }) => {
  const { frame, warnings, errors } = await openSdk(page);
  await expect(frame.locator("#commentAction")).toBeHidden();
  expect(await frame.locator("[data-eh-ui]").getAttribute("data-review-theme")).toBeNull();
  expect(await frame.locator("style[data-eh-sdk]").textContent()).not.toContain("::selection");
  const valid = { type: "eh:setTheme", theme: "dark", themeRevision: 1 };
  for (const envelope of [
    { ...identity, capability: "wrong" }, { ...identity, generation: 2 }, { ...identity, pageKey: "wrong" },
  ]) await command(page, valid, envelope);
  await frame.evaluate(({ valid, identity, chromeOrigin }) => {
    window.dispatchEvent(new MessageEvent("message", { source: window, origin: chromeOrigin, data: { ...identity, ...valid } }));
    window.dispatchEvent(new MessageEvent("message", { source: parent, origin: "https://wrong.test", data: { ...identity, ...valid } }));
  }, { valid, identity, chromeOrigin });
  expect(warnings).toEqual([]);
  for (const payload of [
    { theme: null }, { theme: "system" }, { themeRevision: 0 }, { themeRevision: -1 },
    { themeRevision: 1.5 }, { themeRevision: Number.MAX_SAFE_INTEGER + 1 },
    { themeRevision: null }, { themeRevision: "1" }, { theme: undefined },
    { themeRevision: undefined }, { css: "body { color: red }" },
  ]) await command(page, { ...valid, ...payload });
  expect(await applied(page)).toEqual([]);
  expect(warnings).toHaveLength(3);
  expect(warnings.join(" ")).not.toContain(identity.capability);
  await command(page, valid);
  await expect(frame.locator("[data-eh-ui]")).toHaveAttribute("data-review-theme", "dark");
  expect(await applied(page)).toEqual([{ ...identity, type: "eh:themeApplied", theme: "dark", themeRevision: 1 }]);
  await frame.evaluate(() => {
    window.themeStyle = document.querySelector("style[data-eh-sdk]");
    window.themeMutations = [];
    window.themeObserver = new MutationObserver((records) => themeMutations.push(...records));
    themeObserver.observe(themeStyle, { childList: true, characterData: true, subtree: true });
  });
  await command(page, valid);
  expect(await applied(page)).toHaveLength(2);
  expect(await frame.evaluate(() => themeMutations.length)).toBe(0);
  await command(page, { ...valid, theme: "light" });
  expect(await applied(page)).toHaveLength(2);
  await command(page, { ...valid, theme: "light", themeRevision: 3 });
  await command(page, { ...valid, themeRevision: 2 });
  expect(await applied(page)).toHaveLength(3);
  await expect(frame.locator("[data-eh-ui]")).toHaveAttribute("data-review-theme", "light");
  await command(page, { ...valid, type: "eh:themeApplied", themeRevision: 4 });
  expect(await applied(page)).toHaveLength(3);
  expect(errors).toEqual([]);
});

for (const [theme, background] of [["light", "#111111"], ["dark", "#ffffff"]]) {
  test(`${theme} SDK controls ignore opposing authored surfaces and preserve live DOM`, async ({ page }) => {
    const { frame, errors } = await openSdk(page, background);
    await command(page, { type: "eh:setTheme", theme, themeRevision: 1 });
    await command(page, { type: "eh:configureReview", mode: "edit", savePolicy: "writable" });
    await frame.evaluate(() => {
      const host = document.querySelector("[data-eh-ui]");
      const shadow = host.shadowRoot;
      window.saved = {
        host, input: shadow.querySelector("#linkInput"), documentStyle: document.querySelector("style[data-eh-sdk]"),
        shadowStyle: shadow.querySelector("style"), body: document.body, authoredStyle: document.head.querySelector("style"),
        mode: document.body.getAttribute("contenteditable"),
      };
      for (const selector of [".outline", ".active", ".chips", ".grip", ".hint", ".linkbox", ".mover", ".dropline", ".comment-action"]) {
        const element = shadow.querySelector(selector);
        element.style.display = "flex";
        element.style.top = "20px";
        element.style.left = "20px";
      }
      const marker = document.createElement("div");
      marker.className = "block-marker";
      const badge = document.createElement("button");
      badge.className = "block-badge";
      const cue = document.createElement("div");
      cue.className = "selection-cue";
      shadow.append(marker, badge, cue);
      const mark = document.createElement("mark");
      mark.dataset.ehMark = "comment-1";
      mark.textContent = "Annotated";
      document.querySelector("#target").append(mark);
      document.querySelector("#draft").value = "Unsent authored draft";
      saved.input.value = "https://draft.example/path";
      saved.input.focus();
      saved.input.setSelectionRange(8, 13);
    });
    const measure = () => frame.evaluate(() => {
      const shadow = document.querySelector("[data-eh-ui]").shadowRoot;
      const styles = {};
      for (const selector of [".chip:not(.danger)", ".chip.danger", ".linkbox", ".linkbox input", ".grip", ".hint", ".mover",
        ".dropline", ".comment-action", ".block-badge", ".block-marker", ".outline", ".active", ".selection-cue"]) {
        const css = getComputedStyle(shadow.querySelector(selector));
        styles[selector] = { color: css.color, background: css.backgroundColor, border: css.borderTopColor, shadow: css.boxShadow, opacity: css.opacity };
      }
      styles.mark = { background: getComputedStyle(document.querySelector("mark")).backgroundColor };
      styles.selection = { background: getComputedStyle(document.querySelector("#target"), "::selection").backgroundColor };
      styles.placeholder = { color: getComputedStyle(shadow.querySelector("input"), "::placeholder").color };
      return styles;
    });
    for (const [revision, selected] of [[1, theme], [2, theme === "light" ? "dark" : "light"], [3, theme]]) {
      if (revision > 1) await command(page, { type: "eh:setTheme", theme: selected, themeRevision: revision });
      const palette = REVIEW_PALETTE[selected];
      await expect.poll(async () => (await measure())[".mover"].background).toBe(rgb(palette.card));
      const styles = await measure();
      for (const selector of [".chip:not(.danger)", ".linkbox", ".grip", ".hint", ".mover"]) {
        expect(styles[selector].background, selector).toBe(rgb(palette.card));
        expect(styles[selector].shadow, selector).not.toBe("none");
        expect(styles[selector].opacity, selector).toBe("1");
      }
      expect(styles[".chip.danger"].color).toBe(rgb(palette.destructive));
      expect(styles[".linkbox input"].color).toBe(rgb(palette.foreground));
      expect(styles.placeholder.color).toBe(rgb(palette["muted-foreground"]));
      expect(styles[".comment-action"].background).toBe(rgb(palette.primary));
      expect(styles[".dropline"].border).toBe(rgb(palette.primary));
      expect(styles[".active"].border).toBe(rgb(palette["annotation-border"]));
      expect(styles[".block-badge"].background).toBe(rgb(palette["annotation-background"]));
      expect(styles.mark.background).toBe(rgb(palette["annotation-background"]));
      expect(styles.selection.background).toBe(rgb(palette["annotation-active"]));
      expect(await frame.evaluate(() => ({
        nodes: saved.host === document.querySelector("[data-eh-ui]") && saved.input === saved.host.shadowRoot.querySelector("#linkInput") &&
          saved.documentStyle === document.querySelector("style[data-eh-sdk]") && saved.shadowStyle === saved.host.shadowRoot.querySelector("style") &&
          saved.body === document.body && saved.authoredStyle === document.head.querySelector("style"),
        active: saved.host.shadowRoot.activeElement === saved.input,
        value: saved.input.value, caret: [saved.input.selectionStart, saved.input.selectionEnd],
        authoredDraft: document.querySelector("#draft").value, boots: window.bootCount,
        mode: document.body.getAttribute("contenteditable") === saved.mode,
        authoredTheme: document.body.hasAttribute("data-review-theme") || document.documentElement.hasAttribute("data-review-theme"),
      }))).toEqual({
        nodes: true, active: true, value: "https://draft.example/path", caret: [8, 13],
        authoredDraft: "Unsent authored draft", boots: 1, mode: true, authoredTheme: false,
      });
      expect(await frame.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(rgb(background));
    }
    await frame.evaluate(() => {
      const box = saved.host.shadowRoot.querySelector(".linkbox");
      const rect = document.querySelector("#mixed").getBoundingClientRect();
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      const range = document.createRange();
      range.setStart(document.querySelector("#target").firstChild, 5);
      range.setEnd(document.querySelector("#target").firstChild, 14);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      window.authoredRange = range;
    });
    await command(page, { type: "eh:setTheme", theme: theme === "light" ? "dark" : "light", themeRevision: 4 });
    expect(await frame.evaluate(() => ({
      range: getSelection().getRangeAt(0) === window.authoredRange,
      selection: getSelection().toString(),
      mixed: getComputedStyle(document.querySelector("#mixed")).backgroundImage,
    }))).toEqual({
      range: true, selection: "this auth",
      mixed: "linear-gradient(90deg, rgb(0, 0, 0), rgb(255, 255, 255))",
    });
    expect(errors).toEqual([]);
  });
}

test("production shell changes the existing SDK, not authored appearance or open editing controls", async ({ page, review }) => {
  await openReview(page, review, writeFile(review, "theme-live.html", `<!doctype html>
    <html><head><title>Theme isolation</title><style>body { background: #111111; color: #ffffff; }</style></head>
    <body><p id="target">Keep the authored document while switching themes.</p><input id="draft" value="Original"></body></html>`));
  const frame = await waitForSdk(page);
  await expect(frame.locator("[data-eh-ui]")).toHaveAttribute("data-review-theme", "light");
  await enterEditMode(page);
  await frame.locator("#draft").fill("Unsent authored draft");
  await frame.locator("#target").click();
  await frame.locator("#target").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });

  await page.keyboard.press("Control+k");
  await expect(frame.locator("#linkInput")).toBeFocused();
  await frame.locator("#linkInput").fill("https://unsent.example");
  await frame.locator("body").evaluate(() => {
    const host = document.querySelector("[data-eh-ui]");
    const shadow = host.shadowRoot;
    window.themeLive = { host, body: document.body, input: shadow.querySelector("#linkInput") };
    window.themeLive.input.setSelectionRange(3, 8);
  });
  await expect(frame.locator("#linkInput")).toBeFocused();
  await page.locator("#frame").evaluate((element) => { window.retainedThemeFrame = element; });
  for (const theme of ["dark", "light", "dark"]) {
    // Programmatic activation avoids moving focus out of the frame.
    await page.locator("#theme").evaluate((element) => element.click());
    await expect(frame.locator("[data-eh-ui]")).toHaveAttribute("data-review-theme", theme);
    expect(await frame.locator("body").evaluate(() => ({
      nodes: themeLive.host === document.querySelector("[data-eh-ui]") && themeLive.body === document.body &&
        themeLive.input === themeLive.host.shadowRoot.querySelector("#linkInput"),
      caret: [themeLive.input.selectionStart, themeLive.input.selectionEnd],
      focused: themeLive.host.shadowRoot.activeElement === themeLive.input,
      draft: document.querySelector("#draft").value,
      link: themeLive.input.value,
      mode: document.body.getAttribute("contenteditable"),
      background: getComputedStyle(document.body).backgroundColor,
    }))).toEqual({
      nodes: true, caret: [3, 8], focused: true, draft: "Unsent authored draft",
      link: "https://unsent.example", mode: "true", background: "rgb(17, 17, 17)",
    });
    expect(await page.locator("#frame").evaluate((element) => element === window.retainedThemeFrame)).toBe(true);
  }
});

test("SDK repositions an open link draft on frame resize and dismisses disconnected targets", async ({ page }) => {
  const { frame, errors } = await openSdk(page);
  await page.locator("iframe").evaluate((element) => { element.style.width = "800px"; element.style.height = "500px"; });
  await command(page, { type: "eh:setTheme", theme: "light", themeRevision: 1 });
  await command(page, { type: "eh:configureReview", mode: "edit", savePolicy: "writable" });
  await frame.locator("#target").click();
  await frame.locator("#target").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.keyboard.press("Control+k");
  await expect(frame.locator("#linkInput")).toBeFocused();
  await frame.locator("#linkInput").fill("https://keep-unsent.example");
  await frame.locator("#linkInput").evaluate((element) => {
    window.retainedLinkInput = element;
    element.setSelectionRange(8, 12);
  });
  for (const height of [180, 500]) {
    await page.locator("iframe").evaluate((element, height) => {
      element.style.height = `${height}px`;
      element.style.width = height === 180 ? "400px" : "800px";
    }, height);
    await frame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(frame.locator("#linkInput")).toBeFocused();
    await expect(frame.locator("#linkInput")).toHaveValue("https://keep-unsent.example");
    expect(await frame.locator("#linkInput").evaluate((element) => ({
      same: element === retainedLinkInput,
      caret: [element.selectionStart, element.selectionEnd],
      fits: element.closest(".linkbox").getBoundingClientRect().bottom <= innerHeight &&
        element.closest(".linkbox").getBoundingClientRect().right <= innerWidth,
    }))).toEqual({ same: true, caret: [8, 12], fits: true });
  }
  await frame.locator("#target").evaluate((element) => {
    element.remove();
    window.dispatchEvent(new Event("resize"));
  });
  await expect(frame.locator("#linkInput")).toBeHidden();
  expect(errors).toEqual([]);
});
