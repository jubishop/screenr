import { expect, type Response } from "@playwright/test";
import { test } from "./monitored-test";
import { db } from "./database-fixture";
import { userId } from "./member-fixture";
import { commits, countCommits } from "./refresh-helpers";

const { updateTitleActivity } = await import("../../src/server/title-actions");
const { addComment } = await import("../../src/server/comments");
const { createInvitation } = await import("../../src/server/invitations");

for (const [index, timezoneId] of ["UTC", "America/Los_Angeles"].entries()) {
  test.describe(timezoneId, () => {
    test.use({ timezoneId });

    test("dates hydrate across runtime formats and then show the reader's local and relative times", async ({
      page,
      signIn,
    }) => {
      // Safari uses "at" where Node uses a comma. Change only the external
      // runtime formatter; the real server HTML and React hydration still run.
      await page.addInitScript(() => {
        const prototype = Intl.DateTimeFormat.prototype;
        const format = Object.getOwnPropertyDescriptor(prototype, "format")!;
        Object.defineProperty(prototype, "format", {
          get(this: Intl.DateTimeFormat) {
            const original = format.get!.call(this);
            const { hour } = this.resolvedOptions();
            return (date?: Date | number) => {
              const label = original(date);
              return hour ? label.replace(/(\d{4}), /, "$1 at ") : label;
            };
          },
        });
      });
      const owner = await signIn(page, `dateviewer${index}`);
      const year = new Date().getUTCFullYear() + 1;
      const instant = `${year}-01-02T00:30:00.000Z`;
      const localDay = timezoneId === "UTC" ? 2 : 1;
      const localTime = timezoneId === "UTC" ? "12:30 AM UTC" : "4:30 PM PST";
      // Relative times count from the reader's clock, fixed two hours after
      // the entry's activity. The reply is older than a week in the same year.
      const now = `${year}-03-01T20:00:00.000Z`;
      const activity = `${year}-03-01T18:00:00.000Z`;
      const activityTime = timezoneId === "UTC" ? "6:00 PM" : "10:00 AM";
      const titleIds = [998860 + index * 2, 998861 + index * 2];
      for (const [variant, id] of titleIds.entries()) {
        await db.query(
          `INSERT INTO title(id,kind,tmdb_id,name,release_date) VALUES($1,'movie',$2,'Date boundary',$3)`,
          [`movie:${id}`, id, variant ? "" : "1999-05-01"],
        );
        await db.query(
          `INSERT INTO title_availability(title_id,country,availability,fetched_at,refresh_after)
           VALUES($1,'US',$2,$3,$3)`,
          [
            `movie:${id}`,
            {
              link: null,
              providers: variant
                ? {}
                : {
                    flatrate: [
                      {
                        provider_id: 8,
                        provider_name: "Netflix",
                        logo_path: null,
                      },
                    ],
                  },
            },
            instant,
          ],
        );
      }
      const item = await updateTitleActivity(
        owner,
        `movie:${titleIds[0]}`,
        "recommended",
        true,
      );
      const reply = await addComment(owner, item, "Date boundary reply", false);
      await db.query("UPDATE feed_item SET activity_at=$1 WHERE id=$2", [
        activity,
        item,
      ]);
      // An entry from the previous year shows its year, in both time zones.
      const earlier = await updateTitleActivity(
        owner,
        `movie:${titleIds[1]}`,
        "recommended",
        true,
      );
      await db.query("UPDATE feed_item SET activity_at=$1 WHERE id=$2", [
        `${year - 1}-12-31T12:00:00.000Z`,
        earlier,
      ]);
      await db.query("UPDATE comment SET created_at=$1 WHERE id=$2", [
        instant,
        reply,
      ]);
      const invitation = await createInvitation(owner);
      await db.query("UPDATE invitation SET expires_at=$1 WHERE id=$2", [
        instant,
        invitation.id,
      ]);

      await page.clock.setFixedTime(now);
      for (const [variant, id] of titleIds.entries()) {
        await page.goto(`/titles/movie/${id}`);
        const availability = page.getByRole("region", {
          name: "Where to watch",
        });
        for (let load = 0; load < 3; load++) {
          if (load) await page.reload();
          await expect(availability.locator("time")).toHaveAttribute(
            "datetime",
            instant,
          );
          await expect(availability.locator("time")).toHaveText(
            `Jan ${localDay}, ${year} at ${localTime}`,
          );
          await expect(
            page
              .getByRole("button", { name: "+ Want to watch", exact: true })
              .first(),
          ).toBeEnabled();
          await expect(
            availability.getByText(
              variant
                ? "No subscription or free options are listed for the US."
                : "Netflix",
              { exact: true },
            ),
          ).toBeVisible();
        }
      }

      await page.goto("/");
      const entry = page.locator(`[data-item-id="${item}"]`);
      // The author line carries the activity time; the metadata line carries
      // the release year, or only the kind without a release date.
      await expect(entry.locator(".activity-by")).toContainText(
        `dateviewer${index} recommends · 2h`,
      );
      await expect(entry.locator(".activity-content > .small")).toHaveText(
        "Movie · 1999",
      );
      const feedDate = entry.locator(".activity-by time");
      await expect(feedDate).toHaveAttribute("datetime", activity);
      await expect(feedDate).toHaveAttribute(
        "title",
        `Mar 1, ${year} at ${activityTime}`,
      );
      const replyDate = entry.locator(`[data-comment-id="${reply}"] time`);
      expect(
        new Date((await replyDate.getAttribute("datetime"))!).toISOString(),
      ).toBe(instant);
      await expect(replyDate).toHaveText(`Jan ${localDay}`);
      await expect(replyDate).toHaveAttribute(
        "title",
        `Jan ${localDay}, ${year} at ${localTime.slice(0, -4)}`,
      );
      const undated = page.locator(`[data-item-id="${earlier}"]`);
      await expect(undated.locator(".activity-by")).toContainText(
        `dateviewer${index} recommends · Dec 31, ${year - 1}`,
      );
      await expect(undated.locator(".activity-content > .small")).toHaveText(
        "Movie",
      );
      await page.goto("/invites");
      await expect(page.locator(".invite-card")).toContainText(
        `Expires 1/${localDay}/${year}`,
      );

      // Server HTML must remain useful even when scripts never run. This also
      // checks that the UTC fallback preserves the original semantic timestamp.
      const titleResponse = await page.request.get(
        `/titles/movie/${titleIds[0]}`,
      );
      expect(titleResponse.ok()).toBe(true);
      const serverDates = await page.evaluate(
        (html) => {
          const document = new DOMParser().parseFromString(html, "text/html");
          return [...document.querySelectorAll("time")].map((time) => ({
            value: time.dateTime,
            label: time.textContent,
            title: time.title,
          }));
        },
        await titleResponse.text(),
      );
      expect(serverDates).toHaveLength(3);
      expect(serverDates[0]).toEqual({
        value: instant,
        label: expect.stringMatching(new RegExp(`${year}.*UTC`)),
        title: "",
      });
      // Relative times wait for the reader's clock and time zone.
      expect(serverDates[1]).toEqual({
        value: activity,
        label: `${year}-03-01`,
        title: `${year}-03-01 18:00 UTC`,
      });
      expect(serverDates.every(({ label }) => /\d/.test(label ?? ""))).toBe(
        true,
      );
      const inviteResponse = await page.request.get("/invites");
      expect(inviteResponse.ok()).toBe(true);
      const serverInvite = await page.evaluate(
        (html) => {
          const document = new DOMParser().parseFromString(html, "text/html");
          return document.querySelector(".invite-card")?.textContent;
        },
        await inviteResponse.text(),
      );
      expect(serverInvite).toContain("Expires");
      expect(serverInvite).toContain(String(year));
      // The monitored fixture asserts no hydration console errors or page
      // errors across every document load above, including both reloads.
    });
  });
}

