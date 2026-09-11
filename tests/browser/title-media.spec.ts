import { expect } from "@playwright/test";
import { Pool } from "pg";
import { browserConfig } from "../../scripts/browser-config";
import { expectTextContrast } from "./contrast";
import { test } from "./monitored-test";

test("title watch availability shows US categories, empty results, failures, and older data on mobile and desktop", async ({
  member,
}) => {
  const page = await member("availabilityviewer");
  await page.route("https://image.tmdb.org/t/p/w92/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#667765"/></svg>',
    }),
  );
  const availability = page.getByRole("region", { name: "Where to watch" });
  for (const kind of ["movie", "tv"]) {
    await page.goto(`/titles/${kind}/987660`);
    await expect(availability).toBeVisible();
    await expect(
      availability.getByText("United States", { exact: true }),
    ).toBeVisible();
    await expect(availability.getByRole("heading", { level: 3 })).toHaveText([
      "Subs",
      "Free",
    ]);
    const subs = availability.getByRole("group", { name: "Subs", exact: true });
    const free = availability.getByRole("group", { name: "Free", exact: true });
    await expect(subs.getByRole("listitem")).toHaveText([
      "AMC+",
      "An exceptionally long service name with aVeryLongUnbrokenPartForNarrowScreens",
      "Apple TV",
      "Harbor Stream",
      "Netflix",
      "Qello Concerts by Stingray",
    ]);
    await expect(free.getByRole("listitem")).toHaveText([
      "Apple TV",
      "Coast TV",
      "Lantern Free",
      "YouTube",
    ]);
    await expect(subs.getByText("Apple TV", { exact: true })).toHaveCount(1);
    await expect(availability.getByText("Harbor Store")).toHaveCount(0);
    await expect(
      availability.getByText(/via Amazon|via Apple|via Roku|with ads/),
    ).toHaveCount(0);
    await expect(
      subs
        .getByRole("listitem")
        .filter({ hasText: "Harbor Stream" })
        .locator("img"),
    ).toHaveAttribute(
      "src",
      "https://image.tmdb.org/t/p/w92/test-provider.png",
    );
    await expect(
      subs
        .getByRole("listitem")
        .filter({ hasText: "An exceptionally long" })
        .locator("img"),
    ).toHaveCount(0);
    await expect(availability.getByText("Canada only")).toHaveCount(0);
    await expect(
      availability.getByRole("link", { name: "Viewing options on TMDB" }),
    ).toHaveAttribute(
      "href",
      `https://www.themoviedb.org/${kind}/987660/watch?locale=US`,
    );
    await expect(
      availability.getByRole("link", { name: "JustWatch" }),
    ).toHaveAttribute("href", "https://www.justwatch.com/");
    await expect(
      availability.getByText("Availability may vary by season."),
    ).toHaveCount(kind === "tv" ? 1 : 0);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await availability.scrollIntoViewIfNeeded();
      const bounds = await availability.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      if (kind === "movie") {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: `.cache/watch-availability-${width}.png`,
          fullPage: true,
        });
      }
    }
  }
  await page.goto("/titles/movie/987661");
  await expect(
    availability.getByText(
      "No subscription or free options are listed for the US.",
    ),
  ).toBeVisible();
  await expect(availability.getByText("Canada only")).toHaveCount(0);
  await page.goto("/titles/movie/987662");
  await expect(
    availability.getByText(
      "Viewing options could not be loaded. Please check again later.",
    ),
  ).toBeVisible();
  await expect(
    availability.getByText(
      "No subscription or free options are listed for the US.",
    ),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "The Lantern Room", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Around this title" }),
  ).toBeVisible();
  const pool = new Pool({ connectionString: browserConfig.databaseURL });
  try {
    await page.request.post(`${browserConfig.catalogURL}/availability-failure`);
    await pool.query(
      "UPDATE title_availability SET fetched_at='2020-01-02T12:00:00Z', refresh_after=now()-interval '1 second' WHERE title_id='movie:987660'",
    );
    await page.goto("/titles/movie/987660");
    await expect(
      availability.getByText("Could not refresh viewing options."),
    ).toBeVisible();
    await expect(
      availability.getByText("Harbor Stream", { exact: true }),
    ).toBeVisible();
    await expect(availability.locator("time")).toHaveAttribute(
      "datetime",
      "2020-01-02T12:00:00.000Z",
    );
    await expect(availability.locator("time")).toContainText("2020");
    await pool.query(
      "UPDATE title_availability SET availability=$1, fetched_at=now(), refresh_after=now()+interval '1 day' WHERE title_id='movie:987660'",
      [
        {
          link: null,
          providers: {
            rent: [
              { provider_id: 8, provider_name: "Netflix", logo_path: null },
            ],
            buy: [
              { provider_id: 350, provider_name: "Apple TV", logo_path: null },
            ],
          },
        },
      ],
    );
    await page.reload();
    await expect(
      availability.getByText(
        "No subscription or free options are listed for the US.",
      ),
    ).toBeVisible();
    await expect(availability.getByRole("group")).toHaveCount(0);
    await pool.query(
      "UPDATE title_availability SET availability=$1 WHERE title_id='movie:987660'",
      [
        {
          link: null,
          providers: {
            ads: [
              {
                provider_id: 2243,
                provider_name: "Apple TV Amazon Channel",
                logo_path: null,
              },
            ],
          },
        },
      ],
    );
    await page.reload();
    await expect(availability.getByRole("heading", { level: 3 })).toHaveText([
      "Free",
    ]);
    await expect(availability.getByRole("listitem")).toHaveText(["Apple TV"]);
    // Exercise the real HTTP failure on an older successful empty result too.
    await pool.query(
      "UPDATE title_availability SET availability=$1, fetched_at='2020-01-02T12:00:00Z', refresh_after=now()-interval '1 second' WHERE title_id='movie:987660'",
      [
        {
          link: null,
          providers: {
            rent: [
              { provider_id: 8, provider_name: "Netflix", logo_path: null },
            ],
            buy: [
              { provider_id: 350, provider_name: "Apple TV", logo_path: null },
            ],
          },
        },
      ],
    );
    await page.reload();
    await expect(
      availability.getByText("Could not refresh viewing options."),
    ).toBeVisible();
    await expect(
      availability.getByText(
        "No subscription or free options were listed when last checked.",
      ),
    ).toBeVisible();
    await expect(
      availability.getByText("Harbor Stream", { exact: true }),
    ).toHaveCount(0);
  } finally {
    await page.request.delete(
      `${browserConfig.catalogURL}/availability-failure`,
    );
    await pool.end();
  }
  await page.goto("/");
  await expect(availability).toHaveCount(0);
  await page.context().close();
});

