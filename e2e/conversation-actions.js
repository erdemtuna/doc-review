export async function threadAction(page, card, name) {
  await card.getByRole("button", { name: "Conversation actions", exact: true }).click();
  return page.getByRole("menuitem", { name, exact: true });
}
