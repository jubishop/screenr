import { expect, type Page } from "@playwright/test";
import { test } from "./monitored-test";
import { prepareFriendship, userId } from "./member-fixture";
import { db } from "./database-fixture";
import { browserConfig } from "../../scripts/browser-config";

async function post(page: Page, action: string, data: unknown) {
  const response = await page.request.post(`/api/screenr/${action}`, {
    headers: { Origin: browserConfig.baseURL },
    data,
  });
  expect(response.status()).toBe(200);
}

// The streaming fixture titles: Night Crossing on Netflix, Night Harbor on
// AMC+, Night Orchard free on Tubi, Night Market on HBO Max, and Night Signal,
// whose availability cannot be loaded. This test's own Night Archive has
// older Netflix availability.
const archive = "movie:939313";
const newestFirst = [
  "movie:939103",
  "tv:939102",
  "tv:939105",
  "movie:939101",
  "movie:939104",
  archive,
];

test("Want to watch opens from own and friends' profiles, lists what the viewer can watch, and follows friendship", async ({
  page,
  signIn,
  member,
}) => {
  await signIn(page, "wantviewer", { displayName: "Vera Viewer" });
  const owner = await member("wantowner", { displayName: "Wren Owner" });
  const path = "/people/wantowner/want-to-watch";
  const apiPath = `/api/screenr/screen?path=${encodeURIComponent(path)}`;
  const link = page.getByRole("link", { name: "Want to watch", exact: true });
  const heading = page.getByRole("heading", {
    level: 1,
    name: "Want to watch",
    exact: true,
  });

  // A member who is not a friend gets neither the link nor the titles.
  await page.goto("/people/wantowner");
  await expect(
    page.getByRole("button", { name: "Send friend request" }),
  ).toBeVisible();
  await expect(link).toHaveCount(0);
  expect((await page.request.get(apiPath)).status()).toBe(404);

  // The viewer's own profile links to their page.
  await page.goto("/people/wantviewer");
  await link.click();
  await expect(page).toHaveURL("/people/wantviewer/want-to-watch");
  await expect(heading).toBeVisible();
  await expect(page).toHaveTitle("Want to watch · Vera Viewer · Screenr");
  await expect(
    page.getByRole("heading", { name: "No Want to watch titles yet." }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("main")
      .getByRole("link", { name: "Find a title", exact: true }),
  ).toBeVisible();

  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name,fetched_at) VALUES($1,'movie',939313,'Night Archive',now())",
    [archive],
  );
  await db.query(
    `INSERT INTO title_availability(title_id,country,availability,fetched_at,refresh_after)
    VALUES($1,'US',$2,now()-interval '2 days',now()+interval '1 day')`,
    [
      archive,
      {
        link: null,
        providers: {
          flatrate: [
            { provider_id: 8, provider_name: "Netflix", logo_path: null },
          ],
        },
      },
    ],
  );
  await prepareFriendship(page, owner);
  await post(page, "streaming-services", { serviceIds: ["service:netflix"] });
  await post(owner, "streaming-services", {
    serviceIds: ["service:amc-plus"],
  });
  for (const title of newestFirst)
    await post(owner, "activity", {
      title,
      field: "want_to_watch",
      value: true,
    });
  await db.query(
    `UPDATE feed_item f SET activity_at=now()-(o.n||' minutes')::interval
    FROM unnest($2::text[]) WITH ORDINALITY o(title_id,n)
    WHERE f.owner_id=$1 AND f.title_id=o.title_id`,
    [await userId(owner), newestFirst],
  );

  // A friend's profile links to their page, which opens from the keyboard.
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/people/wantowner");
  await expect(link).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  await page.screenshot({ path: ".cache/want-to-watch-profile-320.png" });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(path);
  await expect(heading).toBeVisible();
  await expect(page).toHaveTitle("Want to watch · Wren Owner · Screenr");
  const ready = page.getByRole("region", {
    name: "Ready to watch",
    exact: true,
  });
  const unknown = page.getByRole("region", {
    name: "Availability unknown",
    exact: true,
  });
  const count = page.getByRole("status").filter({ hasText: /to watch now$/ });
  // The viewer's Netflix counts; the owner's AMC+ does not.
  await expect(ready.getByRole("heading", { level: 3 })).toHaveText([
    "Night Orchard",
    "Night Crossing",
    "Night Archive",
  ]);
  await expect(unknown.getByRole("heading", { level: 3 })).toHaveText([
    "Night Signal",
  ]);
  await expect(count).toHaveText("3 titles to watch now");
  const card = (name: string) =>
    ready.getByRole("link").filter({ hasText: name });
  await expect(
    card("Night Orchard").getByText("Free on Tubi TV", { exact: true }),
  ).toBeVisible();
  await expect(
    card("Night Crossing").getByText("On Netflix ✓", { exact: true }),
  ).toBeVisible();
  await expect(
    card("Night Archive").getByText("Older availability. Check title details."),
  ).toBeVisible();
  await expect(
    card("Night Crossing").getByText(/Older availability/),
  ).toHaveCount(0);
  await expect(page.getByText("Night Harbor")).toHaveCount(0);
  await expect(page.getByText("Night Market")).toHaveCount(0);
  await expect(page.getByText(/AMC\+/)).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /Save your streaming services/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Want to watch/ })).toHaveCount(
    0,
  );

  // The filter works from the keyboard and keeps newest first.
  const filter = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await expect(filter("All")).toHaveAttribute("aria-pressed", "true");
  await filter("Movies").focus();
  await page.keyboard.press("Enter");
  await expect(filter("Movies")).toHaveAttribute("aria-pressed", "true");
  await expect(ready.getByRole("heading", { level: 3 })).toHaveText([
    "Night Orchard",
    "Night Crossing",
    "Night Archive",
  ]);
  await expect(unknown).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(filter("TV")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(ready).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "No TV shows to watch right now." }),
  ).toBeVisible();
  await expect(count).toHaveText("0 titles to watch now");
  await expect(unknown.getByRole("heading", { level: 3 })).toHaveText([
    "Night Signal",
  ]);
  await filter("All").click();

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await page.screenshot({
      path: `.cache/want-to-watch-${width}.png`,
      fullPage: true,
    });
  }

  // Selecting a title opens its page.
  await card("Night Crossing").press("Enter");
  await expect(page).toHaveURL("/titles/movie/939101");
  await page.goBack();
  await expect(ready.getByRole("heading", { level: 3 })).toHaveCount(3);

  // Refreshes drop a title moved off Want to watch, and follow the viewer's
  // services: without any, only free titles count, and the page says why.
  await post(owner, "activity", {
    title: "movie:939103",
    field: "want_to_watch",
    value: false,
  });
  await expect(ready.getByRole("heading", { level: 3 })).toHaveText([
    "Night Crossing",
    "Night Archive",
  ]);
  await post(page, "streaming-services", { serviceIds: [] });
  await expect(
    page.getByRole("heading", { name: "Nothing to watch right now." }),
  ).toBeVisible();
  await expect(ready).toHaveCount(0);
  const prompt = page.getByRole("link", {
    name: "Save your streaming services to see what you can watch right now.",
    exact: true,
  });
  await expect(prompt).toHaveAttribute("href", "/account#streaming-services");
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({
    path: ".cache/want-to-watch-nothing-390.png",
    fullPage: true,
  });

  // Unfriending ends access on the next read.
  await post(owner, "relationship", {
    target: await userId(page),
    action: "remove",
  });
  await expect(
    page.getByRole("alert").filter({ hasText: "Want to watch not found." }),
  ).toBeVisible();
  await expect(unknown).toHaveCount(0);
  expect((await page.reload())?.status()).toBe(404);
  await page.goto("/people/wantowner");
  await expect(
    page.getByRole("button", { name: "Send friend request" }),
  ).toBeVisible();
  await expect(link).toHaveCount(0);
});
