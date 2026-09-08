import { test, expect } from "@playwright/test";
import { expectTextContrast } from "./contrast";

for (const width of [390, 1440]) {
  test(`secondary sign-in text meets normal-text contrast on both backgrounds at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/login");
    const cardText = page.getByText("Welcome back.", { exact: false });
    const card = await expectTextContrast(cardText);
    const paper = await expectTextContrast(
      page.getByRole("link", { name: "Catalog credits", exact: true }),
    );
    expect(card.background).not.toEqual(paper.background);
    await expectTextContrast(
      page.getByText("BETTER WITH FRIENDS", { exact: true }),
    );
    await expectTextContrast(
      page.getByText("or use an email code", { exact: true }),
    );
    await expectTextContrast(
      page.getByText("No password to remember.", { exact: false }),
    );
    const heading = await expectTextContrast(
      page.getByRole("heading", { level: 1 }),
    );
    expect(heading.ratio).toBeGreaterThan(card.ratio);
    await page.screenshot({
      path: `.cache/contrast-sign-in-${width}.png`,
      fullPage: true,
    });
  });
}
