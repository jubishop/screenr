import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { db, pending, bearerFor, friend } from "./social-fixture";
import { Placeholders, labelToken, labelUuid } from "./ios-fixtures";

// The members, titles, and activity that the iPhone fixture cases read
// (docs/testing.md#iphone-api-fixtures), and a TMDB stand-in that serves the
// titles.

// Google sign-in and Sign in with Apple are configured, as in production, so
// the account screen offers them. No request reaches Google or Apple. Apple's
// key is a real P-256 key, so a case can sign a request to Apple that a
// stand-in answers.
process.env.GOOGLE_CLIENT_ID = "fixture-google-client";
process.env.GOOGLE_CLIENT_SECRET = "fixture-google-secret";
process.env.APPLE_TEAM_ID = "fixture-team";
process.env.APPLE_KEY_ID = "fixture-key";
process.env.APPLE_PRIVATE_KEY = generateKeyPairSync("ec", {
  namedCurve: "P-256",
})
  .privateKey.export({ format: "der", type: "pkcs8" })
  .toString("base64");

const { createInvitation, completeSignup } =
  await import("../../src/server/invitations");
const { changeRelationship } = await import("../../src/server/relationships");
const { updateTitleActivity, updateTopTen, updateWatchStatus } =
  await import("../../src/server/title-actions");
const { saveReview } = await import("../../src/server/reviews");
const { addComment, createDiscussionPost, createTitleComment, removeComment } =
  await import("../../src/server/comments");
const { setReaction } = await import("../../src/server/reactions");
const { uploadPhoto } = await import("../../src/server/photos");
const { saveServices } = await import("../../src/server/streaming-services");
const { readNotification } = await import("../../src/server/notifications");
const { releaseCalendar } = await import("../../src/server/title-release");
import type { StoredRelease } from "../../src/server/title-release";

// Release status is derived on the fixtures' own date, so it never drifts.
releaseCalendar.today = () => "2026-10-13";

// TMDB stand-in. A null `providers` makes the provider request fail, so the
// title's availability is unknown. Unstored titles appear only in search.
type CatalogTitle = {
  id: string;
  name: string;
  released: string;
  overview: string;
  poster: string | null;
  trailer?: string;
  providers: Partial<
    Record<"flatrate" | "free" | "ads" | "rent", number[]>
  > | null;
  seasons?: { name: string; episodes: string[] }[];
  // Stored US release data. By default a movie's only date is its past
  // theatrical release and a show premiered on its release date; null leaves
  // the release status unavailable.
  release?: StoredRelease | null;
  stored?: false;
  // The IMDb ID that TMDB's find returns the title for.
  imdb?: string;
  // The Netflix ID of the title page that names it.
  netflix?: string;
};
const providerNames: Record<number, string> = {
  2: "Apple TV Store",
  8: "Netflix",
  15: "Hulu",
  73: "Tubi TV",
  196: "Acorn TV Amazon Channel",
  300: "Pluto TV",
  1899: "HBO Max",
  9999: "Harbor Cinema Club",
};
export const topTenTitles = [
  "Copper Coast",
  "Second Spring",
  "Low Tide",
  "North Window",
  "Salt and Cedar",
  "Blue Hour",
  "Far Fields",
  "Small Hours",
  "Kite Season",
  "Last Ferry",
].map((name, index): CatalogTitle => ({
  id: `movie:${301 + index}`,
  name,
  released: `20${10 + index}-06-01`,
  overview: "",
  poster: `/${name.toLowerCase().replaceAll(" ", "-")}.jpg`,
  providers: {},
}));
const catalog: CatalogTitle[] = [
  {
    id: "movie:101",
    name: "Night Crossing",
    released: "2024-03-08",
    overview: "Two strangers share the last ferry across a frozen strait.",
    poster: "/night-crossing.jpg",
    trailer: "nightCross1",
    providers: { flatrate: [8], rent: [2] },
    imdb: "tt0000101",
    netflix: "80000001",
  },
  {
    id: "movie:102",
    name: "Paper Lanterns",
    released: "2023-11-17",
    overview: "A festival of lights brings a scattered family home.",
    poster: "/paper-lanterns.jpg",
    providers: { free: [73], ads: [300] },
  },
  {
    id: "movie:103",
    name: "The Quiet Orchard",
    released: "2025-05-02",
    overview: "An orchard keeper hears the trees whispering.",
    poster: "/quiet-orchard.jpg",
    providers: { flatrate: [15] },
    // Back in theaters, with its first digital release ahead.
    release: {
      theatrical: ["2025-05-02", "2026-09-26"],
      digital: ["2026-11-20"],
    },
  },
  {
    id: "movie:104",
    name: "Glass Meridian",
    released: "2022-08-19",
    overview: "",
    poster: null,
    providers: null,
    release: null,
  },
  {
    id: "movie:105",
    name: "Winter Garden",
    released: "2019-12-06",
    overview: "A botanist tends a greenhouse through the polar night.",
    poster: "/winter-garden.jpg",
    providers: { flatrate: [8] },
  },
  {
    id: "tv:201",
    name: "Harbor Lights",
    released: "2021-09-30",
    overview: "A lighthouse town keeps its secrets through the fog.",
    poster: "/harbor-lights.jpg",
    trailer: "harborLite1",
    providers: { flatrate: [1899, 196] },
    seasons: [
      { name: "Season 1", episodes: ["Arrival", "Undertow", "The Fog"] },
      { name: "Season 2", episodes: ["Return", "Keeper"] },
    ],
  },
  {
    id: "tv:202",
    name: "The Long Winter",
    released: "2020-01-10",
    overview: "A mountain village waits out a winter that will not end.",
    poster: "/long-winter.jpg",
    providers: {},
  },
  {
    id: "tv:203",
    name: "Night Harbor",
    released: "2018-04-12",
    overview: "Dockworkers uncover a smuggling ring.",
    poster: "/night-harbor.jpg",
    providers: { flatrate: [9999] },
    stored: false,
  },
  {
    id: "tv:204",
    name: "Signal Fire",
    released: "2025-02-14",
    overview: "Radio operators on a remote island hear a distress call.",
    poster: "/signal-fire.jpg",
    providers: { flatrate: [15] },
    release: {
      premiere: "2025-02-14",
      network: "Hulu",
      seasons: [
        { number: 1, date: "2025-02-14" },
        { number: 2, date: "2026-11-04" },
      ],
    },
  },
  ...topTenTitles,
];

