import { test as base, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

export const test = base.extend({
  review: [
    async ({}, use, workerInfo) => {
      const root = path.join(
        process.cwd(),
        ".playwright-state",
        `worker-${workerInfo.workerIndex}-${process.pid}`
      );
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
      process.env.DOC_REVIEW_STATE_DIR = path.join(root, "state");
      const { start } = await import("../src/server.js");
      const server = await start();
      try {
        await use({ ...server, root });
      } finally {
        await server.dispose();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
});

export { expect };

export async function reviewApi(review, route, { method = "GET", body } = {}) {
  const response = await fetch(`http://127.0.0.1:${review.port}${route}`, {
    method,
    headers: {
      "x-doc-review-token": review.token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    raw,
    json: () => JSON.parse(raw),
  };
}

export async function openReview(page, review, target) {
  const opened = await reviewApi(review, "/api/session", {
    method: "POST",
    body: { target },
  });
  expect(opened.status, opened.raw).toBe(200);
  const session = opened.json();
  await page.goto(`http://127.0.0.1:${review.port}${session.path}`);
  await expect(page.locator("#frame")).toHaveAttribute("src", /\/artifact\/r_[a-f0-9]+\/index\.html/);
  return session;
}

export async function waitForSdk(page) {
  const frame = page.frameLocator("#frame");
  await expect(page.locator("#frame")).toHaveAttribute("data-sdk-ready", "true");
  return frame;
}

export async function enterEditMode(page) {
  const frame = await waitForSdk(page);
  await page.locator("#modeButton").click();
  await page.getByRole("menuitemradio", { name: /^Edit/ }).click();
  await expect(frame.locator("body")).toHaveAttribute("contenteditable", "true");
  return frame;
}

export function writeFile(review, relative, contents) {
  const file = path.join(review.root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}
