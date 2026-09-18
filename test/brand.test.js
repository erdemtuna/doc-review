import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { brandOutputs, generateBrand } from "../scripts/generate-brand.js";
import { BRAND_COLORS } from "../src/review-palette.js";

const source = await readFile(new URL("../src/assets/doc-review.svg", import.meta.url), "utf8");
const html = await readFile(new URL("../src/chrome.html", import.meta.url), "utf8");

test("the rounded square brand and shell favicon share one fixed teal and paper asset", async () => {
  assert.deepEqual(BRAND_COLORS, { tile: "#17685F", bubble: "#FFFDF7" });
  const outputs = brandOutputs(source, BRAND_COLORS, html);
  const svg = decodeURIComponent(outputs.uri.slice("data:image/svg+xml,".length));
  assert.match(svg, /width="64" height="64" viewBox="0 0 64 64"/);
  assert.match(svg, /rx="14" fill="#17685F"/);
  assert.match(svg, /fill="#FFFDF7" fill-rule="evenodd"/);
  assert.match(svg, /M20 22H36V18L43 24L36 30V26H20Z M44 34H28V30L21 36L28 42V38H44Z/);
  assert.ok(outputs.module.includes(JSON.stringify(outputs.uri)));
  assert.ok(outputs.html.includes(`href="${outputs.uri}"`));
  assert.equal(outputs.html, html);
  await generateBrand({ check: true });
  const packaged = await readFile(new URL("../lib/chrome.html", import.meta.url), "utf8");
  assert.ok(packaged.includes(`href="${outputs.uri}"`), "packaged shell includes the same favicon without an extra route");
});

test("brand generation rejects incompatible artwork and malformed shell regions", () => {
  for (const invalid of [
    source.replace('width="64"', 'width="32"'),
    source.replace('rx="14"', 'rx="0"'),
    source.replace('fill-rule="evenodd"', 'fill-rule="nonzero"'),
    source.replace("#17685F", "#000000"),
    source.replace("<path ", '<path onload="alert(1)" '),
    source.replace("</svg>", '<image href="https://example.com/icon.png"/></svg>'),
    source.replace("</svg>", "<script>alert(1)</script></svg>"),
    source.replace("</svg>", "</svg><p>extra</p>"),
  ]) assert.throws(() => brandOutputs(invalid, BRAND_COLORS, html));
  assert.throws(() => brandOutputs(source, { tile: "url(x)", bubble: "#FFFDF7" }, html));
  assert.throws(() => brandOutputs(source, BRAND_COLORS, html.replace("<!-- brand:end -->", "")));
  assert.throws(() => brandOutputs(source, BRAND_COLORS, html + "  <!-- brand:start -->"));
});
