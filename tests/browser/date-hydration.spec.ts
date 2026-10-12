import { expect } from "@playwright/test";
import { test } from "./member-fixture";
import { db } from "./database-fixture";

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
        const format = Date.prototype.toLocaleDateString;
        Date.prototype.toLocaleDateString = function (
          locales?: Intl.LocalesArgument,
          options?: Intl.DateTimeFormatOptions,
        ) {
          const label = format.call(this, locales, options);
          return options?.hour ? label.replace(/(\d{4}), /, "$1 at ") : label;
        };
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
      // signIn's teardown asserts no hydration console errors or page errors
      // across every document load above, including both repeated reloads.
    });
  });
}
