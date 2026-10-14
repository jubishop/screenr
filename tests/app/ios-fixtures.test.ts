import { test, before, after, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { db } from "./social-fixture";
import {
  labelToken,
  saveDatabase,
  verifyFixture,
  verifyNoStaleFixtures,
  type Fixture,
} from "./ios-fixtures";
import {
  buildWorld,
  jpeg,
  startCatalog,
  topTenTitles,
  type Viewer,
  type World,
} from "./ios-fixture-world";
import type { ActionName } from "../../src/server/actions";
import type { MemberRoute } from "../../src/member-routes";

// Checks the iPhone app's API fixtures (docs/testing.md#iphone-api-fixtures)
// against real API responses, or writes them with `npm run fixtures:ios`:
// every screen route and every action, with the optional and edge states the
// app must decode. Each file below names one case.

const { GET, POST } = await import("../../src/app/api/screenr/[action]/route");
const { findAction } = await import("../../src/server/actions");
const { readVersion } = await import("../../src/server/screens");
const { parseMemberRoute } = await import("../../src/member-routes");
const { migrate } = await import("../../scripts/migrate");
const { updateTopTen } = await import("../../src/server/title-actions");
const { createAuth } = await import("../../src/server/auth");
const { completeSignup } = await import("../../src/server/invitations");
const { uploadPhoto } = await import("../../src/server/photos");

type Query = Record<string, string | string[]>;
type Body = Record<string, unknown>;
type ApiRequest = {
  action: string;
  query?: Query;
  headers?: Record<string, string>;
  body?: Body;
  upload?: { contentType: string; bytes: Buffer };
};
type Case = {
  method: "GET" | "POST";
  description: string;
  viewer: Viewer | null;
  status: number;
  request: (world: World) => ApiRequest | Promise<ApiRequest>;
  // A read whose request changes the world, so it starts from the saved
  // world like a write.
  changesWorld?: true;
};
type Maybe<T> = T | ((world: World) => T | Promise<T>);
const resolve = <T>(value: Maybe<T>, world: World) =>
  typeof value === "function"
    ? (value as (world: World) => T | Promise<T>)(world)
    : value;

const screen = (
  viewer: Viewer | null,
  path: Maybe<string>,
  description: string,
  status = 200,
): Case => ({
  method: "GET",
  description,
  viewer,
  status,
  request: async (world) => ({
    action: "screen",
    query: { path: await resolve(path, world) },
  }),
});
const read = (
  action: string,
  viewer: Viewer | null,
  query: Maybe<Query>,
  description: string,
  status = 200,
): Case => ({
  method: "GET",
  description,
  viewer,
  status,
  request: async (world) => ({ action, query: await resolve(query, world) }),
});
const write = (
  action: string,
  viewer: Viewer,
  body: Maybe<Body>,
  description: string,
  status = 200,
): Case => ({
  method: "POST",
  description,
  viewer,
  status,
  request: async (world) => ({ action, body: await resolve(body, world) }),
});

// A case whose request also sends these headers.
const withHeaders = (
  item: Case,
  headers: Maybe<Record<string, string>>,
): Case => ({
  ...item,
  request: async (world) => ({
    ...(await item.request(world)),
    headers: await resolve(headers, world),
  }),
});

// A read after Pat joins through Alice's one-signup link, which makes them
// friends, as the iPhone app's invitation journey ends.
const afterPatJoins = (item: Case): Case => ({
  ...item,
  changesWorld: true,
  request: async (world) => {
    await completeSignup(
      world.users.pat,
      "Pat Morgan",
      "pat",
      world.invitations.spare,
    );
    return item.request(world);
  },
});

const origin = process.env.BETTER_AUTH_URL!;
async function send(
  world: World,
  viewer: Viewer | null,
  request: ApiRequest,
  method: Case["method"],
) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(request.query ?? {}))
    for (const item of [value].flat()) query.append(name, item);
  const path = `/api/screenr/${request.action}${query.size ? `?${query}` : ""}`;
  // Like the app, a request names its session with a bearer token and sends
  // no cookie or Origin.
  const headers = new Headers(request.headers);
  if (viewer) headers.set("Authorization", `Bearer ${world.tokens[viewer]}`);
  const context = { params: Promise.resolve({ action: request.action }) };
  let response: Response;
  if (method === "GET")
    response = await GET(new Request(origin + path, { headers }), context);
  else {
    headers.set(
      "Content-Type",
      request.upload?.contentType ?? "application/json",
    );
    response = await POST(
      new Request(origin + path, {
        method,
        headers,
        body: request.upload
          ? new Uint8Array(request.upload.bytes)
          : JSON.stringify(request.body ?? {}),
      }),
      context,
    );
  }
  const text = await response.text();
  return {
    path,
    status: response.status,
    etag: response.headers.get("ETag"),
    body: text ? (JSON.parse(text) as unknown) : null,
  };
}

