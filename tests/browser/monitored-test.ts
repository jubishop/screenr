import { expect, type Page } from "@playwright/test";
import { test as memberTest } from "./member-fixture";

// One scenario runs at a time in each worker. Reset its error list in a
// test-scoped auto fixture so every importing spec gets the same lifecycle.
const browserErrors: string[] = [];

export function monitorErrors(page: Page) {
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /hydration|didn.t match/i.test(message.text())
    )
      browserErrors.push(message.text());
  });
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
