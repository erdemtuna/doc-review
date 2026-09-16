import test from "node:test";
import assert from "node:assert/strict";
import { analyzeDocumentExecution, documentExecutionPolicy, transformInteractiveHtml } from "../src/document-execution.js";
import { parse } from "parse5";
import { framePolicy, interactiveFileCsp, trustedFileCsp, TRUSTED_SDK_MODULE_PATHS } from "../src/frame-policy.js";
import { transformTrustedHtml } from "../src/document-trust.js";

test("plain source, escaped examples, data scripts and dormant templates keep autosave", () => {
  for (const source of [
    "<p>Plain <button>Native control</button></p>",
    "<!-- <script>alert(1)</script> --><pre>&lt;img onerror=alert(1)&gt;</pre>",
    '<script type="application/json">{"script":"<script>","onclick":"x"}</script>',
    '<script type="application/ld+json">{"@context":"https://schema.org"}</script>',
    '<script type="text/plain">window.example = true;</script>',
    '<template><script>run()</script><img onerror="run()" src=x><iframe src=x></iframe></template>',
  ]) {
    assert.deepEqual(analyzeDocumentExecution(Buffer.from(source)), {
      executionMode: "static", savePolicy: "writable", feedbackOnly: false,
    }, source);
  }
  assert.throws(() => analyzeDocumentExecution(null), TypeError);
});

test("active authored executable surfaces including foreign content disable writes", () => {
  for (const source of [
    "<script>run()</script>", '<script type="module">run()</script>',
    '<script type="TEXT/JAVASCRIPT">run()</script>', '<script language="javascript">run()</script>',
    '<button oNcLiCk="run()">Click</button>', '<body onload="run()">',
    '<a href="&#x6a;ava&#x09;script:run()">Run</a>',
    '<a href="&#x01; javascript:run()">Run</a>',
    '<form action="javascript:run()"></form>', '<button formaction="javascript:run()">Run</button>',
    '<svg><script>run()</script></svg>', '<svg><a xlink:href="javascript:run()">Run</a></svg>',
    '<svg onload="run()"></svg>', '<math><a href="javascript:run()">Run</a></math>',
    '<template><script>run()</script></template><button onclick="instantiate()">Run</button>',
  ]) {
    assert.deepEqual(analyzeDocumentExecution(source), {
      executionMode: "interactive", savePolicy: "feedback-only", feedbackOnly: true,
    }, source);
  }
});

test("application indicators share the existing bounded dependency transform", () => {
  for (const source of [
    '<script src="app.js"></script>', '<svg><script xlink:href="app.js"></script></svg>',
    '<script type="importmap">{}</script>', '<script type="speculationrules">{}</script>',
    '<iframe srcdoc="<p>app"></iframe>', '<object data="app.html"></object>', '<embed src="app">',
    '<link rel="modulepreload" href="app.js">', '<link rel="preload" as="worker" href="app.js">',
    '<script>instantiate()</script><template><script src="app.js"></script></template>',
  ]) {
    assert.equal(analyzeDocumentExecution(source).executionMode, "application", source);
    assert.ok(transformInteractiveHtml(source).unsupportedDependencies.length, source);
  }
});

test("recovery changes execution but never promotes scripted source to writable", () => {
  assert.deepEqual(documentExecutionPolicy({ kind: "file" }, "<script>run()</script>", "static"), {
    executionMode: "static", savePolicy: "feedback-only", feedbackOnly: true,
  });
  assert.deepEqual(documentExecutionPolicy({ kind: "file", markdown: true }), {
    executionMode: "static", savePolicy: "feedback-only", feedbackOnly: true,
  });
  assert.deepEqual(documentExecutionPolicy({ kind: "url" }), {
    executionMode: "application", savePolicy: "feedback-only", feedbackOnly: true,
  });
});

function nodes(document) {
  return [document, ...(document.childNodes || []).flatMap(nodes), ...(document.content ? nodes(document.content) : [])];
}

test("the shared transform removes dependencies and policy overrides but preserves inline interaction", () => {
  const transformed = transformInteractiveHtml(`<!doctype html><html><head>
    <base href="https://evil.example/"><meta http-equiv=Content-Security-Policy content="script-src *">
    <script SRC=&#x2f;external.js>ignored()</script><script type=module src='other.js'></script>
    <link rel=modulepreload href=module.js><script type=importmap>{"imports":{}}</script>
    </head><body><button onclick="document.body.dataset.clicked='yes'">Tab</button>
    <script>window.inline = true;</script><script type=module>window.module = true;</script>
    <template><script src=hidden.js></script></template>
    <iframe srcdoc="<script>bad()</script>"></iframe><object data=other.html></object>
    <svg><script href="https://evil.example/svg.js"></script></svg>
    </body></html>`);
  const parsed = nodes(parse(transformed.html));
  assert.equal(parsed.filter((node) => node.tagName === "script" && node.attrs.some((attribute) => attribute.name === "src")).length, 0);
  assert.equal(parsed.filter((node) => ["iframe", "object", "base"].includes(node.tagName)).length, 0);
  assert.match(transformed.html, /window.inline = true/);
  assert.match(transformed.html, /window.module = true/);
  assert.match(transformed.html, /onclick=/);
  assert.match(transformed.notice, /feedback-only/);
  assert.ok(transformed.unsupportedDependencies.some((item) => item.source === "/external.js"));
  assert.ok(transformed.unsupportedDependencies.some((item) => item.source === "https://evil.example/svg.js"));
  assert.doesNotMatch(transformed.html, /trust-notice|Trusted HTML/);
  assert.match(transformInteractiveHtml("<frameset><frame src=app.html></frameset>").html, /<body><\/body>/);
  const bounded = transformInteractiveHtml("<script src=other.js></script>".repeat(150));
  assert.equal(bounded.unsupportedDependencies.length, 101);
  assert.deepEqual(bounded.unsupportedDependencies.at(-1), { kind: "additional-dependencies", count: 50 });
});

test("interactive files remain opaque and authorize only exact immutable SDK module routes", () => {
  assert.equal(transformTrustedHtml, transformInteractiveHtml);
  assert.equal(trustedFileCsp, interactiveFileCsp);
  const csp = interactiveFileCsp("http://127.0.0.1:1234");
  assert.match(csp, /script-src 'unsafe-inline'/);
  assert.match(csp, /script-src-attr 'unsafe-inline'/);
  assert.match(csp, /worker-src 'none'/);
  assert.doesNotMatch(csp, /strict-dynamic|nonce-|unsafe-eval/);
  const script = csp.split(";")[1];
  assert.equal(script.trim().split(/\s+/).length, TRUSTED_SDK_MODULE_PATHS.length + 2);
  assert.throws(() => interactiveFileCsp("http://127.0.0.1:1234/artifacts"), TypeError);
  assert.doesNotMatch(framePolicy({ kind: "file", savePolicy: "feedback-only" }, "http://127.0.0.1:1234").sandbox, /allow-same-origin/);
});