const screens: Record<MemberRoute["kind"], Record<string, Case>> = {
  feed: {
    default: screen(
      "alice",
      "/",
      "Alice's feed: Recommends with top 10 ranks, Want to watch, progress, an edited spoiler review, TV comments with season and episode labels, spoiler and removed replies, a blocked author's reply shown as unavailable, reactions, a post, and a deleted post that keeps its reply.",
    ),
    empty: screen("nora", "/", "A member with no friends or activity."),
    joined: afterPatJoins(
      screen(
        "pat",
        "/",
        "Pat's feed after joining through Alice's link: Alice is his friend, so her entries appear.",
      ),
    ),
    "linked-reply": screen(
      "hana",
      (world) =>
        `/?item=${world.ids.alicePost}&reply=${world.ids.benSuggestion}`,
      "Hana, Alice's friend, follows a link to a reply on Alice's post without a title.",
    ),
    "unavailable-link": screen(
      "nora",
      (world) => `/?item=${world.ids.alicePost}`,
      "A link to an entry the viewer cannot see reports the target unavailable.",
    ),
    "not-modified": {
      method: "GET",
      description:
        "A refresh that sends the version it holds gets 304 without a body.",
      viewer: "alice",
      status: 304,
      request: async (world) => {
        const request = { action: "screen", query: { path: "/" } };
        const first = await send(world, "alice", request, "GET");
        world.placeholders.add(
          first.etag!,
          readVersion(JSON.stringify(world.placeholders.scrub(first.body))),
        );
        return { ...request, headers: { "If-None-Match": first.etag! } };
      },
    },
  },
  search: {
    default: screen(
      "alice",
      "/search",
      "Find a title: suggestions and Friends recommend, with viewing options and saved services.",
    ),
    empty: screen("nora", "/search", "Find a title with no friends' activity."),
    "viewer-statuses": screen(
      "cam",
      "/search",
      "Cam's Find a title: his own Want to watch and Caught up on friends' recommendations, free options, unknown availability, a title without a poster, and no saved services.",
    ),
  },
  people: {
    default: screen(
      "alice",
      "/people",
      "Friends, requests in both directions, a blocked member, and a suggestion with mutual friends.",
    ),
    empty: screen("nora", "/people", "A member with no connections."),
  },
  invites: {
    default: screen(
      "alice",
      "/invites",
      "An invitation link that one friend joined through, and an unused link.",
    ),
    empty: screen("nora", "/invites", "A member with no open invitations."),
  },
  account: {
    default: screen(
      "alice",
      "/account",
      "Account settings with Google connected, Apple not connected, activity email off, saved services, and every push kind on.",
    ),
  },
  "watch-together": {
    default: screen(
      "alice",
      "/watch-together?with=ben",
      "Titles Alice and Ben both want to watch: one on her services, one with unknown availability.",
    ),
    "nothing-shared": screen(
      "alice",
      "/watch-together?with=cam",
      "A friend with no shared Want to watch titles.",
    ),
    "missing-friend": screen(
      "alice",
      "/watch-together",
      "Watch together without a friend.",
      400,
    ),
  },
  title: {
    movie: screen(
      "alice",
      "/titles/movie/101",
      "A movie with a trailer, streaming and rental offers, friends who recommend it (with a top 10 rank) and want to watch it, Alice's top 10, and a blocked author's reply.",
    ),
    tv: screen(
      "alice",
      "/titles/tv/201",
      "A TV show with an edited spoiler review, season and episode labels, spoiler and removed replies, a progress entry, and an offer through a reseller.",
    ),
    "unknown-availability": screen(
      "alice",
      "/titles/movie/104",
      "A title with no poster or trailer whose availability could not be checked.",
    ),
    "linked-reply": screen(
      "hana",
      (world) =>
        `/titles/tv/201?item=${world.ids.aliceEpisode}&reply=${world.ids.benSpoiler}`,
      "Hana, Alice's friend, follows a link to a spoiler reply on Alice's TV comment.",
    ),
    "not-found": screen(
      "alice",
      "/titles/movie/999",
      "A title the catalog does not have.",
      404,
    ),
  },
  profile: {
    own: screen(
      "alice",
      "/people/alice",
      "Alice's own profile, with a partial top 10 and her entries.",
    ),
    friend: screen("alice", "/people/ben", "A friend's profile and entries."),
    "full-top-ten": screen(
      "alice",
      "/people/erin",
      "A member who is not a friend: a full top 10, mutual friends, and no entries.",
    ),
    "empty-top-ten": screen(
      "nora",
      "/people/nora",
      "A profile with an empty top 10.",
    ),
    "pending-request": screen(
      "alice",
      "/people/fay",
      "A member who has asked to be Alice's friend.",
    ),
    joined: afterPatJoins(
      screen(
        "pat",
        "/people/pat",
        "Pat's own profile after joining through Alice's link, with Alice as his friend.",
      ),
    ),
    "not-found": screen(
      "alice",
      "/people/nobody",
      "A username that does not exist.",
      404,
    ),
  },
  conversation: {
    redirect: screen(
      "alice",
      (world) => `/conversations/${world.ids.benNight}`,
      "An old conversation link redirects to the entry on its title page.",
    ),
  },
  "not-found": {
    default: screen(
      "alice",
      "/nothing/here",
      "A path that names no screen.",
      404,
    ),
  },
};

