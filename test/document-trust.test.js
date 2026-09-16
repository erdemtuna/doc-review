import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "parse5";
import { DocumentTrustStore, documentSourceHash, transformTrustedHtml } from "../src/document-trust.js";
import { framePolicy, trustedFileCsp, TRUSTED_SDK_MODULE_PATHS } from "../src/frame-policy.js";
import { reviewConfiguration } from "../src/review-mode.js";

function fixture(t) {
  const directory = path.resolve(".trust-tests", randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    try { fs.rmdirSync(path.dirname(directory)); } catch {}
  });
  const target = path.join(directory, "document.html");
  const bytes = Buffer.from("\uFEFF<!doctype html>\r\n<p>Original</p>");
  fs.writeFileSync(target, bytes);
  return { target, bytes, directory, store: new DocumentTrustStore({ rootStateDir: directory }) };
}

test("trust is explicit, persists, and matches exact original bytes, target, and policy", (t) => {
  const { target, bytes, directory, store } = fixture(t);
  assert.equal(store.status(target, bytes).trusted, false);
  assert.equal(fs.existsSync(store.directory), false);
  assert.throws(() => store.grant(target, bytes), { code: "STALE_TRUST_APPROVAL" });
  const granted = store.grant(target, bytes, documentSourceHash(bytes));
  assert.equal(granted.trusted, true);
  assert.equal(granted.canonicalTarget, fs.realpathSync(target));
  assert.equal(granted.savePolicy, "feedback-only");
  const restarted = new DocumentTrustStore({ rootStateDir: directory });
  assert.equal(restarted.status(target, bytes).trusted, true);
  assert.equal(restarted.status(path.join(directory, ".", "document.html"), bytes).trusted, true);
  for (const changed of [Buffer.from(bytes.toString().replace("\r\n", "\n")), Buffer.from(bytes.toString().replace("\uFEFF", "")), Buffer.from("other")]) {
    assert.equal(restarted.status(target, changed).trusted, false);
    assert.throws(() => restarted.grant(target, changed, granted.sourceHash), { code: "STALE_TRUST_APPROVAL" });
  }
  const another = path.join(directory, "copy.html");
  fs.writeFileSync(another, bytes);
  assert.equal(restarted.status(another, bytes).trusted, false);
  assert.equal(new DocumentTrustStore({ rootStateDir: directory, policyVersion: 2 }).status(target, bytes).trusted, false);
  restarted.revoke(target, bytes);
  assert.equal(store.status(target, bytes).trusted, false);
  assert.equal(new DocumentTrustStore({ rootStateDir: directory }).status(target, bytes).trusted, false);
  assert.equal(fs.readdirSync(store.directory).filter((name) => name.endsWith(".tmp")).length, 0);
});

test("trust refuses decoded strings and non-files and fails closed on corrupt decisions", (t) => {
  const { target, bytes, directory, store } = fixture(t);
  assert.throws(() => store.status(target, bytes.toString()), TypeError);
  assert.throws(() => store.status(directory, bytes), TypeError);
  assert.throws(() => store.status("https://example.com/doc.html", bytes), TypeError);
  store.grant(target, bytes, documentSourceHash(bytes));
  fs.writeFileSync(store.decisionPath(store.identity(target, bytes)), "{broken");
  assert.equal(store.status(target, bytes).trusted, false);
});

test("separate document decisions do not overwrite one another", (t) => {
  const { target, bytes, directory, store } = fixture(t);
  const other = path.join(directory, "another.html");
  fs.writeFileSync(other, bytes);
  const concurrent = new DocumentTrustStore({ rootStateDir: directory });
  store.grant(target, bytes, documentSourceHash(bytes));
  concurrent.grant(other, bytes, documentSourceHash(bytes));
  store.revoke(target, bytes);
  assert.equal(concurrent.status(target, bytes).trusted, false);
  assert.equal(store.status(other, bytes).trusted, true);
});

function nodes(document) {
  return [document, ...(document.childNodes || []).flatMap(nodes), ...(document.content ? nodes(document.content) : [])];
}

test("the HTML parser removes external dependency elements but preserves inline interaction", () => {
  const transformed = transformTrustedHtml(`<!doctype html><html><head>
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
  assert.match(transformTrustedHtml("<frameset><frame src=app.html></frameset>").html, /<body><\/body>/);
});

test("trusted file policy remains opaque, feedback-only, and authorizes only exact SDK module routes", () => {
  const csp = trustedFileCsp("http://127.0.0.1:1234");
  assert.match(csp, /script-src 'unsafe-inline'/);
  assert.match(csp, /script-src-attr 'unsafe-inline'/);
  assert.match(csp, /worker-src 'none'/);
  assert.doesNotMatch(csp, /strict-dynamic|nonce-|unsafe-eval/);
  const script = csp.split(";")[1];
  assert.equal(script.trim().split(/\s+/).length, TRUSTED_SDK_MODULE_PATHS.length + 2);
  assert.throws(() => trustedFileCsp("http://127.0.0.1:1234/artifacts"), TypeError);
  const page = { kind: "file", trustMode: "trusted-file" };
  assert.doesNotMatch(framePolicy(page, "http://127.0.0.1:1234").sandbox, /allow-same-origin/);
  assert.deepEqual(reviewConfiguration(page, "edit"), { mode: "edit", savePolicy: "feedback-only" });
  assert.deepEqual(reviewConfiguration({ kind: "file" }, "edit"), { mode: "edit", savePolicy: "writable" });
});