test("a minute renders shown times again only when their text changes", async ({
  member,
}) => {
  const page = await member("minuteviewer");
  const owner = await userId(page);
  const week = 7 * 24 * 60 * 60_000;
  const year = new Date().getUTCFullYear() + 1;
  // One minute before midnight on New Year's Eve in Los Angeles, the
  // member's time zone, which is 08:00 UTC on January 1.
  const start = Date.parse(`${year + 1}-01-01T07:59:00.000Z`);
  // One entry turns a week old at midnight, and one is older.
  const entries: string[] = [];
  for (const [index, activity] of [
    start - week + 30_000,
    Date.parse(`${year}-10-05T19:00:00.000Z`),
  ].entries()) {
    const title = `movie:${998870 + index}`;
    await db.query(
      `INSERT INTO title(id,kind,tmdb_id,name) VALUES($1,'movie',$2,'Minute boundary')`,
      [title, 998870 + index],
    );
    const item = await updateTitleActivity(owner, title, "recommended", true);
    await db.query("UPDATE feed_item SET activity_at=$1 WHERE id=$2", [
      new Date(activity).toISOString(),
      item,
    ]);
    entries.push(item);
  }
  const [weekOld, older] = entries.map((item) =>
    page.locator(`[data-item-id="${item}"] .activity-by time`),
  );
  await countCommits(page);
  // Paused timers run only when the test advances the clock. Each advance
  // waits for the screen read it starts, so no read is pending at the next.
  await page.clock.install({ time: start - 1000 });
  await page.clock.pauseAt(start);
  const isScreenRead = (response: Response) =>
    new URL(response.url()).pathname === "/api/screenr/screen";
  const advance = async () => {
    const read = page
      .waitForResponse(isScreenRead, { timeout: 5000 })
      .catch(() => null);
    await page.clock.fastForward(60_000);
    await (await read)?.finished();
  };
  await page.goto("/");
  await expect(weekOld).toHaveText("6d");
  await expect(older).toHaveText("Oct 5");

  // At midnight the week-old time becomes a date, and both dates gain the
  // year that just ended.
  await advance();
  await expect(weekOld).toHaveText(`Dec 24, ${year}`);
  await expect(older).toHaveText(`Oct 5, ${year}`);

  // A minute later neither text changes, so nothing renders.
  const rendered = await commits(page);
  await advance();
  expect(await commits(page)).toBe(rendered);
  await expect(weekOld).toHaveText(`Dec 24, ${year}`);
  await expect(older).toHaveText(`Oct 5, ${year}`);
});
