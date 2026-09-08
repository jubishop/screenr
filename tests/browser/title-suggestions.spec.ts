import { test, expect, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { browserConfig } from "../../scripts/browser-config";

process.env.DATABASE_URL = browserConfig.databaseURL;
process.env.BETTER_AUTH_URL = browserConfig.baseURL;
process.env.BETTER_AUTH_SECRET =
  "screenr-browser-test-only-secret-at-least-32-characters";
const { db } = await import("../../src/server/db");
const { createInvitation } = await import("../../src/server/invitations");
const { changeRelationship, updateTitleActivity } =
  await import("../../src/server/social");

test.afterAll(() => db.end());
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
  return page.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "Trailer fixture" }),
  );
});
test.afterEach(() => expect(errors).toEqual([]));

async function signup(page: Page, username: string) {
  const { token } = await createInvitation(null, 1);
  const email = `${username}@example.test`;
  await page.goto(`/join/${token}`);
  await page.getByLabel("Email address").fill(email);
  await page
    .getByRole("button", { name: "Send sign-in code", exact: true })
    .click();
  await expect(page.getByLabel("Sign-in code", { exact: true })).toBeVisible();
  const filename = createHash("sha256").update(email).digest("hex");
  const { otp } = JSON.parse(
    await readFile(`.cache/mail/${filename}.json`, "utf8"),
  );
  await page.getByLabel("Sign-in code", { exact: true }).fill(otp);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Display name").fill(username);
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByRole("button", { name: "Join Screenr", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Better with friends." }),
  ).toBeVisible();
  return (
    await db.query("SELECT user_id FROM profile WHERE username=$1", [username])
  ).rows[0].user_id as string;
}
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
async function setup(page: Page, prefix: string) {
  const viewer = await signup(page, `${prefix}viewer`);
  const direct = await person(
    `${prefix}direct`,
    "Alexandria With A Particularly Long Display Name For Testing",
  );
  const hiddenName = `${prefix}hidden`;
  const second = await person(hiddenName);
  await friend(viewer, direct);
  await friend(direct, second);
  await db.query(`INSERT INTO title(id,kind,tmdb_id,name,overview) VALUES
    ('movie:987654','movie',987654,'The Lantern Room','A fictional coastal story.'),
    ('tv:998001','tv',998001,'The Harbor Signal','A fictional mystery.')
    ON CONFLICT(id) DO NOTHING`);
  await updateTitleActivity(direct, "movie:987654", "recommended", true);
  await updateTitleActivity(second, "movie:987654", "recommended", true);
  const privateItem = await updateTitleActivity(
    second,
    "tv:998001",
    "want_to_watch",
    true,
  );
  return { viewer, direct, second, hiddenName, privateItem };
}

test("suggestion tiles explain the circle without revealing second-degree identities", async ({
  page,
}) => {
  const { viewer, direct, second, hiddenName, privateItem } = await setup(
    page,
    "tile",
  );
  const response = await page.goto("/search");
  const initialHTML = await response!.text();
  const grid = page.getByRole("region", {
    name: "Title suggestions",
    exact: true,
  });
  await expect(grid.getByRole("link")).toHaveCount(2);
  await expect(
    grid.getByText("1 friend of a friend also recommends this.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    grid.getByText("1 friend of a friend wants to watch this.", {
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
  for (const hidden of [second, hiddenName, privateItem]) {
    expect(initialHTML).not.toContain(hidden);
    expect(payload).not.toContain(hidden);
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
    grid.getByText("2 friends of friends also recommend this.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    grid.getByText("2 friends of friends want to watch this.", { exact: true }),
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
  await expect(page).toHaveURL(/\/titles\/movie\/987654$/);
  await page
    .getByRole("button", { name: "+ Want to watch", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "✓ Want to watch", exact: true }).first(),
  ).toBeVisible();
  await page.goBack();
  await expect(grid.getByRole("link")).toHaveCount(1);
  await updateTitleActivity(viewer, "movie:987654", "want_to_watch", false);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(grid.getByRole("link")).toHaveCount(2);
});

test("search submission and clearing switch modes without applying suggestion exclusions to search", async ({
  page,
}) => {
  const { viewer } = await setup(page, "search");
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("clearing or submitting a newer search prevents late responses from replacing the current view", async ({
  page,
}) => {
  await setup(page, "race");
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
}) => {
  const { viewer, direct, second } = await setup(page, "refresh");
  await page.goto("/search");
  const input = page.getByLabel("Movie or show title");
  const grid = page.getByRole("region", {
    name: "Title suggestions",
    exact: true,
  });
  const failure = page
    .getByRole("alert")
    .filter({ hasText: "Failed to fetch" });
  await input.fill("A draft search");
  await changeRelationship(second, viewer, "block");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(grid.getByRole("link")).toHaveCount(1);
  await expect(grid.getByText(/friend of a friend/)).toHaveCount(0);
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