// A Dev build's registration, which uses the sandbox APNs environment.
const pushDevice = {
  action: "register",
  token: "5ce7e1d2a0b94c3f8e6d7a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556",
  environment: "sandbox",
  topic: "com.artisanalsoftware.Screenr.dev",
  build: 42,
};

// The screen action's cases are the screens above.
const actions: Record<Exclude<ActionName, "screen">, Record<string, Case>> = {
  setup: {
    complete: write(
      "setup",
      "pat",
      { name: "Pat Morgan", username: "pat" },
      "Completing the profile after joining.",
    ),
    "with-invitation": withHeaders(
      write(
        "setup",
        "pat",
        { name: "Pat Morgan", username: "pat" },
        "Completing the profile with Alice's invitation, which the app opened.",
      ),
      (world) => ({ "Screenr-Invitation": world.invitations.spare }),
    ),
    "unavailable-invitation": withHeaders(
      write(
        "setup",
        "pat",
        { name: "Pat Morgan", username: "pat" },
        "An invitation that is unknown, expired, revoked, or used up.",
        403,
      ),
      { "Screenr-Invitation": labelToken("invitation/unavailable") },
    ),
    "username-taken": write(
      "setup",
      "pat",
      { name: "Pat Morgan", username: "alice" },
      "A username someone else has.",
      400,
    ),
  },
  "setup-details": {
    default: read(
      "setup-details",
      "pat",
      {},
      "Setup's starting values for Pat: the name his sign-in gave him, no photo, and no Google sign-in.",
    ),
    google: {
      ...read(
        "setup-details",
        "pat",
        {},
        "Pat signed up with Google, which supplied his photo.",
      ),
      changesWorld: true,
      request: async (world) => {
        await uploadPhoto(world.users.pat, jpeg(3000, 3));
        await db.query(
          `INSERT INTO account(id,"accountId","providerId","userId","createdAt","updatedAt")
          VALUES('fixture-pat-google','fixture-pat-subject','google',$1,now(),now())`,
          [world.users.pat],
        );
        return { action: "setup-details", query: {} };
      },
    },
  },
  search: {
    results: read(
      "search",
      "alice",
      { q: "night" },
      "Search results for a movie and a TV show, with viewing options.",
    ),
    "short-query": read(
      "search",
      "alice",
      { q: "n" },
      "A query too short to search returns no titles.",
    ),
  },
  seasons: {
    default: read(
      "seasons",
      "alice",
      { title: "tv:201" },
      "A TV show's seasons, without specials.",
    ),
  },
  episodes: {
    default: read(
      "episodes",
      "alice",
      { title: "tv:201", season: "1" },
      "A season's episodes.",
    ),
  },
  notifications: {
    default: read(
      "notifications",
      "alice",
      {},
      "Friend request, acceptances, a comment, and a spoiler reply, one of them read.",
    ),
    unread: read(
      "notifications",
      "alice",
      { unread: "true" },
      "Only unread notifications.",
    ),
  },
  notification: {
    comment: read(
      "notification",
      "alice",
      (world) => ({ id: world.ids.commentNotification }),
      "One notification for the push extension: a comment with its excerpt.",
    ),
    spoiler: read(
      "notification",
      "alice",
      (world) => ({ id: world.ids.spoilerNotification }),
      "A spoiler reply has no excerpt.",
    ),
    post: read(
      "notification",
      "alice",
      (world) => ({ id: world.ids.postNotification }),
      "A comment on a post without a title.",
    ),
    "friend-request": read(
      "notification",
      "alice",
      (world) => ({ id: world.ids.friendRequest }),
      "A friend request has no title, excerpt, thread, or comment.",
    ),
    hidden: read(
      "notification",
      "alice",
      (world) => ({ id: world.ids.othersNotification }),
      "Any notification the viewer cannot see gets this same answer.",
    ),
  },
  "read-notification": {
    default: write(
      "read-notification",
      "alice",
      (world) => ({ id: world.ids.commentNotification }),
      "Selecting a notification returns where it leads.",
    ),
  },
  "read-notifications": {
    default: write(
      "read-notifications",
      "alice",
      (world) => ({ through: world.ids.latestNotification }),
      "Mark all as read through the newest notification shown.",
    ),
  },
  "respond-friend-request": {
    accept: write(
      "respond-friend-request",
      "alice",
      (world) => ({ id: world.ids.friendRequest, action: "accept" }),
      "Accepting a friend request from its notification.",
    ),
  },
  "activity-email": {
    default: write(
      "activity-email",
      "alice",
      { enabled: false },
      "Turning activity email off.",
    ),
  },
  "push-device": {
    register: write(
      "push-device",
      "alice",
      pushDevice,
      "Registering the Dev app's APNs device token for this session.",
    ),
    remove: write(
      "push-device",
      "alice",
      async (world) => {
        const registered = await send(
          world,
          "alice",
          { action: "push-device", body: pushDevice },
          "POST",
        );
        assert.equal(registered.status, 200);
        return { action: "remove", token: pushDevice.token };
      },
      "Removing the app's registered device token.",
    ),
  },
  "push-settings": {
    default: write(
      "push-settings",
      "alice",
      { comment: false },
      "Turning comment pushes off returns every push setting.",
    ),
  },
  "streaming-services": {
    default: write(
      "streaming-services",
      "alice",
      { serviceIds: ["service:netflix", "service:hbo-max"] },
      "Saving streaming services.",
    ),
  },
  "display-name": {
    default: write(
      "display-name",
      "alice",
      { name: "Alice P." },
      "Changing the display name returns the profile.",
    ),
  },
  profile: {
    default: write(
      "profile",
      "alice",
      { name: "Alice Park", username: "alicep" },
      "Changing the display name and username returns the profile.",
    ),
  },
  photo: {
    upload: {
      method: "POST",
      description: "Uploading a 512×512 JPEG returns its photo version.",
      viewer: "alice",
      status: 200,
      request: () => ({
        action: "photo",
        upload: { contentType: "image/jpeg", bytes: jpeg(4000, 5) },
      }),
    },
  },
  "remove-photo": {
    default: write("remove-photo", "alice", {}, "Removing the profile photo."),
  },
  "google-photo": {
    default: write(
      "google-photo",
      "alice",
      () => {
        // Google's image server answers with a picture.
        const real = globalThis.fetch;
        mock.method(
          globalThis,
          "fetch",
          (input: string | URL, init?: RequestInit) =>
            new URL(String(input)).hostname === "lh3.googleusercontent.com"
              ? Promise.resolve(new Response(new Uint8Array(jpeg(5000, 6))))
              : real(input, init),
        );
        return {};
      },
      "Using the Google account's picture.",
    ),
  },
  invite: {
    default: write(
      "invite",
      "alice",
      { limit: 3 },
      "Creating an invitation link for three signups.",
    ),
  },
  "revoke-invite": {
    default: write(
      "revoke-invite",
      "alice",
      (world) => ({ id: world.ids.spareInvitation }),
      "Revoking an invitation link.",
    ),
  },
  relationship: {
    request: write(
      "relationship",
      "alice",
      (world) => ({ target: world.users.erin, action: "request" }),
      "Sending a friend request.",
    ),
  },
  activity: {
    recommend: write(
      "activity",
      "alice",
      { title: "movie:105", field: "recommended", value: true },
      "Recommending a title returns the entry.",
    ),
    "want-to-watch": write(
      "activity",
      "alice",
      {
        title: "movie:105",
        field: "want_to_watch",
        value: true,
        surface: "friend_recommendation",
      },
      "Saving a friend's recommendation to Want to watch.",
    ),
  },
  "watch-status": {
    watching: write(
      "watch-status",
      "alice",
      { title: "movie:103", status: "watching" },
      "Choosing a progress status returns the progress entry.",
    ),
    finished: write(
      "watch-status",
      "alice",
      { title: "tv:202", status: "finished", finishedOn: "2026-10-01" },
      "Finishing a show on a given date.",
    ),
    clear: write(
      "watch-status",
      "alice",
      { title: "tv:202", status: null },
      "Clearing the status returns no entry.",
    ),
  },
  "finished-date": {
    default: write(
      "finished-date",
      "alice",
      { title: "movie:102", date: "2026-09-21" },
      "Changing the finished date.",
    ),
  },
  review: {
    default: write(
      "review",
      "alice",
      {
        title: "movie:101",
        rating: 5,
        body: "The ending on the ice is perfect.",
        spoiler: true,
      },
      "Saving a rated spoiler review returns the entry.",
    ),
  },
  "remove-review": {
    default: write(
      "remove-review",
      "alice",
      { title: "movie:102" },
      "Removing a review.",
    ),
  },
  "top-ten": {
    add: write(
      "top-ten",
      "alice",
      { title: "movie:105", change: "add" },
      "Adding a title to the top 10.",
    ),
    "add-replacing": write(
      "top-ten",
      "alice",
      async (world) => {
        for (const title of topTenTitles.slice(0, 7))
          await updateTopTen(world.users.alice, title.id, "add");
        return { title: "movie:105", change: "add", replace: "movie:102" };
      },
      "Adding to a full top 10 names the title it replaces.",
    ),
    move: write(
      "top-ten",
      "alice",
      { title: "tv:201", change: "move", rank: 1 },
      "Moving a title to a new rank.",
    ),
    remove: write(
      "top-ten",
      "alice",
      { title: "movie:102", change: "remove" },
      "Removing a title from the top 10.",
    ),
  },
  "title-comment": {
    episode: write(
      "title-comment",
      "alice",
      {
        title: "tv:201",
        body: "That keeper twist!",
        spoiler: true,
        season: 2,
        episode: 2,
      },
      "Posting a spoiler comment about an episode returns the entry.",
    ),
  },
  "discussion-post": {
    default: write(
      "discussion-post",
      "alice",
      { body: "Movie night at my place on Friday?", spoiler: false },
      "Posting without a title returns the entry.",
    ),
  },
  comment: {
    reply: write(
      "comment",
      "alice",
      (world) => ({
        conversation: world.ids.benNight,
        body: "Adding it to my list.",
        spoiler: false,
        replyTo: world.ids.benAnswer,
      }),
      "Replying to a reply returns the new reply's ID.",
    ),
  },
  "remove-comment": {
    default: write(
      "remove-comment",
      "alice",
      (world) => ({ id: world.ids.aliceAnswer }),
      "Removing one's own reply.",
    ),
  },
  reaction: {
    default: write(
      "reaction",
      "alice",
      (world) => ({
        item: world.ids.alicePost,
        reply: world.ids.benSuggestion,
        kind: "care",
      }),
      "Reacting to a reply.",
    ),
  },
  "delete-account": {
    default: write(
      "delete-account",
      "alice",
      {},
      "Deleting the account with a session from a sign-in in the last ten minutes. The token then signs no one in.",
    ),
    "stale-sign-in": write(
      "delete-account",
      "alice",
      async (world) => {
        await db.query(
          `UPDATE session SET "createdAt"=now()-interval '11 minutes' WHERE token=$1`,
          [decodeURIComponent(world.tokens.alice).split(".")[0]],
        );
        return {};
      },
      "A session older than ten minutes must sign in again before deleting the account.",
      403,
    ),
  },
};

