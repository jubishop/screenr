import { expect, type Locator, type Page } from "@playwright/test";

// Playwright waits for a pending page load before it inspects the page, so a
// test can't check the page an action leaves while the next one loads.
// Instead this cancels the next page load of `pathname`, which leaves the
// current page in place, as a slow next page would. `url` resolves with the
// load's URL, which the test opens itself to continue. The page's context
// must block service workers, since Playwright can't route the page loads
// they answer.
export async function stayOnPage(page: Page, pathname: string) {
  let answered!: (url: string) => void;
  const url = new Promise<string>((resolve) => (answered = resolve));
  let done = false;
  await page.route(
    (url) => url.pathname === pathname,
    async (route) => {
      if (done || route.request().resourceType() !== "document")
        return route.fallback();
      done = true;
      // Chromium shows no error page for a canceled page load.
      await route.abort("aborted");
      answered(route.request().url());
    },
  );
  return { url };
}

// Counts the requests a page sends to a path, such as
// "/api/auth/sign-in/email-otp".
export function countRequests(page: Page, pathname: string) {
  let count = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === pathname) count++;
  });
  return () => count;
}

// A control whose action opens another page stays pending until that page
// replaces it: it keeps focus, reports itself unavailable, and ignores
// another press. Count its requests once the next page shows, since a
// repeated press would have sent its request by then.
export async function expectPendingWhileLeaving(page: Page, control: Locator) {
  await expect(control).toBeFocused();
  await expect(control).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
  await expect(control).toBeFocused();
  await expect(control).toHaveAttribute("aria-disabled", "true");
}
