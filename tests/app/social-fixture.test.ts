import { test, mock } from "node:test";
import assert from "node:assert/strict";

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
  SENTRY_DSN: "https://inherited-key@sentry.example.test/1",
};
Object.assign(process.env, inherited);
await import("./social-fixture");
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
