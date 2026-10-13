import { expect, type Response } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";
import { commits, countCommits, nextPoll } from "./refresh-helpers";

const isScreenRead = (response: Response) =>
  new URL(response.url()).pathname === "/api/screenr/screen";

test("unchanged refreshes send no body and render nothing, while changes and times still update", async ({
  member,
}) => {
  const poster = await member("unchangedposter");
  const viewer = await member("unchangedviewer");
  await prepareFriendship(poster, viewer);
  const post = async (action: string, data: object) => {
    const response = await poster.request.post(`/api/screenr/${action}`, {
      headers: { Origin: browserConfig.baseURL },
      data,
    });
    expect(response.status()).toBe(200);
    return (await response.json()).id as string;
  };
  const entry = await post("activity", {
    title: "movie:987654",
    field: "recommended",
    value: true,
  });
  const reads: Response[] = [];
  viewer.on("response", (response) => {
    if (isScreenRead(response)) reads.push(response);
  });
  await countCommits(viewer);
  // Paused timers poll only when the test advances the viewer's clock.
  await viewer.clock.install();
  await viewer.clock.pauseAt(Date.now() + 1000);
  await viewer.goto("/");
  const item = viewer.locator(`[data-item-id="${entry}"]`);
  const time = item.locator("time").first();
  await expect(time).toHaveText("now");
  await item.getByRole("button", { name: "Comment", exact: true }).click();
  const draft = viewer.getByLabel("Add your reply");
  await draft.fill("Keep this unsent reply");
  // The page brought its first screen, so loading it didn't read again.
  expect(reads).toHaveLength(0);

  const rendered = await commits(viewer);
  expect(rendered).toBeGreaterThan(0);
  let version: string | null = null;
  for (let poll = 0; poll < 2; poll++) {
    const read = await nextPoll(viewer, isScreenRead);
    expect(read.status()).toBe(304);
    expect((await read.request().sizes()).responseBodySize).toBe(0);
    version ??= await read.request().headerValue("if-none-match");
    expect(await read.request().headerValue("if-none-match")).toBe(version);
  }
  expect(version).toMatch(/^W\/"[\w-]{43}"$/);
  expect(await commits(viewer)).toBe(rendered);
  await expect(draft).toHaveValue("Keep this unsent reply");

  // A change sends the whole screen, which the page renders.
  await post("comment", {
    conversation: entry,
    body: "A reply after quiet refreshes",
    spoiler: false,
  });
  const changed = await nextPoll(viewer, isScreenRead);
  expect(changed.status()).toBe(200);
  expect((await changed.request().sizes()).responseBodySize).toBeGreaterThan(0);
  const newActivity = viewer.getByRole("button", { name: /New activity/ });
  await expect(newActivity).toBeVisible();
  expect(await commits(viewer)).toBeGreaterThan(rendered);
  const latest = await nextPoll(viewer, isScreenRead);
  expect(latest.status()).toBe(304);
  expect(await latest.request().headerValue("if-none-match")).toBe(
    changed.headers().etag,
  );

  // Relative times advance without a changed refresh.
  await expect(time).toHaveText("now");
  await viewer.clock.fastForward(60_000);
  await expect(time).toHaveText("1m");
  await newActivity.click();
  await expect(
    viewer.getByText("A reply after quiet refreshes", { exact: true }),
  ).toBeVisible();
  await expect(draft).toHaveValue("Keep this unsent reply");
});
