export async function threadAction(page, card, name) {
  const button = card.getByRole("button", { name, exact: true });
  if (await button.isVisible()) return button;
  const item = page.getByRole("menuitem", { name, exact: true });
  if (await item.isVisible()) return item;
  await card.getByRole("button", { name: "Conversation actions", exact: true }).click();
  return item;
}
