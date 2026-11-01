import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loginPath,
  memberPath,
  memberTitle,
  parseMemberRoute,
  returnPath,
  setupPath,
} from "../../src/member-routes";

// Absent and empty parameters both parse as missing.
const parse = (path: string) =>
  Object.fromEntries(
    Object.entries(parseMemberRoute(path)).filter(([, value]) => value),
  );

test("member routes name each screen and its parameters", () => {
  const cases = [
    ["/", { kind: "feed" }],
    [
      "/?item=post&reply=answer",
      { kind: "feed", item: "post", reply: "answer" },
    ],
    ["/search", { kind: "search" }],
    ["/search?q=Severance", { kind: "search", q: "Severance" }],
    ["/search?q=+The%20Office+", { kind: "search", q: "The Office" }],
    [
      "/search?tab=friends-recommend",
      { kind: "search", tab: "friends-recommend" },
    ],
    [
      "/search?q=Lost&tab=friends-recommend",
      { kind: "search", q: "Lost", tab: "friends-recommend" },
    ],
    ["/people", { kind: "people" }],
    ["/invites", { kind: "invites" }],
    ["/account?error=access_denied", { kind: "account" }],
    ["/watch-together", { kind: "watch-together", with: [] }],
    [
      "/watch-together?with=ben&with=&with=cam",
      { kind: "watch-together", with: ["ben", "", "cam"] },
    ],
    [
      "/watch-together?with=ben&mode=theaters",
      { kind: "watch-together", with: ["ben"], mode: "theaters" },
    ],
    ["/titles/movie/42", { kind: "title", id: "movie:42" }],
    [
      "/titles/tv/7?item=post&reply=answer",
      { kind: "title", id: "tv:7", item: "post", reply: "answer" },
    ],
    ["/people/Alice", { kind: "profile", username: "Alice" }],
    ["/people/a%20b", { kind: "profile", username: "a b" }],
    [
      "/people/Alice/want-to-watch",
      { kind: "want-to-watch", username: "Alice" },
    ],
    [
      "/people/a%20b/want-to-watch?item=x",
      { kind: "want-to-watch", username: "a b" },
    ],
    [
      "/people/Alice/want-to-watch?mode=theaters",
      { kind: "want-to-watch", username: "Alice", mode: "theaters" },
    ],
    [
      "/conversations/legacy?reply=old",
      { kind: "conversation", id: "legacy", reply: "old" },
    ],
  ] as const;
  for (const [path, route] of cases) assert.deepEqual(parse(path), route, path);
  assert.deepEqual(parse("/?item=&reply="), { kind: "feed" });
  assert.deepEqual(parse("/search?q=%20%20"), { kind: "search" });
  // Suggestions is the default tab, so only Friends recommend is named.
  for (const tab of ["", "suggestions", "Friends-Recommend", "other"])
    assert.deepEqual(parse(`/search?tab=${tab}`), { kind: "search" }, tab);
  // At home is the default mode, so only In theaters is named.
  for (const mode of ["", "home", "Theaters", "other"]) {
    assert.deepEqual(
      parse(`/people/alice/want-to-watch?mode=${mode}`),
      { kind: "want-to-watch", username: "alice" },
      mode,
    );
    assert.deepEqual(
      parse(`/watch-together?with=ben&mode=${mode}`),
      { kind: "watch-together", with: ["ben"] },
      mode,
    );
  }
  assert.deepEqual(parse("/titles/movie/42?item="), {
    kind: "title",
    id: "movie:42",
  });
});

test("member routes reject unknown paths and extra segments", () => {
  for (const path of [
    "/unknown",
    "/search/extra",
    "/watch-together/ben",
    "/titles/movie",
    "/titles/movie/42/extra",
    "/people/alice/friends",
    "/people/alice/want-to-watch/extra",
    "/people/alice/Want-to-watch",
    "/conversations",
    "/%E0%A4%A",
  ])
    assert.equal(parseMemberRoute(path).kind, "not-found", path);
});

