import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ICON_NODES, iconMarkup } from "../src/icons.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the committed selected Lucide module is deterministic and allowlisted", () => {
  const before = fs.readFileSync(path.join(root, "src", "icons.js"), "utf8");
  const generated = spawnSync(process.execPath, ["scripts/generate-icons.js"], { cwd: root });
  assert.equal(generated.status, 0, generated.stderr.toString());
  assert.equal(fs.readFileSync(path.join(root, "src", "icons.js"), "utf8"), before);
  assert.deepEqual(Object.keys(ICON_NODES), [
    "eye", "pencil", "chevronDown", "messageSquarePlus", "messages",
    "send", "trash", "moreHorizontal", "x", "check", "sun", "moon",
  ]);
  assert.match(iconMarkup("eye"), /^<svg/);
  assert.match(iconMarkup("eye"), /aria-hidden="true"/);
});
