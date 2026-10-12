import { test } from "node:test";
import assert from "node:assert/strict";
import { memberPath, parseMemberRoute } from "../../src/member-routes";

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
    ["/people", { kind: "people" }],
    ["/invites", { kind: "invites" }],
    ["/account?error=access_denied", { kind: "account" }],
    ["/watch-together", { kind: "watch-together", with: [] }],
    [
      "/watch-together?with=ben&with=&with=cam",
      { kind: "watch-together", with: ["ben", "", "cam"] },
    ],
    ["/titles/movie/42", { kind: "title", id: "movie:42" }],
    [
      "/titles/tv/7?item=post&reply=answer",
      { kind: "title", id: "tv:7", item: "post", reply: "answer" },
    ],
    ["/people/Alice", { kind: "profile", username: "Alice" }],
    ["/people/a%20b", { kind: "profile", username: "a b" }],
    [
      "/conversations/legacy?reply=old",
      { kind: "conversation", id: "legacy", reply: "old" },
    ],
  ] as const;
  for (const [path, route] of cases) assert.deepEqual(parse(path), route, path);
  assert.deepEqual(parse("/?item=&reply="), { kind: "feed" });
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
    "/conversations",
    "/%E0%A4%A",
  ])
    assert.equal(parseMemberRoute(path).kind, "not-found", path);
});

test("member paths keep only each screen's parameters and round-trip", () => {
  for (const [path, canonical] of [
    ["/?item=post&reply=answer&utm=x", "/?item=post&reply=answer"],
    ["/?item=", "/"],
    ["/search?item=post", "/search"],
    ["/account?error=access_denied", "/account"],
    ["/people/alice?item=post", "/people/alice"],
    ["/people/a%20b", "/people/a%20b"],
    [
      "/titles/movie/42?reply=answer&item=post",
      "/titles/movie/42?item=post&reply=answer",
    ],
    ["/titles/movie/1%3Fitem%3Dx", "/titles/movie/1%3Fitem%3Dx"],
    ["/watch-together?with=ben&with=&x=1", "/watch-together?with=ben&with="],
    [
      "/conversations/legacy?reply=old&item=x",
      "/conversations/legacy?reply=old",
    ],
    ["/unknown?item=post", "/unknown"],
  ]) {
    assert.equal(memberPath(parseMemberRoute(path)), canonical, path);
    assert.deepEqual(
      parseMemberRoute(canonical),
      parseMemberRoute(path),
      canonical,
    );
  }
});
