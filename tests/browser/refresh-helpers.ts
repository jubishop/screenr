import {
  expect,
  type Locator,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";

// A screen read of `path`, such as "/account" or "/?item=…", or of any path.
function readOf(path?: string) {
  return (read: Request | Response) => {
    const url = new URL(read.url());
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

// Unchanged screen reads answer 304 and render nothing. Scenarios that check
// what a rendered refresh keeps, such as drafts and focus, drop the held
// version, so the next `times` reads, or all of them, return and render the
// whole screen, as a change would. Routes added later still apply first.
export async function renderRefreshes(page: Page, times?: number) {
  await page.route(
    "**/api/screenr/screen?**",
    (route) => {
      const headers = route.request().headers();
      delete headers["if-none-match"];
      return route.fallback({ headers });
    },
    { times },
  );
}

// A refresh aborts any read still in flight, and Playwright never finishes a
// response whose request then fails. Waiting for a poll's or an earlier
// read's response could therefore hang
// (https://github.com/jubishop/screenr/issues/197). These helpers pause
// polling, so each read is one the test starts. The page load brings the
// first screen, so opening the page returns to it once to confirm the page
// is interactive.
export async function openWithoutPolling(page: Page, path: string) {
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  await page.goto(path);
  await refreshOnReturn(page);
}

// Returning to a page opened with openWithoutPolling reads it once and
// renders the whole screen, as a change would. Before the page is
// interactive, returning reads nothing, so the test returns again.
export async function refreshOnReturn(page: Page) {
  await renderRefreshes(page, 1);
  for (let attempt = 0; attempt < 5; attempt++) {
    const started = page
      .waitForRequest(readOf(), { timeout: 2000 })
      .catch(() => null);
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    const read = await started;
    if (read) {
      await (await read.response())?.finished();
      return;
    }
  }
  throw new Error("Returning to the page did not read its screen");
}

// On a page opened with openWithoutPolling, returning to it reads it once,
// and this read fails. The failure lasts until the test reads again.
const readFailure = (page: Page) =>
  page.getByRole("main").locator(".error").first();
export async function failOneRead(page: Page) {
  await page.route(
    "**/api/screenr/screen?**",
    (route) => route.abort("failed"),
    { times: 1 },
  );
  await refreshOnReturn(page);
  await expect(readFailure(page)).toContainText("Could not reach Screenr.");
}
// The next read succeeds and clears the failure.
export async function readAgain(page: Page) {
  await refreshOnReturn(page);
  await expect(readFailure(page)).toHaveCount(0);
}

// On a page opened with openWithoutPolling, a failed read hides `content`.
// The confirmation that `open` opens stays, alone, with Cancel focused. Its
// action waits, sending nothing, and Cancel still closes it, for good. Kept
// through a failed read, the action works after the next read; the caller
// presses it.
export async function keepThroughFailedRead(
  page: Page,
  {
    open,
    question,
    action,
    content,
  }: { open: Locator; question: string; action: string; content: Locator },
) {
  const group = page.getByRole("group", { name: question, exact: true });
  const confirm = group.getByRole("button", { name: action, exact: true });
  const cancel = group.getByRole("button", { name: "Cancel", exact: true });
  let writes = 0;
  const count = (request: Request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.startsWith("/api/screenr/")
    )
      writes++;
  };
  await open.click();
  await expect(cancel).toBeFocused();
  page.on("request", count);
  await failOneRead(page);
  await expect(content).toHaveCount(0);
  await expect(cancel).toBeFocused();
  await expect(confirm).toHaveAttribute("aria-disabled", "true");
  await expect(cancel).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("Shift+Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Enter");
  await cancel.click();
  await expect(group).toHaveCount(0);
  await readAgain(page);
  await expect(group).toHaveCount(0);
  page.off("request", count);
  expect(writes).toBe(0);

  await open.click();
  await failOneRead(page);
  await expect(cancel).toBeFocused();
  await readAgain(page);
  await expect(content).toBeVisible();
  await expect(cancel).toBeFocused();
  await expect(confirm).toHaveAttribute("aria-disabled", "false");
  return confirm;
}

// React reports each commit to the DevTools hook, also in production builds,
// so the count shows whether a refresh rendered the page again.
export function countCommits(page: Page) {
  return page.addInitScript(() => {
    const target = window as unknown as Record<string, unknown> & {
      commits: number;
    };
    target.commits = 0;
    target.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      inject: () => 1,
      onCommitFiberRoot: () => target.commits++,
      onCommitFiberUnmount: () => {},
      checkDCE: () => {},
    };
  });
}
export const commits = (page: Page) =>
  page.evaluate(() => (window as unknown as { commits: number }).commits);

// Advances a paused clock one polling interval and returns that poll's read,
// the first response that `matches`. A poll that comes due while the last
// read is still finishing is skipped, so the clock advances again.
export async function nextPoll(
  page: Page,
  matches: (response: Response) => boolean,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const read = page
      .waitForResponse(matches, { timeout: 5000 })
      .catch(() => null);
    await page.clock.runFor(3000);
    const response = await read;
    if (response) {
      await response.finished();
      return response;
    }
  }
  throw new Error("No read after three polling intervals");
}
