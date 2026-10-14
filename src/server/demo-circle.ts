import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { eraseAccounts } from "./account-deletion";
import { demoFriendDomain, reviewerEmail } from "./auth";
import { ensureTitle } from "./catalog";
import { addComment } from "./comments";
import { transaction } from "./db";
import { saveReview } from "./reviews";
import {
  updateTitleActivity,
  updateTopTen,
  updateWatchStatus,
} from "./title-actions";

// The closed circle that Apple's beta review signs in to
// (docs/ios-app.md#isolated-demo-circle-for-apple-review--2026-10-13): the
// reviewer and three demo friends, who are friends only with one another.
// Demo profiles and real members never see each other. Seeding replaces every
// demo account, and everything demo accounts made, with a fresh circle.
const members = {
  reviewer: {
    email: reviewerEmail,
    username: "demo_reviewer",
    name: "App Reviewer",
  },
  maya: {
    email: `maya@${demoFriendDomain}`,
    username: "demo_maya",
    name: "Maya",
  },
  theo: {
    email: `theo@${demoFriendDomain}`,
    username: "demo_theo",
    name: "Theo",
  },
  priya: {
    email: `priya@${demoFriendDomain}`,
    username: "demo_priya",
    name: "Priya",
  },
};
export const demoFriendCount = Object.keys(members).length - 1;

// Real TMDB titles that the catalog resolves, all suitable for any audience.
const titles = {
  paddington2: "movie:346648",
  spiritedAway: "movie:129",
  princessBride: "movie:2493",
  hiddenFigures: "movie:381284",
  tedLasso: "tv:97546",
  planetEarth2: "tv:68595",
};

export async function seedDemoCircle() {
  // Resolve every title first, so a catalog failure changes nothing.
  for (const title of Object.values(titles)) await ensureTitle(title);
  const ids = await transaction(async (client) => {
    await refuseOutsiders(client);
    await removeDemoCircle(client);
    return createMembers(client);
  });
  await addActivity(ids);
}

// A real member's account or username is never replaced.
async function refuseOutsiders(client: PoolClient) {
  const accounts = Object.values(members);
  const { rows } = await client.query<{ taken: string }>(
    `SELECT u.email AS taken FROM "user" u LEFT JOIN profile p ON p.user_id=u.id
    WHERE u.email=ANY($1) AND p.demo IS NOT TRUE
    UNION ALL SELECT username FROM profile WHERE username=ANY($2) AND NOT demo`,
    [
      accounts.map((member) => member.email),
      accounts.map((member) => member.username),
    ],
  );
  if (rows.length)
    throw new Error(
      `${rows.map((row) => row.taken).join(", ")} already belongs to a member outside the demo circle. Seeding never replaces it.`,
    );
}

// Deletes every demo account, including people who joined through a demo
// invitation, and everything they made, as account deletion does. The
// circle is closed, so nothing a real member made refers to it.
async function removeDemoCircle(client: PoolClient) {
  const ids = (
    await client.query<{ ids: string[] }>(
      "SELECT coalesce(array_agg(user_id),'{}') AS ids FROM profile WHERE demo",
    )
  ).rows[0].ids;
  await eraseAccounts(client, ids);
}

async function createMembers(client: PoolClient) {
  const ids = Object.fromEntries(
    Object.keys(members).map((key) => [
      key,
      randomBytes(24).toString("base64url"),
    ]),
  ) as Record<keyof typeof members, string>;
  for (const [key, member] of Object.entries(members)) {
    const id = ids[key as keyof typeof members];
    await client.query(
      `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")
      VALUES($1,$2,$3,true,now(),now())`,
      [id, member.name, member.email],
    );
    await client.query(
      "INSERT INTO profile(user_id,username,display_name,demo) VALUES($1,$2,$3,true)",
      [id, member.username, member.name],
    );
  }
  const everyone = Object.values(ids);
  for (const [index, one] of everyone.entries())
    for (const other of everyone.slice(index + 1))
      await client.query(
        `INSERT INTO friendship(low_id,high_id,requested_by,accepted_at)
        VALUES(least($1,$2),greatest($1,$2),$1,now())`,
        [one, other],
      );
  return ids;
}

// Recommendations, reviews, watch statuses, and conversations, made through
// the same services as members' own actions.
async function addActivity({
  reviewer,
  maya,
  theo,
  priya,
}: Record<keyof typeof members, string>) {
  const paddington = await updateTitleActivity(
    maya,
    titles.paddington2,
    "recommended",
    true,
  );
  await updateTopTen(maya, titles.paddington2, "add");
  await saveReview(
    maya,
    titles.paddington2,
    5,
    "Warm, funny, and kind from start to finish. A perfect movie night.",
    false,
  );
  await updateTitleActivity(maya, titles.planetEarth2, "want_to_watch", true);

  await updateTitleActivity(theo, titles.spiritedAway, "recommended", true);
  await saveReview(
    theo,
    titles.spiritedAway,
    5,
    "Beautiful and imaginative. I notice something new every time I watch it.",
    false,
  );
  await updateWatchStatus(theo, titles.tedLasso, "watching");

  await updateTitleActivity(priya, titles.tedLasso, "recommended", true);
  await updateTitleActivity(priya, titles.hiddenFigures, "recommended", true);
  await updateWatchStatus(priya, titles.princessBride, "finished");
  const princessBride = await saveReview(
    priya,
    titles.princessBride,
    4,
    "Still charming, and still quotable after all these years.",
    false,
  );

  const saved = await updateTitleActivity(
    reviewer,
    titles.tedLasso,
    "want_to_watch",
    true,
  );

  const watched = await addComment(
    theo,
    paddington,
    "Watched it last weekend because of you. The barbershop scene had me laughing out loud.",
    false,
  );
  await addComment(
    maya,
    paddington,
    "Right? I could watch that scene on repeat.",
    false,
    watched,
  );
  const question = await addComment(
    priya,
    paddington,
    "Adding it to my list. Do I need to see the first one?",
    false,
  );
  await addComment(
    maya,
    paddington,
    "It helps, but this one stands on its own.",
    false,
    question,
  );
  await addComment(theo, princessBride, "As you wish!", false);
  await addComment(
    priya,
    saved,
    "You're going to love it. Give it two episodes.",
    false,
  );
}
