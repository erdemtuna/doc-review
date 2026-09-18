import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { REVIEW_PALETTE, BRAND_COLORS } from "../src/review-palette.js";
import { generateReviewTheme, generateThemeSources, replaceRegion, validatePalette } from "../scripts/generate-review-theme.js";

const source = await readFile(new URL("../src/sdk.js", import.meta.url), "utf8");

test("canonical palette generation is deterministic, checked and embedded without a browser import", async () => {
  const first = generateThemeSources(source);
  assert.equal(first.sdk, source);
  assert.deepEqual(generateThemeSources(first.sdk), first);
  assert.equal(first.shell, await readFile(new URL("../src/ui/styles/review-colors.css", import.meta.url), "utf8"));
  await generateReviewTheme({ check: true });
  assert.equal(BRAND_COLORS.tile, "#17685F");
  assert.equal(BRAND_COLORS.bubble, "#FFFDF7");
  assert.doesNotMatch(source, /import .*review-palette/);
  assert.doesNotMatch(source, /data-dark|darkSurface|activeBox\.style\.borderColor/);
  assert.match(first.shell, /--diff-accent: var\(--review-modified-foreground\)/);
  assert.doesNotMatch(first.shell, /--overlay:/);
  for (const colors of Object.values(REVIEW_PALETTE)) {
    for (const kind of ["added", "removed", "modified"]) {
      assert.equal(colors[`review-count-${kind}`], colors[`review-${kind}-foreground`]);
      assert.notEqual(colors[`review-${kind}`], colors[`review-${kind}-foreground`]);
    }
  }
});

test("generator rejects missing, duplicate and reversed boundaries and unresolved colors", () => {
  assert.throws(() => generateThemeSources(source.replace("/* REVIEW_THEME_SHADOW_START */", "")), /markers: SHADOW/);
  assert.throws(() => generateThemeSources(source + "\n/* REVIEW_THEME_DOCUMENT_END */"), /markers: DOCUMENT/);
  assert.throws(() => replaceRegion("/* REVIEW_THEME_X_END *//* REVIEW_THEME_X_START */", "X", ""), /markers: X/);
  assert.throws(() => generateThemeSources(source + "var(--review-unknown-role)"), /Unresolved SDK palette role/);
  const invalid = structuredClone(REVIEW_PALETTE);
  invalid.light.primary = "url(https://invalid.test)";
  assert.throws(() => validatePalette(invalid), /Invalid palette entry: light.primary/);
  delete invalid.light.primary;
  assert.throws(() => validatePalette(invalid), /matching roles/);
});

test("check mode reports stale or missing generated outputs without rewriting them", async () => {
  const directory = path.resolve(".test-state", `review-theme-${process.pid}`);
  await mkdir(path.join(directory, "src", "ui", "styles"), { recursive: true });
  try {
    await writeFile(path.join(directory, "src", "sdk.js"), source);
    await assert.rejects(generateReviewTheme({ check: true, directory }), /Stale generated review theme/);
    await generateReviewTheme({ directory });
    await generateReviewTheme({ check: true, directory });
    const css = path.join(directory, "src", "ui", "styles", "review-colors.css");
    await writeFile(css, "stale");
    await assert.rejects(generateReviewTheme({ check: true, directory }), /Stale generated review theme/);
    assert.equal(await readFile(css, "utf8"), "stale");
    await generateReviewTheme({ directory });
    await writeFile(path.join(directory, "src", "sdk.js"), source.replace("#F5F2EA", "#000000"));
    await assert.rejects(generateReviewTheme({ check: true, directory }), /Stale generated review theme/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function luminance(hex) {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + .05) / (values[1] + .05);
}

test("opaque text and essential boundaries meet contrast targets in both themes", () => {
  for (const [theme, palette] of Object.entries(REVIEW_PALETTE)) {
    for (const [ink, background] of [
      ["foreground", "background"], ["card-foreground", "card"], ["muted-foreground", "card"],
      ["primary-foreground", "primary"], ["accent-foreground", "accent"],
      ["destructive", "card"], ["destructive-foreground", "destructive"],
      ["annotation-foreground", "annotation-background"], ["annotation-foreground", "annotation-active"],
      ["review-added-foreground", "review-added"], ["review-removed-foreground", "review-removed"],
      ["review-modified-foreground", "review-modified"],
    ]) assert.ok(contrast(palette[ink], palette[background]) >= 4.5, `${theme}: ${ink}/${background}`);
    for (const [ink, background] of [["input", "card"], ["ring", "card"], ["annotation-border", "annotation-background"]]) {
      assert.ok(contrast(palette[ink], palette[background]) >= 3, `${theme}: ${ink}/${background}`);
    }
  }
});
