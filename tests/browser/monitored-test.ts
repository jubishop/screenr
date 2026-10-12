import { expect, type Page } from "@playwright/test";
import { test as memberTest, watchErrors } from "./member-fixture";

// One scenario runs at a time in each worker. Reset its error list in a
// test-scoped auto fixture so every importing spec gets the same lifecycle.
const browserErrors: string[] = [];

export function monitorErrors(page: Page) {
  watchErrors(page, browserErrors);
}

export const test = memberTest.extend<{ browserErrors: void }>({
  browserErrors: [
    async ({ page }, use) => {
      browserErrors.length = 0;
      monitorErrors(page);
      try {
        await use();
      } finally {
        expect(browserErrors).toEqual([]);
      }
    },
    { auto: true },
  ],
});
