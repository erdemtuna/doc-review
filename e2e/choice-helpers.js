import { expect } from "./helpers.js";

export function choiceItem(page, value) {
  return page.getByRole("menuitemradio").and(
    page.locator(`[data-choice-value=${JSON.stringify(String(value))}]:visible`),
  );
}

export async function selectChoice(page, id, value) {
  const trigger = page.locator(id.startsWith("#") ? id : `#${id}`);
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("menu")).toHaveCount(1);
  const item = choiceItem(page, value);
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toHaveAttribute("data-value", String(value));
}

export async function expectCounts(page, added, modified, removed) {
  const counts = page.locator("#historyCounts");
  await expect(counts).toBeVisible();
  await expect(counts).toHaveText(new RegExp(`^\\s*${added}\\s*${modified}\\s*${removed}\\s*$`));
  for (const [kind, count] of [["added", added], ["modified", modified], ["removed", removed]]) {
    const name = `${count} ${kind} changes`;
    const icon = counts.getByRole("img", { name, exact: true });
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute("title", new RegExp(`${kind} changes`, "i"));
  }
}
