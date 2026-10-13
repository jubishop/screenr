import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./monitored-test";

// iOS Safari zooms into a focused text field or select whose text is smaller
// than 16px, and the page stays zoomed after the field loses focus.
async function expectNoFocusZoom(page: Page, ready: Locator) {
  await expect(ready).toBeVisible();
  const controls = await page
    .locator("input:not([type=checkbox], [type=radio]), textarea, select")
    .evaluateAll((elements) =>
      elements.map((element) => ({
        name:
          (element as HTMLInputElement).labels?.[0]?.textContent ??
          element.outerHTML,
        size: parseFloat(getComputedStyle(element).fontSize),
      })),
    );
  expect(controls.length).toBeGreaterThan(0);
  for (const { name, size } of controls)
    expect.soft(size, `${page.url()}: ${name}`).toBeGreaterThanOrEqual(16);
}

test("form controls use 16px text at phone width so iOS Safari does not zoom on focus", async ({
  page,
  member,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await expectNoFocusZoom(
    page,
    page.getByLabel("Email address", { exact: true }),
  );

  const pending = await member("zoomsetup", { complete: false });
  await expectNoFocusZoom(
    pending,
    pending.getByLabel("Username", { exact: true }),
  );

  const owner = await member("zoomowner");
  await owner.goto("/search");
  await expectNoFocusZoom(
    owner,
    owner.getByLabel("Movie or show title", { exact: true }),
  );
  await owner.goto("/people");
  await expectNoFocusZoom(
    owner,
    owner.getByLabel("Exact username", { exact: true }),
  );
  await owner.goto("/invites");
  await owner
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await expectNoFocusZoom(
    owner,
    owner.getByLabel("Invitation link", { exact: true }),
  );
  await owner.goto("/account");
  await owner
    .getByRole("button", { name: "Edit profile", exact: true })
    .click();
  await expectNoFocusZoom(
    owner,
    owner.getByLabel("Display name", { exact: true }),
  );
  await owner.goto("/titles/movie/987654");
  await owner
    .getByRole("button", { name: "Start a conversation", exact: true })
    .click();
  await expectNoFocusZoom(
    owner,
    owner.getByLabel("Your comment", { exact: true }),
  );
});

// Phones would otherwise capitalize or autocorrect the first letter.
test("username fields turn off automatic capitalization and spelling correction", async ({
  member,
}) => {
  const pending = await member("capssetup", { complete: false });
  const owner = await member("capsowner");
  await owner.goto("/account");
  await owner
    .getByRole("button", { name: "Edit profile", exact: true })
    .click();
  const fields = [
    pending.getByLabel("Username", { exact: true }),
    owner.getByLabel("Username", { exact: true }),
  ];
  for (const field of fields) {
    await expect(field).toHaveAttribute("autocapitalize", "none");
    await expect(field).toHaveAttribute("spellcheck", "false");
  }
  await owner.goto("/people");
  const search = owner.getByLabel("Exact username", { exact: true });
  await expect(search).toHaveAttribute("autocapitalize", "none");
  await expect(search).toHaveAttribute("spellcheck", "false");
});
