import { expect } from "@playwright/test";
import { db } from "./database-fixture";
import { test } from "./monitored-test";
import { prepareFriendship, userId } from "./member-fixture";
import { nextAccountRefreshForPath } from "./refresh-helpers";

// The friends feed and profiles page their histories 50 entries at a time,
// with Show older (docs/title-feed.md#paged-histories).
test("the friends feed and profiles show older entries with Show older, and a link opens an entry older than the page", async ({
  member,
}) => {
  const owner = await member("pageowner");
  const reader = await member("pagereader");
  await prepareFriendship(owner, reader);
  // Sixty posts, a minute apart: post 1 is the oldest.
  const posts = (
    await db.query<{ id: string }>(
      `INSERT INTO discussion_post(id,owner_id,body,created_at)
      SELECT gen_random_uuid(),$1,'Older post '||n,now()-interval '1 hour'-(60-n)*interval '1 minute'
      FROM generate_series(1,60) n ORDER BY n RETURNING id`,
      [await userId(owner)],
    )
  ).rows.map((row) => row.id);
  const entries = reader.locator("[data-item-id]");
  const post = (n: number) =>
    reader.getByText(`Older post ${n}`, { exact: true });
  const older = reader.getByRole("button", { name: "Show older", exact: true });
  for (const path of ["/", "/people/pageowner"]) {
    await reader.goto(path);
    await expect(entries).toHaveCount(50);
    await expect(post(11)).toBeVisible();
    await expect(post(10)).toHaveCount(0);
    await older.click();
    // The older page shows at once, not as new activity, and focus moves
    // from Show older, which leaves with the last page, to its first entry.
    await expect(entries).toHaveCount(60);
    await expect(post(1)).toBeVisible();
    await expect(older).toHaveCount(0);
    await expect(reader.locator(`#item-${posts[9]}`)).toBeFocused();
    await expect(
      reader.getByRole("button", { name: /^New activity/ }),
    ).toHaveCount(0);
    // Later reads keep the longer window.
    await nextAccountRefreshForPath(reader, path);
    await expect(entries).toHaveCount(60);
  }

  // New activity still waits for the reader while the older entries stay.
  const added = await owner.request.post("/api/screenr/discussion-post", {
    headers: { Origin: new URL(reader.url()).origin },
    data: { body: "A brand new post", spoiler: false },
  });
  expect(added.status()).toBe(200);
  const incoming = reader.getByRole("button", { name: "New activity (1)" });
  await expect(incoming).toBeVisible();
  await expect(entries).toHaveCount(60);
  await incoming.click();
  await expect(entries).toHaveCount(61);

  // A link to an entry older than the page opens it.
  await reader.goto(`/?item=${posts[0]}`);
  const linked = reader.locator(`[data-item-id="${posts[0]}"]`);
  await expect(linked).toBeInViewport();
  await expect(entries).toHaveCount(51);
  await expect(reader.getByText("This activity is unavailable.")).toHaveCount(
    0,
  );
});
