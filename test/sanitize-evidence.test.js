import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, unzipSync } from "fflate";
import { sanitizeDirectory, sanitizeText, sanitizeValue } from "../scripts/sanitize-evidence.js";

test("diagnostic ZIPs preserve references and redact credentials, storage and frame nonces", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sanitized-evidence-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const trace = { body: ["BODY", { "data-token": "private", nonce: "correlation" }],
    headers: [{ name: "x-doc-review-token", value: "private" }], localStorage: [{ name: "secret", value: "private" }] };
  const png = Buffer.from([137, 80, 78, 71, 0]);
  fs.writeFileSync(path.join(directory, "trace.zip"), zipSync({
    "trace.trace": Buffer.from(`${JSON.stringify(trace)}\n`),
    "resources/snapshot.html": Buffer.from('<body data-token="private"><script nonce="correlation"></script>'),
    "resources/image.png": png,
  }));
  sanitizeDirectory(directory);
  const entries = unzipSync(fs.readFileSync(path.join(directory, "trace.zip")));
  assert.deepEqual(Buffer.from(entries["resources/image.png"]), png);
  assert(!Buffer.from(entries["trace.trace"]).toString().includes("private"));
  assert(!Buffer.from(entries["resources/snapshot.html"]).toString().includes("correlation"));
  assert.equal(sanitizeValue({ authorization: "private" }).authorization, "REDACTED");
  fs.writeFileSync(path.join(directory, "unsafe.zip"), zipSync({ "../outside.json": Buffer.from("{}") }));
  assert.throws(() => sanitizeDirectory(directory), /Unsafe trace entry/);
});

test("serialized request bodies and plain header logs cannot retain synthetic credentials", () => {
  const value = sanitizeValue({
    postData: JSON.stringify({ token: "private-token", nested: { password: "private-password" } }),
    url: "http://127.0.0.1/review?token=private-query&entry=keep",
    log: 'Authorization: Bearer private-auth\nX-Doc-Review-Token: private-header\nCookie: private-cookie',
    snapshot: 'window.config = {"token":"private-inline","nonce":"private-nonce"};',
  });
  assert(!JSON.stringify(value).includes("private-"));
  assert(value.url.endsWith("&entry=keep"));
  assert.deepEqual(JSON.parse(value.postData), { token: "REDACTED", nested: { password: "REDACTED" } });
  assert.equal(sanitizeText('{"secret":"escaped\\\\\\"private-value"}'), '{"secret":"REDACTED"}');
  assert.equal(sanitizeValue("[not json"), "[not json");
});

test("Playwright serialized arguments redact credentials without invalidating the value descriptors", () => {
  const argument = { value: { o: [
    { k: "token", v: { s: "private-token" } },
    { k: "headers", v: { a: [{ o: [{ k: "name", v: { s: "Authorization" } }, { k: "value", v: { s: "private-header" } }] }] } },
    { k: "entry", v: { s: "keep" } },
  ] }, handles: [] };
  const sanitized = sanitizeValue(argument);
  assert(!JSON.stringify(sanitized).includes("private-"));
  assert.deepEqual(sanitized.value.o[0].v, { s: "REDACTED" });
  assert.deepEqual(sanitized.value.o[1].v.a[0].o[1].v, { s: "REDACTED" });
  assert.deepEqual(sanitized.value.o[2], argument.value.o[2]);
});
