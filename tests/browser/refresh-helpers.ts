import { type Page, type Response } from "@playwright/test";

// A screen read of `path`, such as "/account" or "/?item=…", or of any path.
function readOf(path?: string) {
  return (response: Response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/screenr/screen" &&
      (path === undefined || url.searchParams.get("path") === path)
    );
  };
}

export async function nextAccountRefresh(page: Page) {
  await page.waitForResponse(readOf("/account"));
}

export async function nextAccountRefreshForPath(page: Page, path: string) {
  await page.waitForResponse(readOf(path));
}

async function finishRead(
  page: Page,
  path: string | undefined,
  start: () => Promise<unknown>,
) {
  const read = page.waitForResponse(readOf(path));
  await start();
  await (await read).finished();
}

// A refresh aborts any read still in flight, and Playwright never finishes a
// response whose request then fails. Waiting for a poll's or an earlier
// read's response could therefore hang
// (https://github.com/jubishop/screenr/issues/197). These helpers pause
// polling and wait for the page's first read, so each later read is one the
// test starts.
export async function openWithoutPolling(page: Page, path: string) {
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  // Reads of the previous page don't count.
  await finishRead(page, path, () => page.goto(path));
}

// Returning to a page opened with openWithoutPolling reads it once.
export async function refreshOnFocus(page: Page) {
  await finishRead(page, undefined, () =>
    page.evaluate(() => window.dispatchEvent(new Event("focus"))),
  );
}
