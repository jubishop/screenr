import { expect } from "@playwright/test";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";
import { browserConfig } from "../../scripts/browser-config";

test("prepared member sessions keep concurrent setup, access, and sign-out independent", async ({
  member,
}) => {
  const [owner, viewer, pending] = await Promise.all([
    member("fixtureowner"),
    member("fixturereader"),
    member("fixturepending", { complete: false }),
  ]);
  const screen = (page: typeof owner) =>
    page.request.get("/api/screenr/screen?path=%2Faccount");
  const [ownerScreen, viewerScreen] = await Promise.all([
    screen(owner),
    screen(viewer),
  ]);
  expect(ownerScreen.status()).toBe(200);
  expect(viewerScreen.status()).toBe(200);
  const ownerUser = (await ownerScreen.json()).user;
  const viewerUser = (await viewerScreen.json()).user;
  expect(ownerUser.username).toBe("fixtureowner");
  expect(viewerUser.username).toBe("fixturereader");
  expect(ownerUser.user_id).not.toBe(viewerUser.user_id);
  expect((await screen(pending)).status()).toBe(403);
  const activity = await owner.request.post("/api/screenr/activity", {
    headers: { Origin: browserConfig.baseURL },
    data: { title: "movie:987654", field: "recommended", value: true },
  });
  expect(activity.status()).toBe(200);
  const { id } = await activity.json();
  const read = () =>
    viewer.request.get(`/api/screenr/screen?path=/conversations/${id}`);
  expect((await read()).status()).toBe(404);
  await prepareFriendship(owner, viewer);
  expect((await read()).status()).toBe(200);
  const signOut = await owner.request.post("/api/auth/sign-out", {
    headers: { Origin: browserConfig.baseURL },
    data: {},
  });
  expect(signOut.status()).toBe(200);
  expect((await screen(owner)).status()).toBe(401);
  expect((await screen(viewer)).status()).toBe(200);
  expect((await read()).status()).toBe(200);
});
