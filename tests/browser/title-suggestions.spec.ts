import { expect } from "@playwright/test";
import { db } from "./database-fixture";
import { test } from "./member-fixture";
import { randomUUID } from "node:crypto";
import { browserConfig } from "../../scripts/browser-config";

const { changeRelationship, updateTitleActivity } =
  await import("../../src/server/social");

const errors: string[] = [];
test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /hydration|didn.t match/i.test(message.text())
    )
      errors.push(message.text());
  });
});
test.afterEach(() => expect(errors).toEqual([]));

async function person(username: string, displayName = username) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")
    VALUES($1,$2,$3,true,now(),now())`,
    [id, displayName, `${username}@example.test`],
  );
  await db.query(
    "INSERT INTO profile(user_id,username,display_name) VALUES($1,$2,$3)",
    [id, username, displayName],
  );
  return id;
}
async function friend(a: string, b: string) {
  await changeRelationship(a, b, "request");
  await changeRelationship(b, a, "accept");
}
async function setup(viewer: string, prefix: string) {
  const direct = await person(
    `${prefix}direct`,
    "Alexandria With A Particularly Long Display Name For Testing",
  );
  await friend(viewer, direct);
  await db.query(`INSERT INTO title(id,kind,tmdb_id,name,overview) VALUES
    ('movie:987654','movie',987654,'The Lantern Room','A fictional coastal story.'),
    ('tv:998001','tv',998001,'The Harbor Signal','A fictional mystery.')
    ON CONFLICT(id) DO NOTHING`);
  await updateTitleActivity(direct, "movie:987654", "recommended", true);
  // Second-degree signals need at least three friends of friends per action.
  const hidden: string[] = [];
  const privateItems: string[] = [];
  for (const suffix of ["one", "two", "three"]) {
    const hiddenName = `${prefix}hidden${suffix}`;
    const second = await person(hiddenName);
    await friend(direct, second);
    await updateTitleActivity(second, "movie:987654", "recommended", true);
    privateItems.push(
      await updateTitleActivity(second, "tv:998001", "want_to_watch", true),
    );
    hidden.push(second, hiddenName);
  }
  return { viewer, direct, second: hidden[0], hidden, privateItems };
}

test("suggestion tiles explain the circle without revealing second-degree identities", async ({
  page,
  signIn,
}) => {
  const { viewer, direct, hidden, privateItems } = await setup(
    await signIn(page, "tileviewer"),
    "tile",
  );
  const [privateItem] = privateItems;
  const response = await page.goto("/search");
  const initialHTML = await response!.text();
  const grid = page.getByRole("region", {
    name: "Title suggestions",
    exact: true,
  });
  await expect(grid.getByRole("link")).toHaveCount(2);
  await expect(
    grid.getByText("3 friends of friends also recommend this.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    grid.getByText("3 friends of friends want to watch this.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(grid.getByText(/Alexandria.*recommends this\./)).toBeVisible();
  await expect(grid.getByRole("button")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^(All|Movies|TV)$/ }),
  ).toHaveCount(0);
  await expect(grid.getByText(/^(Movie|TV show)$/)).toHaveCount(0);
  const apiResponse = await page.request.get(
    "/api/screenr/screen?path=%2Fsearch",
  );
  expect(apiResponse.status()).toBe(200);
  const payload = await apiResponse.text();
  for (const value of [...hidden, ...privateItems]) {
    expect(initialHTML).not.toContain(value);
    expect(payload).not.toContain(value);
  }
  expect(
    (
      await page.request.get(
        `/api/screenr/screen?path=${encodeURIComponent(`/conversations/${privateItem}`)}`,
      )
    ).status(),
  ).toBe(404);
  const deniedReply = await page.request.post("/api/screenr/comment", {
    headers: { origin: browserConfig.baseURL },
    data: {
      conversation: privateItem,
      body: "Not my friend's thread",
      spoiler: false,
    },
  });
  expect(deniedReply.status()).toBe(404);
  const another = await person("tileotherhidden");
  await friend(direct, another);
  await updateTitleActivity(another, "movie:987654", "recommended", true);
  await updateTitleActivity(another, "tv:998001", "want_to_watch", true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    grid.getByText("4 friends of friends also recommend this.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    grid.getByText("4 friends of friends want to watch this.", { exact: true }),
  ).toBeVisible();
  const updatedPayload = await (
    await page.request.get("/api/screenr/screen?path=%2Fsearch")
  ).text();
  expect(updatedPayload).not.toContain(another);
  expect(updatedPayload).not.toContain("tileotherhidden");
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await grid.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    for (const link of await grid.getByRole("link").all()) {
      const tile = await link.boundingBox();
      expect(tile!.x + tile!.width).toBeLessThanOrEqual(width);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `.cache/title-suggestions-${width}.png`,
      fullPage: true,
    });
  }
  const tile = grid.getByRole("link").filter({
    has: page.getByRole("heading", { name: "The Lantern Room", exact: true }),
  });
  await tile.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    /\/titles\/movie\/987654\?from=suggestion_recommendation$/,
  );
  await page
    .getByRole("button", { name: "+ Want to watch", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "✓ Want to watch", exact: true }).first(),
  ).toBeVisible();
  // Usage telemetry attributes the save to the tile naming a recommending friend.
  expect(
    (
      await db.query(
        "SELECT surface,friend_recommending FROM want_to_watch_save WHERE user_id=$1",
        [viewer],
      )
    ).rows,
  ).toEqual([
    { surface: "suggestion_recommendation", friend_recommending: true },
  ]);
  await page.goBack();
  await expect(grid.getByRole("link")).toHaveCount(1);
  await updateTitleActivity(viewer, "movie:987654", "want_to_watch", false);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(grid.getByRole("link")).toHaveCount(2);
});

test("search submission and clearing switch modes without applying suggestion exclusions to search", async ({
  page,
  signIn,
}) => {
  const { viewer } = await setup(await signIn(page, "searchviewer"), "search");
  await page.goto("/search");
  const input = page.getByLabel("Movie or show title");
  const grid = page.getByRole("region", {
    name: "Title suggestions",
    exact: true,
  });
  const results = page.getByRole("region", {
    name: "Search results",
    exact: true,
  });
  await input.fill("The Lantern Room");
  await expect(grid.getByRole("link")).toHaveCount(2);
  await input.press("Enter");
  await expect(
    results.getByRole("heading", { name: "The Lantern Room", exact: true }),
  ).toBeVisible();
  await expect(grid).toHaveCount(0);
  await input.fill("Edited but not submitted");
  await expect(
    results.getByRole("heading", { name: "The Lantern Room", exact: true }),
  ).toBeVisible();
  await input.fill("");
  await expect(grid.getByRole("link")).toHaveCount(2);
  await updateTitleActivity(viewer, "movie:987654", "recommended", true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(grid.getByRole("link")).toHaveCount(1);
  await input.fill("The Lantern Room");
  await input.press("Enter");
  await expect(
    results.getByRole("heading", { name: "The Lantern Room", exact: true }),
  ).toBeVisible();
  await input.fill("   ");
  await expect(grid.getByRole("link")).toHaveCount(1);
  await input.fill("no matching suggestions");
  await input.press("Enter");
  await expect(
    results.getByText("No matches. Try a different title.", { exact: true }),
  ).toBeVisible();
  await expect(grid).toHaveCount(0);
});

test("the submitted search stays in the URL through Back, Forward, reload, and navigation", async ({
  page,
  signIn,
}) => {
  await setup(await signIn(page, "urlviewer"), "url");
  await page.goto("/search");
  const input = page.getByLabel("Movie or show title");
  const grid = page.getByRole("region", {
    name: "Title suggestions",
    exact: true,
  });
  const results = page.getByRole("region", {
    name: "Search results",
    exact: true,
  });
  const result = (name: string) =>
    results.getByRole("heading", { name, exact: true });
  const searchURL = (query = "") =>
    new RegExp(`/search${query && `\\?q=${query.replaceAll(" ", "\\+")}`}$`);
  async function expectSearch(query: string, title: string) {
    await expect(page).toHaveURL(searchURL(query));
    await expect(input).toHaveValue(query);
    await expect(result(title)).toBeVisible();
    await expect(results.getByRole("heading")).toHaveCount(1);
  }
  await input.fill("first suggestion fixture");
  await input.press("Enter");
  await expectSearch("first suggestion fixture", "The First Signal");
  await input.fill("second suggestion fixture");
  await input.press("Enter");
  await expectSearch("second suggestion fixture", "The Second Signal");
  await input.fill("An unsubmitted draft");
  await expect(page).toHaveURL(searchURL("second suggestion fixture"));
  await results.getByRole("link").click();
  await expect(page).toHaveURL(/\/titles\/movie\/998012$/);
  await page.goBack();
  await expectSearch("second suggestion fixture", "The Second Signal");
  await page.goBack();
  await expectSearch("first suggestion fixture", "The First Signal");
  await page.goBack();
  await expect(page).toHaveURL(searchURL());
  await expect(input).toHaveValue("");
  await expect(results).toHaveCount(0);
  await expect(grid.getByRole("link")).toHaveCount(2);
  await page.goForward();
  await expectSearch("first suggestion fixture", "The First Signal");
  await page.reload();
  await expectSearch("first suggestion fixture", "The First Signal");
  // Clearing replaces the current entry, so Forward still reaches later ones.
  await input.fill("");
  await expect(page).toHaveURL(searchURL());
  await expect(grid.getByRole("link")).toHaveCount(2);
  await page.goForward();
  await expectSearch("second suggestion fixture", "The Second Signal");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Find a title" })
    .click();
  await expect(page).toHaveURL(searchURL());
  await expect(input).toHaveValue("");
  await expect(results).toHaveCount(0);
  await expect(grid.getByRole("link")).toHaveCount(2);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("clearing or submitting a newer search prevents late responses from replacing the current view", async ({
  page,
  signIn,
}) => {
  await setup(await signIn(page, "raceviewer"), "race");
  await page.goto("/search");
  const input = page.getByLabel("Movie or show title");
  const holds = new Map<
    string,
    {
      ready: ReturnType<typeof deferred>;
      release: ReturnType<typeof deferred>;
      finished: ReturnType<typeof deferred>;
    }
  >();
  const hold = (query: string) => {
    const value = {
      ready: deferred(),
      release: deferred(),
      finished: deferred(),
    };
    holds.set(query, value);
    return value;
  };
  // Delay real API responses after server logic and the catalog fixture run.
  await page.route("**/api/screenr/search?**", async (route) => {
    const response = await route.fetch();
    const delayed = holds.get(
      new URL(route.request().url()).searchParams.get("q")!,
    );
    if (delayed) {
      delayed.ready.resolve();
      await delayed.release.promise;
    }
    try {
      await route.fulfill({ response });
    } finally {
      delayed?.finished.resolve();
    }
  });
  const first = hold("first suggestion fixture");
  const second = hold("second suggestion fixture");
  try {
    await input.fill("first suggestion fixture");
    await input.press("Enter");
    await first.ready.promise;
    await input.fill("second suggestion fixture");
    await input.press("Enter");
    await second.ready.promise;
    second.release.resolve();
    await expect(
      page.getByRole("heading", { name: "The Second Signal", exact: true }),
    ).toBeVisible();
    first.release.resolve();
    await first.finished.promise;
    await expect(
      page.getByRole("heading", { name: "The First Signal", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "The Second Signal", exact: true }),
    ).toBeVisible();
    const cleared = hold("first suggestion fixture");
    await input.fill("first suggestion fixture");
    await input.press("Enter");
    await cleared.ready.promise;
    await input.fill(" ");
    const grid = page.getByRole("region", {
      name: "Title suggestions",
      exact: true,
    });
    await expect(grid.getByRole("link")).toHaveCount(2);
    cleared.release.resolve();
    await cleared.finished.promise;
    await expect(grid.getByRole("link")).toHaveCount(2);
    await expect(
      page.getByRole("region", { name: "Search results", exact: true }),
    ).toHaveCount(0);
  } finally {
    for (const value of holds.values()) value.release.resolve();
  }
});

test("relationship refreshes and failures clear social data while preserving usable search", async ({
  page,
  signIn,
}) => {
  const { viewer, direct, second } = await setup(
    await signIn(page, "refreshviewer"),
    "refresh",
  );
  await page.goto("/search");
  const input = page.getByLabel("Movie or show title");
  const grid = page.getByRole("region", {
    name: "Title suggestions",
    exact: true,
  });
  const failure = page.getByRole("alert").filter({
    hasText: "Could not reach Screenr. Check your connection and try again.",
  });
  await input.fill("A draft search");
  await changeRelationship(second, viewer, "block");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(grid.getByRole("link")).toHaveCount(1);
  await expect(grid.getByText(/friends? of (a )?friends?/)).toHaveCount(0);
  await expect(input).toHaveValue("A draft search");
  await page.route("**/api/screenr/screen?**", (route) =>
    route.abort("failed"),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(failure).toBeVisible();
  await expect(grid).toHaveCount(0);
  await expect(input).toHaveValue("A draft search");
  await input.fill("The Lantern Room");
  await input.press("Enter");
  const results = page.getByRole("region", {
    name: "Search results",
    exact: true,
  });
  await expect(
    results.getByRole("heading", { name: "The Lantern Room", exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/screenr/screen?**");
  await changeRelationship(viewer, direct, "remove");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(failure).toHaveCount(0);
  await expect(input).toHaveValue("The Lantern Room");
  await expect(results).toBeVisible();
  await input.fill("");
  await expect(
    page.getByRole("heading", { name: "No suggestions yet.", exact: true }),
  ).toBeVisible();
  await friend(viewer, direct);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(grid.getByRole("link")).toHaveCount(1);
  await page.route("**/api/screenr/search?**", (route) =>
    route.abort("failed"),
  );
  await input.fill("The Lantern Room");
  await input.press("Enter");
  await expect(failure).toBeVisible();
  await expect(
    page.getByText("No matches. Try a different title.", { exact: true }),
  ).toHaveCount(0);
  await expect(input).toHaveValue("The Lantern Room");
  await page.unroute("**/api/screenr/search?**");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    results.getByRole("heading", { name: "The Lantern Room", exact: true }),
  ).toBeVisible();
  await expect(failure).toHaveCount(0);
});
