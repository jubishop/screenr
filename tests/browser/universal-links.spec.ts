import { expect } from "@playwright/test";
import { test } from "./monitored-test";

// Apple fetches the association signed out and follows no redirects, so the
// member routes' sign-in redirect must not catch it.
test("the universal-link association is served directly as JSON", async ({
  request,
}) => {
  const response = await request.get(
    "/.well-known/apple-app-site-association",
    { maxRedirects: 0 },
  );
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/json");
  const { applinks } = await response.json();
  expect(applinks.details[0].appIDs).toEqual([
    "34TKMKM889.com.artisanalsoftware.Screenr",
  ]);
});
