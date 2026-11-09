import { test } from "node:test";
import assert from "node:assert/strict";
import {
  useDatabase,
  db,
  setup,
  friend,
  person,
  bearerFor,
} from "./social-fixture";

const { POST } = await import("../../src/app/api/screenr/[action]/route");
const { runWorkerPass } = await import("../../src/server/email");
const { addComment } = await import("../../src/server/comments");
const { queueBadgePush } = await import("../../src/server/push");
useDatabase();

// The worker's periodic cleanup, which its first pass and every 60th run
// (docs/running-screenr.md#email-worker).
const cleanup = () => runWorkerPass(0);

test("worker cleanup deletes expired sessions with their push devices and pending pushes", async () => {
  const alice = await person("alice");
  const phone = await bearerFor(alice);
  const tablet = await bearerFor(alice);
  const devices = { [phone]: "a1".repeat(32), [tablet]: "b2".repeat(32) };
  for (const [session, token] of Object.entries(devices)) {
    const response = await POST(
      new Request("http://localhost:3000/api/screenr/push-device", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "register",
          token,
          environment: "sandbox",
          topic: "com.artisanalsoftware.Screenr.dev",
          build: 42,
        }),
      }),
      { params: Promise.resolve({ action: "push-device" }) },
    );
    assert.equal(response.status, 200);
  }
  await queueBadgePush(alice);
  // A signed bearer token starts with the stored session token.
  const stored = (bearer: string) => decodeURIComponent(bearer).split(".")[0];
  await db.query(
    `UPDATE session SET "expiresAt"=now()-interval '1 second' WHERE token=$1`,
    [stored(tablet)],
  );
  await cleanup();
  const kept = await db.query(
    `SELECT (SELECT array_agg(token) FROM session) AS sessions,
      (SELECT array_agg(token) FROM push_device) AS devices,
      (SELECT array_agg(token) FROM push_job) AS pushes`,
  );
  assert.deepEqual(kept.rows[0], {
    sessions: [stored(phone)],
    devices: [devices[phone]],
    pushes: [devices[phone]],
  });
});

test("worker cleanup deletes read notifications more than a year old and keeps unread ones", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await addComment(ben, conversation, "Loved it", false);
  const names = { [alice]: "alice", [ben]: "ben", [cam]: "cam" };
  // Each notification's age and whether its recipient has read it. A
  // recipient read each read one yesterday: its age counts from its arrival.
  const ages: [string, string, string, string, boolean][] = [
    [alice, ben, "comment", "1 year 1 day", true],
    [alice, ben, "friend_accepted", "1 year -1 day", true],
    [alice, cam, "friend_accepted", "3 years", false],
    [ben, alice, "friend_request", "3 years", true],
    [cam, alice, "friend_request", "2 years", true],
  ];
  for (const [recipient, actor, kind, age, read] of ages) {
    const { rowCount } = await db.query(
      `UPDATE notification SET created_at=now()-$4::interval,
        read_at=CASE WHEN $5 THEN now()-interval '1 day' END
      WHERE recipient_id=$1 AND actor_id=$2 AND kind=$3`,
      [recipient, actor, kind, age, read],
    );
    assert.equal(rowCount, 1);
  }
  await cleanup();
  const { rows } = await db.query(
    "SELECT recipient_id,actor_id,kind FROM notification ORDER BY id",
  );
  assert.deepEqual(
    rows.map(
      ({ recipient_id, actor_id, kind }) =>
        `${names[recipient_id]} ← ${names[actor_id]} ${kind}`,
    ),
    ["alice ← ben friend_accepted", "alice ← cam friend_accepted"],
  );
});

test("worker cleanup deletes catalog data for titles nothing references once it has been expired for 30 days", async () => {
  // Alice's Recommend references movie:1.
  await setup();
  // Details expire a day after they are fetched, or at a failed refresh's
  // retry time. A search result whose details never loaded expires when
  // stored.
  await db.query(
    `UPDATE title SET fetched_at=now()-interval '60 days',stored_at=now()-interval '90 days'
    WHERE id='movie:1'`,
  );
  await db.query(
    `INSERT INTO title(id,kind,tmdb_id,name,fetched_at,retry_after,stored_at) VALUES
    ('movie:2','movie',2,'Forgotten',now()-interval '60 days',NULL,now()-interval '90 days'),
    ('movie:3','movie',3,'Still listed',now()-interval '60 days',NULL,now()-interval '90 days'),
    ('movie:4','movie',4,'New search result','epoch',NULL,now()),
    ('movie:5','movie',5,'Old search result','epoch',NULL,now()-interval '31 days'),
    ('movie:6','movie',6,'Retried lately',now()-interval '60 days',now()-interval '29 days',now()-interval '90 days'),
    ('movie:7','movie',7,'Fetched lately',now()-interval '30 days',NULL,now()-interval '90 days')`,
  );
  // Availability refreshes once refresh_after passes, and a trailer once it
  // expires.
  await db.query(
    `INSERT INTO title_availability(title_id,country,availability,fetched_at,refresh_after) VALUES
    ('movie:1','US','{}',now()-interval '60 days',now()-interval '59 days'),
    ('movie:2','US','{}',now()-interval '32 days',now()-interval '31 days'),
    ('movie:3','US','{}',now()-interval '30 days',now()-interval '29 days')`,
  );
  await db.query(
    `INSERT INTO title_trailer(title_id,trailer,expires_at) VALUES
    ('movie:1',NULL,now()-interval '59 days'),
    ('movie:2',NULL,now()-interval '31 days'),
    ('movie:3',NULL,now()-interval '31 days')`,
  );
  await cleanup();
  const kept = await db.query(
    `SELECT (SELECT array_agg(id ORDER BY id) FROM title) AS titles,
      (SELECT array_agg(title_id ORDER BY title_id) FROM title_availability) AS availability,
      (SELECT array_agg(title_id ORDER BY title_id) FROM title_trailer) AS trailers`,
  );
  assert.deepEqual(kept.rows[0], {
    titles: ["movie:1", "movie:3", "movie:4", "movie:6", "movie:7"],
    availability: ["movie:1", "movie:3"],
    trailers: ["movie:1"],
  });
});
