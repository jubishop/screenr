import { test } from "node:test";
import assert from "node:assert/strict";
import { GET } from "../../src/app/.well-known/apple-app-site-association/route";
import {
  entryPath,
  memberPath,
  type MemberRoute,
} from "../../src/member-routes";

type Component = { "/": string; exclude?: boolean };

async function association() {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  return (await response.json()) as {
    applinks: { details: { appIDs: string[]; components: Component[] }[] };
  };
}

// Apple's matching: the first component whose path pattern matches decides,
// `*` matches any run of characters, and queries are ignored.
function claims(components: Component[], url: string) {
  const path = new URL(url, "https://screenr.club").pathname;
  const match = components.find((component) =>
    new RegExp(
      `^${component["/"]
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
    ).test(path),
  );
  return Boolean(match && !match.exclude);
}

test("the association claims member routes and invitations for the Release app", async () => {
  const { applinks } = await association();
  assert.deepEqual(applinks, {
    details: [
      {
        appIDs: ["34TKMKM889.com.artisanalsoftware.Screenr"],
        components: [
          { "/": "/api/*", exclude: true },
          { "/": "/login", exclude: true },
          { "/": "/setup", exclude: true },
          { "/": "/credits", exclude: true },
          { "/": "/privacy", exclude: true },
          { "/": "/" },
          { "/": "/search" },
          { "/": "/titles/*" },
          { "/": "/people" },
          { "/": "/people/*" },
          { "/": "/invites" },
          { "/": "/account" },
          { "/": "/watch-together" },
          { "/": "/conversations/*" },
          { "/": "/join/*" },
        ],
      },
    ],
  });
});

test("every member screen, item permalink, and invitation opens in the app", async () => {
  const [{ components }] = (await association()).applinks.details;
  // Typed by route kind, so a new member screen must be added here.
  const screens: Record<Exclude<MemberRoute["kind"], "not-found">, string> = {
    feed: memberPath({ kind: "feed" }),
    search: memberPath({ kind: "search", q: "Severance" }),
    people: memberPath({ kind: "people" }),
    invites: memberPath({ kind: "invites" }),
    account: memberPath({ kind: "account" }),
    "watch-together": memberPath({ kind: "watch-together", with: ["ana"] }),
    title: memberPath({ kind: "title", id: "tv:95396" }),
    profile: memberPath({ kind: "profile", username: "ana" }),
    "want-to-watch": memberPath({ kind: "want-to-watch", username: "ana" }),
    conversation: memberPath({ kind: "conversation", id: "c1", reply: "r1" }),
  };
  for (const path of [
    ...Object.values(screens),
    entryPath({ id: "post", title_id: "movie:603" }, "reply"),
    entryPath({ id: "post", title_id: null }),
    `/join/${"a".repeat(43)}`,
  ])
    assert.ok(claims(components, path), path);
  for (const path of [
    "/api/health",
    "/api/screenr/feed",
    "/api/auth/callback/google",
    "/login?next=%2Faccount",
    "/setup",
    "/credits",
    "/privacy",
    "/.well-known/apple-app-site-association",
    "/manifest.webmanifest",
  ])
    assert.ok(!claims(components, path), path);
});
