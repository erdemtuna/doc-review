import test from "node:test";
import assert from "node:assert/strict";
import { hasSdk, injectSdk, stripSdk } from "../src/html-transform.js";

const PAGE = `<!DOCTYPE html>
<html><head><title>Spec</title></head>
<body>
<h1>Hello</h1>
</body></html>`;

const LOCALHOST_PAGE = `<!DOCTYPE html>
<html><head><title>Spec</title><link rel="stylesheet" href="/_next/app.css"></head>
<body><a href="/wiki/lesson">Lesson</a><img src="./hero.png"><script src="/_next/app.js"></script></body></html>`;

test("injectSdk adds exactly one bootstrap immediately after the doctype", () => {
  const out = injectSdk(PAGE, "abc123");
  const tags = out.match(/<script[^>]*data-eh-sdk/g) || [];
  assert.equal(tags.length, 1);
  assert.match(
    out,
    /^<!DOCTYPE html><script data-eh-sdk data-eh-bootstrap type="module" data-generation="0" data-page-key="abc123" src="\/sdk\.js"><\/script>/
  );
});

test("injectSdk gives only its trusted script the supplied nonce", () => {
  const page = '<!DOCTYPE html><html><body><script>parent.postMessage({type:"eh:html"}, "*")</script></body></html>';
  const out = injectSdk(page, "abc123", {
    nonce: "one-time-permission",
    generation: 7,
    pageKey: "page-key",
  });
  assert.match(
    out,
    /<script data-eh-sdk data-eh-bootstrap type="module" nonce="one-time-permission" data-generation="7" data-page-key="page-key" src="\/sdk\.js"><\/script>/
  );
  assert.equal((out.match(/nonce="one-time-permission"/g) || []).length, 1);
  assert.match(out, /<script>parent\.postMessage/, "the authored script remains in the source representation");
  assert.equal(stripSdk(out), page, "saving restores the original script bytes");
});

test("injecting twice never stacks tags", () => {
  const once = injectSdk(PAGE, "abc123");
  const twice = injectSdk(once, "abc123");
  assert.equal((twice.match(/data-eh-sdk/g) || []).length, 1);
});

test("stripSdk restores the original bytes", () => {
  assert.equal(stripSdk(injectSdk(PAGE, "k")), PAGE);
});

test("a saved file never keeps the injected tag", () => {
  const saved = stripSdk(injectSdk(PAGE, "k"));
  assert.equal(hasSdk(saved), false);
  assert.ok(!saved.includes("sdk.js"));
});

test("fragments without a doctype get the script first", () => {
  const out = injectSdk("<h1>bare</h1>", "k");
  assert.ok(hasSdk(out));
  assert.equal(out.indexOf("data-eh-sdk") < out.indexOf("<h1>"), true);
  assert.equal(stripSdk(out).trim(), "<h1>bare</h1>");
});

test("a page with only </html> gets the script first", () => {
  const out = injectSdk("<html><h1>x</h1></html>", "k");
  assert.ok(out.indexOf("data-eh-sdk") < out.indexOf("<html>"));
});

test("localhost pages get absolute assets, their real route, and one sdk", () => {
  const options = {
    src: "http://127.0.0.1:4444/sdk.js",
    baseHref: "http://localhost:3000/wiki?view=course#lesson",
    nonce: "channel",
    generation: 2,
    pageKey: "page-key",
  };
  const once = injectSdk(LOCALHOST_PAGE, "k", options);
  const twice = injectSdk(once, "k", options);
  assert.equal((twice.match(/<base[^>]*data-eh-sdk/g) || []).length, 0);
  assert.equal((twice.match(/<script[^>]*data-eh-sdk/g) || []).length, 1);
  assert.equal((twice.match(/<script[^>]*data-eh-route/g) || []).length, 1);
  assert.ok(twice.includes('history.replaceState(null,"",location.origin+"/wiki?view=course#lesson")'));
  assert.ok(twice.indexOf("data-eh-route") < twice.indexOf("<title>"));
  assert.ok(twice.includes('href="http://localhost:3000/_next/app.css"'));
  assert.ok(twice.includes('src="http://localhost:3000/_next/app.js"'));
  assert.ok(twice.includes('src="http://localhost:3000/hero.png"'));
  assert.ok(twice.includes('<a href="/wiki/lesson">'));
  assert.ok(twice.includes('src="http://127.0.0.1:4444/sdk.js"'));
  assert.ok(!stripSdk(twice).includes("data-eh-route"));
});

test("hostile trailing raw-text markup cannot swallow the bootstrap", () => {
  const page = '<!DOCTYPE html><html><body><script>const tpl = "</body>";</script><p>x</p></body></html>';
  const out = injectSdk(page, "k");
  assert.ok(out.indexOf("data-eh-sdk") < out.indexOf("<html>"));
  assert.equal(stripSdk(out), page);
});

test("leading comments stay before the doctype and do not trigger quirks mode", () => {
  const page = "\uFEFF <!-- license -->\n<!doctype html><html><body><p>x</p></body></html>";
  const out = injectSdk(page, "k");
  assert.match(out, /^\uFEFF <!-- license -->\n<!doctype html><script data-eh-sdk/);
  assert.equal(stripSdk(out), page);
});

test("stripSdk removes only the injected bootstrap tag byte-for-byte", () => {
  const authored = '<script data-eh-sdk type="module" src="/sdk.js"></script><p>x</p>';
  assert.equal(stripSdk(authored), authored);
  assert.equal(stripSdk(injectSdk(authored, "k")), authored);
});