// Errors every action can return share one shape.
const errors: Record<string, Case> = {
  "signed-out": screen(null, "/", "A request without a session.", 401),
  "incomplete-profile": screen(
    "pat",
    "/",
    "A member action before profile setup.",
    403,
  ),
  "unknown-action": read(
    "unknown",
    "alice",
    {},
    "An action the server does not have.",
    404,
  ),
  "invalid-request": write(
    "comment",
    "alice",
    (world) => ({
      conversation: world.ids.benNight,
      body: " ",
      spoiler: false,
    }),
    "A request that fails validation.",
    400,
  ),
  // docs/data-and-access.md#client-headers
  "update-required": {
    method: "GET",
    description:
      "An app build below the server's minimum, which shows the required-update screen.",
    viewer: "alice",
    status: 426,
    request: () => {
      process.env.SCREENR_IOS_MINIMUM_BUILD = "42";
      return {
        action: "screen",
        query: { path: "/" },
        headers: { "Screenr-Client": "ios/1.0.0/41" },
      };
    },
  },
};

// Better Auth's sign-in errors, which the app shows as the server words them.
// Each case starts from the saved world, with the request limits on and no
// requests counted yet. `before` sends the requests that lead up to the
// recorded one, through the same auth instance; `codes` holds the codes it
// emailed.
type AuthPost = (
  path: string,
  body: Body,
  headers?: Record<string, string>,
) => Promise<Response>;
type AuthCase = {
  description: string;
  status: number;
  body: Body;
  before?: (post: AuthPost, codes: string[]) => Promise<void>;
};
const signInCode = { email: "alice@example.test", type: "sign-in" };
const requestCodes = async (post: AuthPost, emails: string[], ip?: number) => {
  for (const [index, email] of emails.entries())
    assert.equal(
      (
        await post(
          "email-otp/send-verification-otp",
          { email, type: "sign-in" },
          // A client address per request keeps the per-IP limit out of a
          // per-address case.
          ip === undefined
            ? {}
            : { "X-Forwarded-For": `192.0.2.${ip + index}` },
        )
      ).status,
      200,
    );
};
const authErrors: Record<string, Record<string, AuthCase>> = {
  "email-otp/send-verification-otp": {
    "rate-limited": {
      description:
        "A fourth code request for one address within 15 minutes is refused, with Screenr's message.",
      status: 429,
      body: signInCode,
      before: (post) => requestCodes(post, Array(3).fill(signInCode.email), 10),
    },
    "too-many-requests": {
      description:
        "A fourth code request from one client within a minute is refused, with Better Auth's message.",
      status: 429,
      body: signInCode,
      before: (post) =>
        requestCodes(
          post,
          ["ben", "cam", "dana"].map((name) => `${name}@example.test`),
        ),
    },
  },
  "sign-in/email-otp": {
    "invalid-code": {
      description: "A code that does not match the address's code.",
      status: 400,
      body: { email: "alice@example.test", otp: "000000" },
    },
    "too-many-attempts": {
      description:
        "After five wrong codes, even the right code is refused until the member requests a new one.",
      status: 403,
      body: { email: "alice@example.test", otp: "000000" },
      before: async (post, codes) => {
        await requestCodes(post, [signInCode.email]);
        const wrong = codes.at(-1) === "000000" ? "111111" : "000000";
        for (let attempt = 0; attempt < 5; attempt++)
          assert.equal(
            (
              await post("sign-in/email-otp", {
                email: "alice@example.test",
                otp: wrong,
              })
            ).status,
            400,
          );
      },
    },
  },
};

