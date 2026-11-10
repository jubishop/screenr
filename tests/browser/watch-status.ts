import { expect, type Locator, type Page } from "@playwright/test";

// The title page's watch status menu button.
export const statusButton = (page: Page) =>
  page.locator('.title-hero button[aria-haspopup="menu"]');

// A full feed entry's watch status icon, named for the reader's status.
export const entryStatusButton = (entry: Locator) =>
  entry.locator('.title-actions button[aria-haspopup="menu"]');

// The name of a feed entry's status icon for a status label, or for none.
export const entryStatusName = (status?: string) =>
  status ? `Watch status: ${status}` : "Watch status";

// Opens the status menu and chooses a status by its label, or Clear status,
// then waits for the button to show the saved choice. `entry` chooses from a
// full feed entry's icon instead of the title page's button.
export async function chooseStatus(
  page: Page,
  choice: string,
  entry?: Locator,
) {
  const button = entry ? entryStatusButton(entry) : statusButton(page);
  await button.click();
  const menu = (entry ?? page).getByRole("menu", { name: "Watch status" });
  await menu
    .getByRole(choice === "Clear status" ? "menuitem" : "menuitemradio", {
      name: choice,
      exact: true,
    })
    .click();
  await expect(menu).toHaveCount(0);
  const cleared = choice === "Clear status";
  if (entry)
    await expect(button).toHaveAccessibleName(
      entryStatusName(cleared ? undefined : choice),
    );
  else
    await expect(button).toHaveText(
      cleared ? "+ Want to watch" : `✓ ${choice}`,
    );
  await expect(button).toBeEnabled();
}
