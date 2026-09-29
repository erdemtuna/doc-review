export async function threadAction(page, card, name) {
  if (["Resolve", "Reopen", "Back to Feedback", "Collapse conversation", "Expand conversation"].includes(name)) {
    return card.getByRole("button", { name, exact: true });
  }
  await card.getByRole("button", { name: "Conversation actions", exact: true }).click();
  return page.getByRole("menuitem", { name, exact: true });
}