async function recordAuth(file: string, path: string, item: AuthCase) {
  const codes: string[] = [];
  const auth = createAuth({
    sendCode: async ({ otp }) => {
      codes.push(otp);
    },
  });
  // Like the app, without a cookie or Origin.
  const post: AuthPost = (path, body, headers) =>
    auth.handler(
      new Request(`${origin}/api/auth/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  // The world's own sign-ins used up shared request limits.
  await db.query('TRUNCATE "rateLimit", login_code_request');
  await item.before?.(post, codes);
  const response = await post(path, item.body);
  const text = await response.text();
  assert.equal(response.status, item.status, `${file} responded ${text}`);
  const fixture: Fixture = world.placeholders.scrub({
    description: item.description,
    viewer: null,
    request: {
      method: "POST",
      action: path,
      path: `/api/auth/${path}`,
      body: item.body,
    },
    response: { status: response.status, body: JSON.parse(text) },
  });
  await verifyFixture(file, fixture);
}

const authCases = Object.entries(authErrors).flatMap(([path, variants]) =>
  Object.entries(variants).map(([name, item]): [string, string, AuthCase] => [
    `auth/${path}/${name}.json`,
    path,
    item,
  ]),
);

// Screenr's own Better Auth reads, which the app sends before sign-in:
// whether an invitation link can still be used to join.
type AuthRead = {
  description: string;
  query: (world: World) => Record<string, string>;
};
const unavailableToken = labelToken("invitation/unavailable");
const authReads: Record<string, Record<string, AuthRead>> = {
  invitation: {
    available: {
      description: "An invitation link that can still be used to join.",
      query: (world) => ({ token: world.invitations.spare }),
    },
    unavailable: {
      description:
        "An invitation link that is unknown, expired, revoked, or used up.",
      query: () => ({ token: unavailableToken }),
    },
  },
};

async function recordAuthRead(file: string, path: string, item: AuthRead) {
  const query = item.query(world);
  const url = `/api/auth/${path}?${new URLSearchParams(query)}`;
  // The world's own sign-ins used up shared request limits.
  await db.query('TRUNCATE "rateLimit"');
  // Like the app, without a cookie or Origin.
  const response = await createAuth().handler(new Request(origin + url));
  const text = await response.text();
  assert.equal(response.status, 200, `${file} responded ${text}`);
  // The made-up token keeps its value in the path and the query.
  world.placeholders.add(unavailableToken, unavailableToken);
  const fixture: Fixture = world.placeholders.scrub({
    description: item.description,
    viewer: null,
    request: { method: "GET", action: path, path: url, query },
    response: { status: response.status, body: JSON.parse(text) },
  });
  await verifyFixture(file, fixture);
}

const authReadCases = Object.entries(authReads).flatMap(([path, variants]) =>
  Object.entries(variants).map(([name, item]): [string, string, AuthRead] => [
    `auth/${path}/${name}.json`,
    path,
    item,
  ]),
);

const cases: [string, Case][] = [
  ...Object.entries(screens).flatMap(([kind, variants]) =>
    Object.entries(variants).map(([name, item]): [string, Case] => [
      `screen/${kind}/${name}.json`,
      {
        ...item,
        // Each screen case covers the route it is filed under.
        request: async (world) => {
          const request = await item.request(world);
          assert.equal(
            parseMemberRoute(String(request.query?.path)).kind,
            kind,
          );
          return request;
        },
      },
    ]),
  ),
  ...Object.entries(actions).flatMap(([action, variants]) =>
    Object.entries(variants).map(([name, item]): [string, Case] => [
      `actions/${action}/${name}.json`,
      {
        ...item,
        request: async (world) => {
          const request = await item.request(world);
          assert.equal(request.action, action);
          assert.ok(findAction(action, item.method));
          return request;
        },
      },
    ]),
  ),
  ...Object.entries(errors).map(([name, item]): [string, Case] => [
    `errors/${name}.json`,
    item,
  ]),
];

async function record(file: string, item: Case, world: World) {
  const request = await item.request(world);
  const result = await send(world, item.viewer, request, item.method);
  assert.equal(
    result.status,
    item.status,
    `${file} responded ${JSON.stringify(result.body)}`,
  );
  const fixture: Fixture = world.placeholders.scrub({
    description: item.description,
    viewer: item.viewer,
    request: {
      method: item.method,
      action: request.action,
      path: result.path,
      ...(item.method === "GET" && { query: request.query ?? {} }),
      ...(request.headers && { headers: request.headers }),
      ...(item.method === "POST" &&
        (request.upload
          ? {
              upload: {
                contentType: request.upload.contentType,
                bytes: request.upload.bytes.length,
              },
            }
          : { body: request.body ?? {} })),
    },
    response: {
      status: result.status,
      ...(result.etag && { etag: result.etag }),
      body: result.body,
    },
  });
  // A body's version is the server's ETag for the fixture body.
  if (result.etag && result.status === 200)
    fixture.response.etag = readVersion(JSON.stringify(fixture.response.body));
  await verifyFixture(file, fixture);
}

let world: World;
let saved: Awaited<ReturnType<typeof saveDatabase>>;
let closeCatalog: () => void;
before(async () => {
  await migrate();
  closeCatalog = await startCatalog();
  world = await buildWorld();
  saved = await saveDatabase();
});
afterEach(() => {
  mock.restoreAll();
  delete process.env.SCREENR_IOS_MINIMUM_BUILD;
});
after(async () => {
  closeCatalog?.();
  await saved?.remove();
  // Later suites start without this world's members and titles.
  await db.query(
    'TRUNCATE "user", verification, title RESTART IDENTITY CASCADE',
  );
  await db.end();
});

// Reads share the world. Each write, and each read that changes the world,
// starts from the saved world, so no case sees another's changes.
const changes = (item: Case) => item.method === "POST" || item.changesWorld;
for (const [file, item] of cases.filter(([, item]) => !changes(item)))
  test(file, () => record(file, item, world));
for (const [file, item] of cases.filter(([, item]) => changes(item)))
  test(file, async () => {
    await saved.restore();
    await record(file, item, world);
  });
for (const [file, path, item] of authCases)
  test(file, async () => {
    await saved.restore();
    await recordAuth(file, path, item);
  });
for (const [file, path, item] of authReadCases)
  test(file, async () => {
    await saved.restore();
    await recordAuthRead(file, path, item);
  });

// The case tables' types require an entry for each route kind and action.
test("every screen route and action has a fixture case", () => {
  for (const [group, variants] of [
    ...Object.entries(screens),
    ...Object.entries(actions),
  ])
    assert.ok(Object.keys(variants).length, `${group} has no case`);
});

test("every iPhone fixture has a case", () =>
  verifyNoStaleFixtures(
    new Set([...cases, ...authCases, ...authReadCases].map(([file]) => file)),
  ));