test("title trailers fit desktop and mobile, send an origin referrer, and omit unavailable players", async ({
  member,
}) => {
  const page = await member("trailerviewer");
  const embeds: string[] = [];
  await page.route("https://www.youtube.com/embed/**", async (route) => {
    embeds.push((await route.request().allHeaders()).referer);
    await route.fulfill({
      contentType: "text/html",
      body: "Trailer player fixture",
    });
  });
  const response = await page.goto("/titles/movie/987654");
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  const player = page.getByTitle("The Lantern Room trailer: Official trailer", {
    exact: true,
  });
  await expect(player).toBeVisible();
  await expect(player).toHaveAttribute(
    "src",
    "https://www.youtube.com/embed/Abcdef_1234?autoplay=0&playsinline=1",
  );
  await expect(
    page.getByRole("link", { name: "Watch on YouTube" }),
  ).toHaveAttribute("href", "https://www.youtube.com/watch?v=Abcdef_1234");
  await expect.poll(() => embeds).toEqual([`${browserConfig.baseURL}/`]);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectTextContrast(page.locator(".title-hero .overview"));
    await expectTextContrast(
      page.getByText("A private circle", { exact: true }),
    );
    const bounds = await player.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(200);
    expect(bounds!.height).toBeGreaterThanOrEqual(200);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
  }
  await page.waitForResponse(
    (response) =>
      response.url().includes("/api/screenr/screen?") &&
      response.status() === 200,
  );
  expect(embeds).toHaveLength(1); // Background refresh must not reload playback.
  for (const path of ["/movie/987655", "/movie/987656", "/tv/987657"]) {
    await page.goto(`/titles${path}`);
    await expect(
      page.getByRole("heading", { name: "The Lantern Room", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Around this title" }),
    ).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Watch on YouTube" }),
    ).toHaveCount(0);
  }
  await page.context().close();
});
