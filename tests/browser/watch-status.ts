import { expect, type Page } from "@playwright/test";

// The title page's watch status menu button.
export const statusButton = (page: Page) =>
  page.locator('.title-hero button[aria-haspopup="menu"]');

// Opens the status menu and chooses a status by its label, or Clear status,
// then waits for the button to show the saved choice.
export async function chooseStatus(page: Page, choice: string) {
  const button = statusButton(page);
  await button.click();
  const menu = page.getByRole("menu", { name: "Watch status" });
  await menu
    .getByRole(choice === "Clear status" ? "menuitem" : "menuitemradio", {
      name: choice,
      exact: true,
    })
    .click();
  await expect(menu).toHaveCount(0);
  await expect(button).toHaveText(
    choice === "Clear status" ? "+ Want to watch" : `✓ ${choice}`,
  );
  await expect(button).toBeEnabled();
}
