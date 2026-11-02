import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, captureFailures } from "./social-fixture";
import { fakeGoogle, serve } from "./identity-providers";

const { runWorkerPass } = await import("../../src/server/email");
useDatabase();
afterEach(() => {
  mock.restoreAll();
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

const minute = 60 * 1000;
const hour = 60 * minute;

test("the worker's cleanup checks Google's web client at most once an hour, logging google client rejected for a rejected secret and nothing for a working one, a network failure, or no Google settings", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 1, 12) });
  const google = fakeGoogle();
  serve(google);
  const printed = captureFailures(t);

  // Without the web client's settings, the web has no Google sign-in to check.
  await runWorkerPass(0);
  process.env.GOOGLE_CLIENT_ID = google.webClient.id;
  await runWorkerPass(0);
  assert.equal(google.exchanges.length, 0);
  delete process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = google.webClient.secret;
  await runWorkerPass(0);
  assert.equal(google.exchanges.length, 0);

  // Working settings: Google authenticates the client, then rejects the
  // dummy code as invalid_grant, which logs nothing. The exchange names the
  // registered callback: Google refuses one that breaks its policy before it
  // checks the client.
  process.env.GOOGLE_CLIENT_ID = google.webClient.id;
  await runWorkerPass(0);
  assert.equal(google.exchanges.length, 1);
  const exchange = Object.fromEntries(google.exchanges[0]);
  assert.deepEqual(
    {
      grant_type: exchange.grant_type,
      client_id: exchange.client_id,
      client_secret: exchange.client_secret,
      redirect_uri: exchange.redirect_uri,
    },
    {
      grant_type: "authorization_code",
      client_id: google.webClient.id,
      client_secret: google.webClient.secret,
      redirect_uri: "http://localhost:3000/api/auth/callback/google",
    },
  );
  assert.ok(exchange.code, "The exchange carries a dummy code");
  assert.deepEqual(printed, []);

  // A rotated secret waits for the next hour's check, and passes between
  // cleanups never check.
  process.env.GOOGLE_CLIENT_SECRET = "rotated-secret";
  t.mock.timers.tick(hour - minute);
  await runWorkerPass(60);
  t.mock.timers.tick(minute);
  await runWorkerPass(61);
  assert.equal(google.exchanges.length, 1);

  // Google rejects the client: only the status and Google's error code are
  // logged, never its description or the secrets.
  await runWorkerPass(120);
  assert.equal(google.exchanges.length, 2);
  assert.deepEqual(
    printed.map((line) => JSON.parse(line)),
    [
      {
        event: "google client rejected",
        status: 401,
        reason: "invalid_client",
      },
    ],
  );
  for (const value of ["Unauthorized", "rotated-secret", exchange.code])
    assert.ok(!printed.join("\n").includes(value), `Logged ${value}`);

  // A Google outage says nothing about the client and never fails the pass.
  printed.length = 0;
  const unreachable = t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  t.mock.timers.tick(hour);
  await runWorkerPass(180);
  assert.equal(unreachable.mock.callCount(), 1);
  assert.deepEqual(printed, []);
});
