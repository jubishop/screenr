import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { eraseAccounts } from "./account-deletion";
import { demoFriendDomain, reviewerEmail } from "./auth";
import { ensureTitle } from "./catalog";
import { addComment } from "./comments";
import { db, transaction } from "./db";
import { invitationHash, invitationUrl, shareToken } from "./invitations";
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

// The invitation that the App Store review notes link to, so a reviewer can
// try Sign in with Apple on a new account, which joins the circle as Maya's
// friend. Its ID is fixed, so every seed issues the same link, and it lasts
// longer than a member's invitation to outlast a review.
const demoInvitation = {
  id: "e9815162-91f9-429a-9fac-3430b8cf0c31",
  uses: 12,
  days: 90,
};

// Real TMDB titles that the catalog resolves, all suitable for any audience.
const titles = {
  paddington2: "movie:346648",
  spiritedAway: "movie:129",
  princessBride: "movie:2493",
  hiddenFigures: "movie:381284",
  tedLasso: "tv:97546",
  planetEarth2: "tv:68595",
};

// `pace` runs after each step of the activity. The iPhone fixtures pass a
// pause, so each step gets its own millisecond and the feed's order never
// rests on a tie.
export async function seedDemoCircle(
  pace: () => Promise<void> = async () => {},
) {
  // Resolve every title first, so a catalog failure changes nothing.
  for (const title of Object.values(titles)) await ensureTitle(title);
  const ids = await transaction(async (client) => {
    await refuseOutsiders(client);
    await removeDemoCircle(client);
    const ids = await createMembers(client);
    await issueInvitation(client, ids.maya);
    return ids;
  });
  await addActivity(ids, pace);
}

// The demo invitation's link, when it expires, and how many signups it has
// left, or undefined when no seed has issued it.
export async function demoInvitationStatus() {
  const { rows } = await db.query<{ expires_at: Date; remaining: number }>(
    `SELECT expires_at,max_uses-uses AS remaining FROM invitation
    WHERE id=$1 AND revoked_at IS NULL`,
    [demoInvitation.id],
  );
  if (!rows[0]) return undefined;
  return {
    url: invitationUrl(shareToken(demoInvitation.id)),
    expiresAt: rows[0].expires_at.toISOString(),
    remaining: rows[0].remaining,
  };
}

async function issueInvitation(client: PoolClient, creator: string) {
  const { id, uses, days } = demoInvitation;
  await client.query(
    `INSERT INTO invitation(id,token_hash,creator_id,max_uses,expires_at)
    VALUES($1,$2,$3,$4,now()+make_interval(days=>$5))`,
    [id, invitationHash(shareToken(id)), creator, uses, days],
  );
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
async function addActivity(
  { reviewer, maya, theo, priya }: Record<keyof typeof members, string>,
  pace: () => Promise<void>,
) {
  const step = async <T>(work: Promise<T>) => {
    const result = await work;
    await pace();
    return result;
  };
  const paddington = await step(
    updateTitleActivity(maya, titles.paddington2, "recommended", true),
  );
  await step(updateTopTen(maya, titles.paddington2, "add"));
  await step(
    saveReview(
      maya,
      titles.paddington2,
      5,
      "Warm, funny, and kind from start to finish. A perfect movie night.",
      false,
    ),
  );
  await step(
    updateTitleActivity(maya, titles.planetEarth2, "want_to_watch", true),
  );

  await step(
    updateTitleActivity(theo, titles.spiritedAway, "recommended", true),
  );
  await step(
    saveReview(
      theo,
      titles.spiritedAway,
      5,
      "Beautiful and imaginative. I notice something new every time I watch it.",
      false,
    ),
  );
  await step(updateWatchStatus(theo, titles.tedLasso, "watching"));

  await step(updateTitleActivity(priya, titles.tedLasso, "recommended", true));
  await step(
    updateTitleActivity(priya, titles.hiddenFigures, "recommended", true),
  );
  await step(updateWatchStatus(priya, titles.princessBride, "finished"));
  const princessBride = await step(
    saveReview(
      priya,
      titles.princessBride,
      4,
      "Still charming, and still quotable after all these years.",
      false,
    ),
  );

  const saved = await step(
    updateTitleActivity(reviewer, titles.tedLasso, "want_to_watch", true),
  );

  const watched = await step(
    addComment(
      theo,
      paddington,
      "Watched it last weekend because of you. The barbershop scene had me laughing out loud.",
      false,
    ),
  );
  await step(
    addComment(
      maya,
      paddington,
      "Right? I could watch that scene on repeat.",
      false,
      watched,
    ),
  );
  const question = await step(
    addComment(
      priya,
      paddington,
      "Adding it to my list. Do I need to see the first one?",
      false,
    ),
  );
  await step(
    addComment(
      maya,
      paddington,
      "It helps, but this one stands on its own.",
      false,
      question,
    ),
  );
  await step(addComment(theo, princessBride, "As you wish!", false));
  await step(
    addComment(
      priya,
      saved,
      "You're going to love it. Give it two episodes.",
      false,
    ),
  );
}
