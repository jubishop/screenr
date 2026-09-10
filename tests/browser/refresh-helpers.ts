import { type Page } from "@playwright/test";

export async function nextAccountRefresh(page: Page) {
  await page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/screenr/screen" &&
      url.searchParams.get("path") === "/account"
    );
  });
}

export async function nextAccountRefreshForPath(page: Page, path: string) {
  await page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/screenr/screen" &&
      url.searchParams.get("path") === path
    );
  });
}