// Requested paths and their canonical member paths.
const canonicalPaths = [
  ["/?item=post&reply=answer&utm=x", "/?item=post&reply=answer"],
  ["/?item=", "/"],
  ["/search?item=post", "/search"],
  ["/search?item=post&q=The%20Office", "/search?q=The+Office"],
  ["/search?q=+Lost+", "/search?q=Lost"],
  ["/search?q=", "/search"],
  ["/search?tab=friends-recommend", "/search?tab=friends-recommend"],
  [
    "/search?q=Lost&tab=friends-recommend",
    "/search?tab=friends-recommend&q=Lost",
  ],
  ["/search?tab=other&q=Lost", "/search?q=Lost"],
  ["/?tab=friends-recommend", "/"],
  ["/?q=Lost", "/"],
  ["/account?error=access_denied", "/account"],
  ["/people/alice?item=post", "/people/alice"],
  ["/people/a%20b", "/people/a%20b"],
  ["/people/alice/want-to-watch?q=x", "/people/alice/want-to-watch"],
  ["/people/a%20b/want-to-watch", "/people/a%20b/want-to-watch"],
  [
    "/people/alice/want-to-watch?mode=theaters&item=x",
    "/people/alice/want-to-watch?mode=theaters",
  ],
  ["/people/alice/want-to-watch?mode=home", "/people/alice/want-to-watch"],
  ["/people/alice?mode=theaters", "/people/alice"],
  ["/search?mode=theaters", "/search"],
  [
    "/titles/movie/42?reply=answer&item=post",
    "/titles/movie/42?item=post&reply=answer",
  ],
  ["/titles/movie/1%3Fitem%3Dx", "/titles/movie/1%3Fitem%3Dx"],
  ["/watch-together?with=ben&with=&x=1", "/watch-together?with=ben&with="],
  [
    "/watch-together?mode=theaters&with=ben",
    "/watch-together?with=ben&mode=theaters",
  ],
  ["/watch-together?with=ben&mode=other", "/watch-together?with=ben"],
  ["/conversations/legacy?reply=old&item=x", "/conversations/legacy?reply=old"],
  ["/unknown?item=post", "/unknown"],
];

function assertCanonicalPaths() {
  for (const [path, canonical] of canonicalPaths) {
    assert.equal(memberPath(parseMemberRoute(path)), canonical, path);
    assert.deepEqual(
      parseMemberRoute(canonical),
      parseMemberRoute(path),
      canonical,
    );
  }
}

test("member paths keep only each screen's parameters and round-trip", () => {
  assertCanonicalPaths();
});

// Safari before 17, a supported browser, has no URLSearchParams size
// (docs/interface-design.md#supported-browsers--2026-11-01).
test("member paths keep their parameters without URLSearchParams size", (t) => {
  const size = Object.getOwnPropertyDescriptor(
    URLSearchParams.prototype,
    "size",
  )!;
  Reflect.deleteProperty(URLSearchParams.prototype, "size");
  t.after(() => Object.defineProperty(URLSearchParams.prototype, "size", size));
  assert.equal("size" in URLSearchParams.prototype, false);
  assertCanonicalPaths();
});

test("return paths keep same-origin member pages in canonical form", () => {
  for (const [next, path] of [
    ["/", "/"],
    ["/?item=post&reply=answer", "/?item=post&reply=answer"],
    [
      "/titles/movie/42?item=post&reply=answer&utm=x",
      "/titles/movie/42?item=post&reply=answer",
    ],
    ["/search?q=The%20Office", "/search?q=The+Office"],
    ["/search?tab=friends-recommend", "/search?tab=friends-recommend"],
    ["/people/alice#friends", "/people/alice"],
    ["/people/%2F%2Fevil.example", "/people/%2F%2Fevil.example"],
    ["/conversations/legacy?reply=old", "/conversations/legacy?reply=old"],
    ["/watch-together?with=ben", "/watch-together?with=ben"],
    [
      "/watch-together?with=ben&mode=theaters",
      "/watch-together?with=ben&mode=theaters",
    ],
    ["/people/ben/want-to-watch", "/people/ben/want-to-watch"],
    [
      "/people/ben/want-to-watch?mode=theaters",
      "/people/ben/want-to-watch?mode=theaters",
    ],
    ["/account?error=access_denied", "/account"],
  ])
    assert.equal(returnPath(next), path, next);
});

