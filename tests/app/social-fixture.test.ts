import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

// Values a developer shell might export. They are set before the shared setup
// loads, as an inherited environment would be.
const inherited = {
  TMDB_READ_TOKEN: "inherited-tmdb-token",
  SCREENR_TEST_TMDB_URL: "http://127.0.0.1:9",
  EMAIL_TRANSPORT: "resend",
  RESEND_API_KEY: "inherited-resend-key",
  EMAIL_FROM: "Inherited <inherited@example.test>",
  GOOGLE_CLIENT_ID: "inherited-google-client",
  GOOGLE_CLIENT_SECRET: "inherited-google-secret",
  GOOGLE_IOS_CLIENT_ID: "inherited-google-ios-client",
  APPLE_TEAM_ID: "INHERITED1",
  APPLE_KEY_ID: "INHERITED2",
  APPLE_PRIVATE_KEY: "aW5oZXJpdGVkLWtleQ==",
  SENTRY_DSN: "https://inherited-key@sentry.example.test/1",
};
Object.assign(process.env, inherited);
const { assertNotLogged } = await import("./social-fixture");
const { searchTitles } = await import("../../src/server/catalog");

test("the shared setup clears provider credentials inherited from the shell", async () => {
  for (const name of Object.keys(inherited))
    assert.equal(process.env[name], undefined, `${name} must be cleared`);
  const fetch = mock.method(globalThis, "fetch", async () =>
    Response.json({ results: [] }),
  );
  await assert.rejects(searchTitles("lantern"), {
    status: 503,
    message: "The movie catalog is not configured yet.",
  });
  assert.equal(fetch.mock.callCount(), 0, "no catalog request may be sent");
});

// Stack frames name files by the checkout's path, which can hold any word, as
// every checkout under macOS's /private/tmp holds "private" (#487).
test("a check that values were never logged ignores each word of the checkout's own path, and only there", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url)).replace(
    /\/$/,
    "",
  );
  // A frame names the path or its file URL, and a JSON line escapes the path.
  const lines = [root, pathToFileURL(root).href, JSON.stringify(root)];
  const words = root.split("/").filter(Boolean);
  assertNotLogged(lines, words);
  for (const word of words)
    assert.throws(() => assertNotLogged([...lines, word], [word]), {
      message: `Logged ${word}`,
    });
});