function catalogReply(url: URL): [number, unknown] {
  if (url.pathname === "/search/multi") {
    const query = (url.searchParams.get("query") ?? "").toLowerCase();
    return [
      200,
      {
        results: catalog
          .filter((title) => title.name.toLowerCase().includes(query))
          .map((title) => details(title, true)),
      },
    ];
  }
  const find = /^\/find\/(tt\d+)$/.exec(url.pathname);
  if (find) {
    const found = catalog.find((item) => item.imdb === find[1]);
    const results = (kind: string) =>
      found?.id.startsWith(`${kind}:`) ? [details(found, true)] : [];
    return [
      200,
      {
        movie_results: results("movie"),
        tv_results: results("tv"),
        tv_episode_results: [],
        tv_season_results: [],
        person_results: [],
      },
    ];
  }
  const match =
    /^\/(movie|tv)\/(\d+)(?:\/(videos|watch\/providers|season\/(\d+)))?$/.exec(
      url.pathname,
    );
  const title = catalog.find(
    (item) => item.id === `${match?.[1]}:${match?.[2]}`,
  );
  if (!match || !title) return [404, {}];
  const [, kind, id, part, season] = match;
  if (!part) return [200, details(title)];
  if (part === "videos")
    return [
      200,
      {
        results: title.trailer
          ? [
              {
                site: "YouTube",
                type: "Trailer",
                key: title.trailer,
                name: "Official Trailer",
                official: true,
              },
            ]
          : [],
      },
    ];
  if (part.startsWith("season")) {
    const episodes = title.seasons?.[Number(season) - 1]?.episodes;
    if (!episodes) return [404, {}];
    return [
      200,
      {
        season_number: Number(season),
        episodes: episodes.map((name, index) => ({
          episode_number: index + 1,
          name,
        })),
      },
    ];
  }
  if (!title.providers) return [503, {}];
  const slug = title.name.toLowerCase().replaceAll(" ", "-");
  return [
    200,
    {
      id: Number(id),
      results: {
        US: {
          link: `https://www.themoviedb.org/${kind}/${id}-${slug}/watch`,
          ...Object.fromEntries(
            Object.entries(title.providers).map(([category, providers]) => [
              category,
              providers.map((provider) => ({
                provider_id: provider,
                provider_name: providerNames[provider],
                logo_path: null,
              })),
            ]),
          ),
        },
      },
    },
  ];
}

