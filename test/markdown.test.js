import { openResponse, read, mutate, thread, send, list, content, request as conversationRequest } from "./fixtures/review.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doc-review-markdown-"));
process.env.DOC_REVIEW_STATE_DIR = path.join(tmp, "state");

const { start } = await import("../lib/server.js");
const { isMarkdown, renderMarkdownPage } = await import("../lib/markdown.js");

function request(port, token, { method = "GET", route = "/", body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: {
          "x-doc-review-token": token,
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test("isMarkdown matches only markdown extensions", () => {
  assert.equal(isMarkdown("/a/plan.md"), true);
  assert.equal(isMarkdown("/a/plan.markdown"), true);
  assert.equal(isMarkdown("/a/PLAN.MD"), true);
  assert.equal(isMarkdown("/a/plan.html"), false);
  assert.equal(isMarkdown("/a/plan.md.html"), false);
});

test("renderMarkdownPage produces a full document from gfm source", () => {
  const html = renderMarkdownPage("# Plan\n\nShip **soon**.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n", "/x/plan.md");
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<h1[^>]*>Plan<\/h1>/);
  assert.match(html, /<strong>soon<\/strong>/);
  assert.match(html, /<table>/, "gfm tables render");
  assert.match(html, /<title>plan\.md<\/title>/);
});

test("raw HTML in markdown is visible but never active", () => {
  const html = renderMarkdownPage(
    "# Hi\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n<iframe src=\"https://evil.example\"></iframe>\n\n<svg onload=alert(3)><circle /></svg>\n\n<div>Kept text</div>\n\n[Bad link](javascript:alert(4))\n\n![Bad image](data:text/html,bad)\n",
    "/x/notes.md"
  );
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelectorAll("script, iframe, svg").length, 0, "active elements are rendered only as text");
  assert.equal(
    [...document.querySelectorAll("*")].some((element) => [...element.attributes].some((attr) => /^on/i.test(attr.name))),
    false,
    "event-handler attributes never become active"
  );
  assert.equal(document.querySelectorAll('[href^="javascript:"], [src^="javascript:"], [src^="data:text/html"]').length, 0);
  assert.match(document.body.textContent, /Kept text/, "the source remains readable");
  assert.match(document.body.textContent, /Bad link/, "unsafe links retain their readable label");
});

test("normal Markdown links and images remain available", () => {
  const html = renderMarkdownPage(
    "[Relative](./spec.md) [Web](https://example.com) [Email](mailto:hi@example.com) ![Image](./image.png)",
    "/x/notes.md"
  );
  const document = new JSDOM(html).window.document;
  assert.deepEqual(
    [...document.querySelectorAll("a")].map((element) => element.getAttribute("href")),
    ["./spec.md", "https://example.com", "mailto:hi@example.com"]
  );
  assert.equal(document.querySelector("img").getAttribute("src"), "./image.png");
});

test("a markdown review is rendered, flagged, and never writable", async (t) => {
  const { port, token, dispose } = await start();
  t.after(async () => dispose());

  const file = path.join(tmp, "notes.md");
  fs.writeFileSync(file, "# Notes\n\nFirst draft.\n\nSee [the spec](./spec.md).\n");
  fs.writeFileSync(path.join(tmp, "spec.md"), "# Spec\n\nDetails.\n");

  const opened = await openResponse({ port: port, token: token }, file);
  assert.equal(opened.status, 200);
  const { key, sessionId } = JSON.parse(opened.raw);
  const scope = opened.body;

  await t.test("the artifact route serves rendered html with the sdk injected", async () => {
    const registered = await request(port, token, {
      method: "POST",
      route: `/api/session/${sessionId}/render`,
      body: { key, generation: 1 },
    });
    assert.equal(registered.status, 200, registered.raw);
    const res = await request(port, token, { route: JSON.parse(registered.raw).path });
    assert.equal(res.status, 200);
    assert.match(res.raw, /<h1[^>]*>Notes<\/h1>/);
    assert.match(res.raw, /data-eh-sdk/);
    assert.doesNotMatch(res.raw, /# Notes/, "raw markdown syntax does not leak through");
  });

  await t.test("page state marks the page as markdown", async () => {
    const res = await request(port, token, { route: `/api/page/${key}` });
    assert.equal(JSON.parse(res.raw).markdown, true);
  });

  await t.test("saves are refused so the source file survives", async () => {
    const recorded = await mutate({ port, token }, scope, "record-edit", {
      pageKey: key, content: content("First draft.", "Overwritten"),
    });
    const res = await conversationRequest({ port, token }, {
      operation: "save-edit", reviewId: scope.reviewId, entryKey: scope.entryKey,
      requestId: "markdown-refused", expectedVersion: (await read({ port, token }, scope)).version,
      pageKey: key, editId: recorded.value.editId, editVersion: 1,
      expectedSourceHash: (await read({ port, token }, scope, "read-page", { pageKey: key })).page.sourceHash,
      html: "<!DOCTYPE html><html><body>overwritten</body></html>",
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "SAVE_EVIDENCE_CONFLICT");
    assert.equal(fs.readFileSync(file, "utf8"), "# Notes\n\nFirst draft.\n\nSee [the spec](./spec.md).\n");
  });

  await t.test("navigation can follow a link to a sibling markdown page", async () => {
    const res = await request(port, token, {
      method: "POST",
      route: `/api/session/${sessionId}/resolve-target`,
      body: { href: "./spec.md" },
    });
    assert.equal(res.status, 200);
    const joined = await mutate({ port, token }, scope, "join-page", { target: JSON.parse(res.raw).target });
    const nav = await request(port, token, { method: "POST", route: `/api/session/${sessionId}/goto`,
      body: { key: joined.value.pageKey } });
    assert.equal(nav.status, 200);
    const page = JSON.parse((await request(port, token, { route: `/api/session/${sessionId}/page` })).raw).page;
    assert.equal(page.markdown, true);
    assert.equal(page.filename, "spec.md");
  });

  await t.test("messages on a Markdown page ship with its true source identity and explicit intent", async () => {
    const message = await thread({ port, token }, scope, { body: "Add a timeline.", intent: "request-change",
      target: { kind: "selection", anchor: { quote: "First draft.", prefix: "", suffix: "" } } });
    await send({ port, token }, scope, [message]);
    const work = (await read({ port, token }, scope, "poll")).submission;
    assert.deepEqual(work.pageKeys, [key]);
    assert.equal((await read({ port, token }, scope, "read-page", { pageKey: key })).page.target.path, fs.realpathSync(file));
    assert.equal(work.messages[0].message.body, "Add a timeline.");
    assert.equal(work.messages[0].message.intent, "request-change");
  });
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("an external Markdown write refreshes rendering without losing unsent edits", { timeout: 10000 }, async (t) => {
  const review = await start();
  t.after(() => review.dispose());
  const { port, token } = review;
  const file = path.join(tmp, "external-write.md");
  fs.writeFileSync(file, "# Original\n\nBefore.\n");
  const opened = JSON.parse((await openResponse({ port: port, token: token }, file)).raw);
  const recorded = await mutate(review, opened, "record-edit", { pageKey: opened.key,
    content: content("Before.", "My unsent wording.", { after_html: "<strong>My unsent wording.</strong>" }) });
  const message = await thread(review, opened, { body: "Keep my feedback.",
    target: { kind: "selection", anchor: { quote: "Before.", prefix: "", suffix: "" } } });
  const edits = (await list(review, opened, "edits")).items;
  fs.writeFileSync(file, "# External revision\n\nBefore, reformatted.\n");

  const deadline = Date.now() + 5000;
  while (!review.store.page(opened.key).pristine.includes("External revision") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(review.store.page(opened.key).pristine, /External revision/);
  assert.deepEqual((await list(review, opened, "edits")).items, edits);
  const registered = JSON.parse((await request(port, token, {
    method: "POST", route: `/api/session/${opened.sessionId}/render`,
    body: { key: opened.key, generation: 1 },
  })).raw);
  assert.match((await request(port, token, { route: registered.path })).raw, /External revision/);
  await send(review, opened, [message], [{ pageKey: opened.key, editId: recorded.value.editId, version: 1 }]);
  const work = (await read(review, opened, "poll")).submission;
  assert.equal(work.edits[0].content.after, "My unsent wording.");
  assert.equal(work.edits[0].content.after_html, "<strong>My unsent wording.</strong>");
  assert.equal(work.messages[0].message.body, "Keep my feedback.");
  assert.match(fs.readFileSync(file, "utf8"), /External revision/);
});