test("return paths ignore external, ambiguous, and non-member values", () => {
  for (const next of [
    undefined,
    null,
    "",
    ["/people"],
    "people",
    "https://evil.example/people",
    "http://screenr.local/people",
    "//evil.example/people",
    "///evil.example/people",
    "/\\evil.example/people",
    "\\/evil.example/people",
    "/\tevil.example",
    "/\t/evil.example/people",
    "/\n/evil.example/people",
    "javascript:alert(1)",
    "%2F%2Fevil.example",
    "/%2F%2Fevil.example",
    "/%5Cevil.example",
    "/login",
    "/login?next=%2Fpeople",
    "/setup",
    "/join/token",
    "/api/screenr/screen",
    "/credits",
    "/privacy",
    "/titles/movie",
    "/unknown",
    "/%E0%A4%A",
  ])
    assert.equal(returnPath(next), undefined, JSON.stringify(next));
});

test("sign-in and setup links carry only a valid return path", () => {
  const reply = "/titles/movie/42?item=post&reply=answer";
  const encoded = "%2Ftitles%2Fmovie%2F42%3Fitem%3Dpost%26reply%3Danswer";
  assert.equal(loginPath(reply), `/login?next=${encoded}`);
  assert.equal(setupPath(reply), `/setup?next=${encoded}`);
  assert.equal(
    new URL(loginPath(reply), "http://screenr.local").searchParams.get("next"),
    reply,
  );
  for (const next of [undefined, "/", "//evil.example/", "/login"]) {
    assert.equal(loginPath(next), "/login", String(next));
    assert.equal(setupPath(next), "/setup", String(next));
  }
});

test("member page titles name each screen, title, or person", () => {
  const title = (path: string, data?: Parameters<typeof memberTitle>[1]) =>
    memberTitle(parseMemberRoute(path), data);
  for (const [path, name] of [
    ["/", "Your circle"],
    ["/?item=post&reply=answer", "Your circle"],
    ["/search", "Find a title"],
    ["/search?q=Severance", "Find a title"],
    ["/people", "Friends"],
    ["/invites", "Invite friends"],
    ["/account?error=access_denied", "Account"],
    ["/watch-together?with=ben", "Watch together"],
    ["/conversations/legacy", "Conversation"],
    ["/unknown", "Page not found"],
    ["/titles/movie/42/extra", "Page not found"],
  ])
    assert.equal(title(path), `${name} · Screenr`, path);
  assert.equal(
    title("/titles/movie/42?item=post", {
      kind: "title",
      title: { name: "The Lantern Room" },
    }),
    "The Lantern Room · Screenr",
  );
  assert.equal(
    title("/people/alice", {
      kind: "profile",
      profile: { display_name: "Alice Smith" },
    }),
    "Alice Smith · Screenr",
  );
  // Before a title or profile loads, or after it fails, the route names it.
  // Another screen's data never names the page.
  assert.equal(title("/titles/movie/42"), "Movie · Screenr");
  assert.equal(title("/titles/tv/7", null), "TV show · Screenr");
  assert.equal(
    title("/titles/tv/7", { kind: "profile", profile: { display_name: "A" } }),
    "TV show · Screenr",
  );
  assert.equal(title("/people/a%20b"), "@a b · Screenr");
  assert.equal(
    title("/people/alice", { kind: "title", title: { name: "Lost" } }),
    "@alice · Screenr",
  );
  // A Want to watch page names its owner once their profile loads.
  assert.equal(
    title("/people/ben/want-to-watch", {
      kind: "want-to-watch",
      owner: { display_name: "Ben Rivera" },
    }),
    "Want to watch · Ben Rivera · Screenr",
  );
  assert.equal(
    title("/people/ben/want-to-watch"),
    "Want to watch · @ben · Screenr",
  );
  assert.equal(
    title("/people/ben/want-to-watch", {
      kind: "profile",
      profile: { display_name: "Ben Rivera" },
    }),
    "Want to watch · @ben · Screenr",
  );
});
