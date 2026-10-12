import { expect, type Locator, type Page } from "@playwright/test";

// Answer every request to one Screenr write with a server error.
export async function failAction(page: Page, action: string, error: string) {
  await page.route(`**/api/screenr/${action}`, (route) =>
    route.fulfill({ status: 503, json: { error } }),
  );
}

// Center a control before pressing it, so a message beneath it stays on screen.
export async function press(control: Locator) {
  await control.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  await control.click();
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${locator} has no layout box`);
  return bounds;
}

// A failed action's message sits inside its container, directly beneath the
// listed controls, and on screen. It describes the control that failed. The
// page shows no other alert unless `alerts` counts other failed controls.
// The screen is saved to `.cache/<screenshot>-<width>.png` for review.
export async function expectErrorBeside(
  page: Page,
  {
    container,
    failed,
    controls,
    message,
    alerts = 1,
    screenshot,
  }: {
    container: Locator;
    failed: Locator;
    controls: Locator[];
    message: string;
    alerts?: number;
    screenshot: string;
  },
) {
  const alert = container.getByRole("alert");
  await expect(alert).toHaveText(message);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(alerts);
  await expect(failed).toHaveAccessibleDescription(message);
  await failed.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  await expect(alert).toBeInViewport();
  const area = await box(container);
  const bounds = await box(alert);
  expect(bounds.x).toBeGreaterThanOrEqual(area.x - 1);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(
    area.y + area.height + 1,
  );
  const lowest = Math.max(
    ...(await Promise.all(controls.map(box))).map(
      (control) => control.y + control.height,
    ),
  );
  expect(bounds.y).toBeGreaterThanOrEqual(lowest - 1);
  expect(bounds.y - lowest).toBeLessThanOrEqual(24);
  const { width } = page.viewportSize()!;
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(width);
  await page.screenshot({ path: `.cache/${screenshot}-${width}.png` });
}
