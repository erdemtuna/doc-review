import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve("src", "ui", "styles", "tokens.css"), "utf8");

function luminance(hex: string) {
  const channels = [1, 3, 5].map((index) => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (values[1]! + 0.05) / (values[0]! + 0.05);
}

const textPairs = [
  ["foreground", "background"], ["card-foreground", "card"],
  ["popover-foreground", "popover"], ["primary-foreground", "primary"],
  ["secondary-foreground", "secondary"], ["muted-foreground", "muted"],
  ["muted-foreground", "card"], ["accent-foreground", "accent"],
  ["destructive-foreground", "destructive"], ["destructive", "card"],
  ["review-added-foreground", "review-added"], ["review-removed-foreground", "review-removed"],
  ["review-modified-foreground", "review-modified"],
] as const;

describe("semantic token contrast", () => {
  const light = css.match(/\.review-ui\s*\{([^}]+)\}/)?.[1];
  const dark = css.match(/:root\[data-theme="dark"\] \.review-ui\s*\{([^}]+)\}/)?.[1];
  if (!light || !dark) throw new Error("Both theme token definitions are required.");
  for (const [theme, block] of [["light", light], ["dark", dark]]) {
    const colors = Object.fromEntries([...block!.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)]
      .map((match) => [match[1], match[2]]));
    for (const [foreground, background] of textPairs) {
      it(`${theme}: ${foreground} on ${background} meets normal-text AA`, () => {
        expect(contrast(colors[foreground]!, colors[background]!)).toBeGreaterThanOrEqual(4.5);
      });
    }
    it(`${theme}: focus ring contrasts with canvas and cards`, () => {
      expect(contrast(colors.ring!, colors.background!)).toBeGreaterThanOrEqual(3);
      expect(contrast(colors.ring!, colors.card!)).toBeGreaterThanOrEqual(3);
      expect(contrast(colors.input!, colors.card!)).toBeGreaterThanOrEqual(3);
    });
  }
});