function details(title: CatalogTitle, search = false) {
  const [kind, id] = title.id.split(":");
  return {
    ...(search && { media_type: kind }),
    id: Number(id),
    [kind === "movie" ? "title" : "name"]: title.name,
    [kind === "movie" ? "release_date" : "first_air_date"]: title.released,
    overview: title.overview,
    poster_path: title.poster,
    ...(title.seasons && {
      seasons: [
        { season_number: 0, name: "Specials" },
        ...title.seasons.map((season, index) => ({
          season_number: index + 1,
          name: season.name,
        })),
      ],
    }),
  };
}

// The catalog, and Netflix's title pages, whose heading names the title.
const catalogServer = createServer((request, response) => {
  const url = new URL(request.url!, "http://catalog");
  const netflix = /^\/title\/(\d+)$/.exec(url.pathname);
  if (netflix) {
    const title = catalog.find((item) => item.netflix === netflix[1]);
    response.writeHead(title ? 200 : 404, { "Content-Type": "text/html" });
    response.end(
      title ? `<title>Netflix</title><h1>${title.name}</h1>` : "Not found",
    );
    return;
  }
  const [status, body] = catalogReply(url);
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
});

// Bytes that start like a JPEG. The server checks only the leading bytes.
export function jpeg(size: number, fill: number) {
  const bytes = Buffer.alloc(size, fill);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

const names = {
  alice: "Alice Park",
  ben: "Ben Ortiz",
  cam: "Cam Rivera",
  dana: "Dana Kim",
  erin: "Erin Walsh",
  fay: "Fay Chen",
  gus: "Gus Novak",
  hana: "Hana Ito",
  nora: "Nora Quinn",
} as const;
// Pat is invited and verified but has not set up a profile.
export type Viewer = keyof typeof names | "pat";

// Feed order compares times to the millisecond, so each entry or reply that
// moves an entry waits for the next one.
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
async function step<T>(work: Promise<T>) {
  const result = await work;
  await tick();
  return result;
}

// The members, relationships, and activity every case reads. Alice is the
// usual viewer: Ben and Cam are her friends, Hana joined through her link,
// Fay has asked to be her friend, she has asked Gus, and she blocked Dana,
// Ben's friend. Erin, a friend of Ben and Cam, fills her top 10. Nora has
// no friends or activity.
export async function buildWorld() {
  await db.query(
    'TRUNCATE "user", verification, title RESTART IDENTITY CASCADE',
  );
  for (const title of catalog.filter((item) => item.stored !== false)) {
    const [kind, id] = title.id.split(":");
    await db.query(
      `INSERT INTO title(id,kind,tmdb_id,name,overview,poster_path,release_date,release)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        title.id,
        kind,
        id,
        title.name,
        title.overview,
        title.poster,
        title.released,
        title.release === null
          ? null
          : JSON.stringify(
              title.release ??
                (kind === "movie"
                  ? { theatrical: [title.released], digital: [] }
                  : {
                      premiere: title.released,
                      network: "Netflix",
                      seasons: [],
                    }),
            ),
      ],
    );
  }
  const placeholders = new Placeholders();
  const users = {} as Record<Viewer, string>;
  async function join(username: Viewer, token: string) {
    users[username] = await pending(username, token);
    placeholders.add(users[username], `user-${username}`);
    if (username !== "pat")
      await completeSignup(users[username], names[username], username);
  }
  for (const username of [
    "alice",
    "ben",
    "cam",
    "dana",
    "erin",
    "fay",
    "gus",
    "nora",
    "pat",
  ] as const)
    await join(username, (await createInvitation(null)).token);
  const u = users;
  // Pat's sign-in named him, which setup offers as his display name.
  await db.query('UPDATE "user" SET name=$2 WHERE id=$1', [
    u.pat,
    "Pat Morgan",
  ]);
  const link = await createInvitation(u.alice, 3);
  placeholders.add(link.token, labelToken("invitation/alice/1"));
  await join("hana", link.token);
  const spare = await createInvitation(u.alice, 1);
  placeholders.add(spare.token, labelToken("invitation/alice/2"));

  await uploadPhoto(u.alice, jpeg(3000, 1));
  await uploadPhoto(u.ben, jpeg(3000, 2));
  // Alice linked Google, which has a picture for her.
  await db.query(
    `INSERT INTO account(id,"accountId","providerId","userId","createdAt","updatedAt")
    VALUES('fixture-google-account','fixture-google-subject','google',$1,now(),now())`,
    [u.alice],
  );
  await db.query('UPDATE "user" SET image=$2 WHERE id=$1', [
    u.alice,
    "https://lh3.googleusercontent.com/a/fixture-alice=s96-c",
  ]);
  await saveServices(u.alice, ["service:netflix", "service:hulu"]);
  await saveServices(u.ben, ["service:hulu"]);

  for (const [a, b] of [
    [u.alice, u.ben],
    [u.alice, u.cam],
    [u.ben, u.cam],
    [u.ben, u.dana],
    [u.ben, u.erin],
    [u.cam, u.erin],
  ])
    await friend(a, b);
  await changeRelationship(u.fay, u.alice, "request");
  await changeRelationship(u.alice, u.gus, "request");
  await changeRelationship(u.alice, u.dana, "block");

  const benNight = await step(
    updateTitleActivity(u.ben, "movie:101", "recommended", true),
  );
  await updateTopTen(u.ben, "movie:101", "add");
  await step(updateTopTen(u.ben, "tv:201", "add"));
  await step(updateTitleActivity(u.cam, "movie:101", "want_to_watch", true));
  await step(updateTitleActivity(u.cam, "movie:105", "recommended", true));
  await step(updateWatchStatus(u.cam, "tv:204", "watching"));
  await step(updateWatchStatus(u.cam, "tv:201", "caught_up"));
  await step(updateTitleActivity(u.ben, "movie:105", "want_to_watch", true));
  // Alice blocked Dana, so Dana's reply is unavailable to her. It stays as a
  // placeholder because Ben answered it.
  const danaReply = await step(
    addComment(
      u.dana,
      benNight,
      "Saw this at a festival. The last crossing is worth the wait.",
      false,
    ),
  );
  const benAnswer = await step(
    addComment(
      u.ben,
      benNight,
      "That last scene stayed with me.",
      false,
      danaReply,
    ),
  );
  await setReaction(u.alice, benNight, null, "love");
  await setReaction(u.cam, benNight, null, "like");
  await setReaction(u.alice, benNight, benAnswer, "haha");
  const spoiler =
    "The finale reveals that the lighthouse keeper narrated every episode.";
  await step(saveReview(u.ben, "tv:201", 4, spoiler, true));
  // Changing the rating marks the review edited.
  await step(saveReview(u.ben, "tv:201", 5, spoiler, true));
  const aliceEpisode = await step(
    createTitleComment(
      u.alice,
      "tv:201",
      "The harbor fog in this episode is gorgeous.",
      false,
      1,
      3,
    ),
  );
  const benComment = await step(
    addComment(u.ben, aliceEpisode, "Wait until season 2.", false),
  );
  const aliceAnswer = await step(
    addComment(
      u.alice,
      aliceEpisode,
      "No spoilers, please!",
      false,
      benComment,
    ),
  );
  const benSpoiler = await step(
    addComment(u.ben, aliceEpisode, "The fog is a person.", true, aliceAnswer),
  );
  // Cam removed his reply after Alice answered it, so it stays as removed.
  const camQuestion = await step(
    addComment(u.cam, aliceEpisode, "Is this the one with the ferry?", false),
  );
  await step(
    addComment(
      u.alice,
      aliceEpisode,
      "Yes, the ferry one.",
      false,
      camQuestion,
    ),
  );
  await step(removeComment(u.cam, camQuestion));
  await step(
    createTitleComment(
      u.alice,
      "tv:201",
      "The season 2 opener had me shouting.",
      true,
      2,
    ),
  );
  const alicePost = await step(
    createDiscussionPost(
      u.alice,
      "Anyone have a cozy mystery for the weekend?",
      false,
    ),
  );
  const benSuggestion = await step(
    addComment(u.ben, alicePost, "Try Paper Lanterns.", false),
  );
  // Cam deleted his post after Ben replied; the reply remains.
  const camPost = await step(
    createDiscussionPost(u.cam, "Hot take: the book was better.", false),
  );
  await step(addComment(u.ben, camPost, "Which book?", false));
  await step(removeComment(u.cam, camPost));
  await step(updateWatchStatus(u.alice, "tv:202", "watching"));
  await step(updateWatchStatus(u.alice, "movie:102", "finished", "2026-09-20"));
  await step(
    saveReview(u.alice, "movie:102", 3, "Lovely score, slow middle.", false),
  );
  for (const title of ["movie:101", "movie:102", "tv:201"])
    await step(updateTopTen(u.alice, title, "add"));
  for (const title of ["movie:103", "movie:104"])
    for (const owner of [u.alice, u.ben])
      await step(updateTitleActivity(owner, title, "want_to_watch", true));
  for (const title of topTenTitles) await updateTopTen(u.erin, title.id, "add");

  const notifications = (
    await db.query<{
      id: string;
      kind: string;
      actor_id: string;
      comment_id: string | null;
    }>(
      // Newest last, by number rather than by the text the IDs become.
      "SELECT id::text,kind,actor_id,comment_id::text FROM notification WHERE recipient_id=$1 ORDER BY notification.id",
      [u.alice],
    )
  ).rows;
  const notification = (kind: string, actor: string) =>
    notifications.find((row) => row.kind === kind && row.actor_id === actor)!
      .id;
  const about = (comment: string) =>
    notifications.find((row) => row.comment_id === comment)!.id;
  const ids = {
    benNight,
    benAnswer,
    aliceEpisode,
    aliceAnswer,
    benSpoiler,
    alicePost,
    benSuggestion,
    spareInvitation: spare.id,
    friendRequest: notification("friend_request", u.fay),
    commentNotification: notification("comment", u.ben),
    latestNotification: notifications.at(-1)!.id,
    spoilerNotification: about(benSpoiler),
    postNotification: about(benSuggestion),
    // A notification of Ben's, which Alice cannot see.
    othersNotification: (
      await db.query<{ id: string }>(
        "SELECT min(id)::text AS id FROM notification WHERE recipient_id=$1",
        [u.ben],
      )
    ).rows[0].id,
  };
  await readNotification(u.alice, notification("friend_accepted", u.ben));

  // Each stored record keeps one placeholder across fixtures.
  const { rows } = await db.query<{ id: string; label: string }>(
    `SELECT c.id::text,'conversation/'||p.username||'/'||c.title_id AS label
      FROM conversation c JOIN profile p ON p.user_id=c.owner_id
    UNION ALL SELECT f.id::text,f.item_type||'/'||p.username||'/'||f.title_id
      FROM feed_item f JOIN profile p ON p.user_id=f.owner_id
    UNION ALL SELECT w.id::text,'progress/'||p.username||'/'||w.title_id
      FROM watch_progress w JOIN profile p ON p.user_id=w.owner_id
    UNION ALL SELECT r.id::text,'review/'||p.username||'/'||r.title_id
      FROM review r JOIN profile p ON p.user_id=r.owner_id
    UNION ALL SELECT t.id::text,'comment/'||p.username||'/'||t.title_id||'/'||
      row_number() OVER (PARTITION BY t.owner_id,t.title_id ORDER BY t.created_at)
      FROM title_comment t JOIN profile p ON p.user_id=t.owner_id
    UNION ALL SELECT d.id::text,'post/'||p.username||'/'||
      row_number() OVER (PARTITION BY d.owner_id ORDER BY d.created_at)
      FROM discussion_post d JOIN profile p ON p.user_id=d.owner_id
    UNION ALL SELECT i.id::text,'invitation/'||p.username||'/'||
      row_number() OVER (PARTITION BY i.creator_id ORDER BY i.created_at)
      FROM invitation i JOIN profile p ON p.user_id=i.creator_id`,
  );
  for (const { id, label } of rows) placeholders.add(id, labelUuid(label));

  // Sessions are part of the saved world, so restoring it keeps them valid.
  // Each viewer signs in as the app does and keeps a bearer token.
  const tokens = {} as Record<Viewer, string>;
  for (const viewer of Object.keys(users) as Viewer[])
    tokens[viewer] = await bearerFor(users[viewer]);
  // Alice's unused one-signup link, which a setup case sends.
  const invitations = { spare: spare.token };
  return { users, ids, placeholders, tokens, invitations };
}
export type World = Awaited<ReturnType<typeof buildWorld>>;

// Serves the catalog and Netflix's pages on a loopback port until the
// returned function closes it.
export async function startCatalog() {
  await new Promise<void>((resolve) =>
    catalogServer.listen(0, "127.0.0.1", resolve),
  );
  process.env.SCREENR_TEST_TMDB_URL = `http://127.0.0.1:${(catalogServer.address() as AddressInfo).port}`;
  process.env.SCREENR_TEST_PAGES_URL = process.env.SCREENR_TEST_TMDB_URL;
  process.env.TMDB_READ_TOKEN = "fixture-catalog-token";
  return () => catalogServer.close();
}
