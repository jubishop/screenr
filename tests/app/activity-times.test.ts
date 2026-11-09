import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  changesEachMinute,
  dateLabel,
  readerCalendar,
  relativeTime,
} from "../../src/components/client";
import { ActivityTime } from "../../src/components/activity-time";

const minute = 60_000,
  hour = 60 * minute,
  day = 24 * hour;
const now = Date.parse("2026-10-12T15:30:00.000Z");
const ago = (elapsed: number) => new Date(now - elapsed).toISOString();

test("activity times from the reader's current day count minutes and hours", () => {
  // It is 3:30 PM in UTC and 8:30 AM in Los Angeles.
  for (const [elapsed, label] of [
    [0, "now"],
    [minute - 1, "now"],
    [minute, "1m"],
    [5 * minute + 59_999, "5m"],
    [hour - 1, "59m"],
    [hour, "1h"],
    [2 * hour + 30 * minute, "2h"],
  ] as const)
    for (const timeZone of ["UTC", "America/Los_Angeles"])
      assert.equal(relativeTime(ago(elapsed), now, timeZone), label);
  // The reader's local midnight starts their day. It is already 12:30 AM on
  // October 13 in Tokyo.
  for (const [timeZone, today, label, yesterday] of [
    ["UTC", 15 * hour + 30 * minute, "15h", "Oct 11"],
    ["America/Los_Angeles", 8 * hour + 30 * minute, "8h", "Oct 11"],
    ["Asia/Tokyo", 30 * minute, "30m", "Oct 12"],
  ] as const) {
    assert.equal(relativeTime(ago(today), now, timeZone), label);
    assert.equal(relativeTime(ago(today + 1), now, timeZone), yesterday);
  }
});

test("activity times before the reader's current day show the date, however recent", () => {
  const pacific = "America/Los_Angeles";
  // At 9:00 AM, activity from yesterday evening, 20 hours ago, shows its date.
  const morning = Date.parse("2026-11-08T17:00:00Z");
  assert.equal(relativeTime("2026-11-07T21:00:00Z", morning, pacific), "Nov 7");
  // Thirty seconds after midnight, ten seconds before it was yesterday.
  const midnight = Date.parse("2026-11-08T08:00:00Z");
  assert.equal(
    relativeTime("2026-11-08T07:59:50Z", midnight + 30_000, pacific),
    "Nov 7",
  );
  assert.equal(
    relativeTime("2026-11-08T08:00:10Z", midnight + 30_000, pacific),
    "now",
  );
  // Days no longer count up under a week.
  for (const [elapsed, label] of [
    [day, "Oct 11"],
    [3 * day + 23 * hour, "Oct 8"],
    [7 * day - 1, "Oct 5"],
  ] as const)
    assert.equal(relativeTime(ago(elapsed), now, "UTC"), label);
});

test("dates show the reader's local date, with the year only outside the current year", () => {
  assert.equal(relativeTime(ago(7 * day), now, "UTC"), "Oct 5");
  assert.equal(relativeTime("2026-02-14T12:00:00Z", now, "UTC"), "Feb 14");
  assert.equal(
    relativeTime("2025-10-12T15:30:00Z", now, "UTC"),
    "Oct 12, 2025",
  );
  // Midnight on January 1 in Los Angeles is 08:00 UTC.
  const lastOf2025 = "2026-01-01T07:59:00Z";
  assert.equal(relativeTime(lastOf2025, now, "UTC"), "Jan 1");
  assert.equal(
    relativeTime(lastOf2025, now, "America/Los_Angeles"),
    "Dec 31, 2025",
  );
  assert.equal(
    relativeTime("2026-01-01T08:00:00Z", now, "America/Los_Angeles"),
    "Jan 1",
  );
  assert.equal(
    relativeTime("2026-10-04T16:00:00Z", now, "Asia/Tokyo"),
    "Oct 5",
  );
});

test("the current day and year follow the reader's time zone", () => {
  // 03:00 UTC on New Year's Day is still December 31 in Los Angeles.
  const newYear = Date.parse("2027-01-01T03:00:00Z");
  const december = "2026-12-20T12:00:00Z";
  assert.equal(
    relativeTime(december, newYear, "America/Los_Angeles"),
    "Dec 20",
  );
  assert.equal(relativeTime(december, newYear, "UTC"), "Dec 20, 2026");
  assert.equal(relativeTime(december, newYear, "Asia/Tokyo"), "Dec 20, 2026");
  // At 8:30 AM on New Year's Day in Los Angeles, 11:00 PM last night was last
  // year, but in UTC both are January 1, and in Tokyo the activity was
  // yesterday.
  const morning = Date.parse("2027-01-01T16:30:00Z");
  const lastNight = "2027-01-01T07:00:00Z";
  assert.equal(
    relativeTime(lastNight, morning, "America/Los_Angeles"),
    "Dec 31, 2026",
  );
  assert.equal(relativeTime(lastNight, morning, "UTC"), "9h");
  assert.equal(relativeTime(lastNight, morning, "Asia/Tokyo"), "Jan 1");
});

test("relative times count elapsed time across daylight saving changes", () => {
  const pacific = "America/Los_Angeles";
  // Daylight saving began at 2:00 AM PST on March 8, 2026 (10:00 UTC):
  // 1:30 AM PST to 4:30 AM PDT is two hours, and midnight was three and a
  // half hours earlier.
  const spring = Date.parse("2026-03-08T11:30:00Z");
  assert.equal(relativeTime("2026-03-08T09:30:00Z", spring, pacific), "2h");
  assert.equal(relativeTime("2026-03-08T08:00:00Z", spring, pacific), "3h");
  assert.equal(relativeTime("2026-03-08T07:59:00Z", spring, pacific), "Mar 7");
  // It ended at 2:00 AM PDT on November 1, 2026 (09:00 UTC): 1:30 AM PDT to
  // 1:30 AM PST is one hour.
  const autumn = Date.parse("2026-11-01T09:30:00Z");
  assert.equal(relativeTime("2026-11-01T08:30:00Z", autumn, pacific), "1h");
  // That day lasted 25 hours, so by 11:30 PM PST, midnight PDT was 24 and a
  // half hours earlier.
  const lateAutumn = Date.parse("2026-11-02T07:30:00Z");
  assert.equal(
    relativeTime("2026-11-01T07:00:00Z", lateAutumn, pacific),
    "24h",
  );
  assert.equal(
    relativeTime("2026-11-01T06:59:00Z", lateAutumn, pacific),
    "Oct 31",
  );
});

test("a reader clock running behind shows recent activity as now", () => {
  assert.equal(relativeTime(ago(-5 * minute), now, "UTC"), "now");
  assert.equal(relativeTime(ago(-6 * day), now, "UTC"), "now");
  // Activity just after midnight is ahead of a clock still showing 11:59 PM.
  assert.equal(
    relativeTime(
      "2026-11-08T08:01:00Z",
      Date.parse("2026-11-08T07:59:00Z"),
      "America/Los_Angeles",
    ),
    "now",
  );
  assert.equal(relativeTime("2026-12-25T12:00:00Z", now, "UTC"), "Dec 25");
  assert.equal(relativeTime("not a date", now, "UTC"), "Invalid Date");
});

test("only times from the reader's current day, or ahead of their clock, change each minute", () => {
  for (const [value, changes] of [
    [ago(0), true],
    [ago(15 * hour + 30 * minute), true],
    [ago(15 * hour + 30 * minute + 1), false],
    [ago(30 * day), false],
    // A time over a week ahead shows its date until it comes within a week.
    [ago(-6 * day), true],
    [ago(-8 * day), true],
    ["not a date", false],
  ] as const)
    assert.equal(changesEachMinute(value, now, "UTC"), changes, value);
  assert.equal(
    changesEachMinute(ago(15 * hour + 30 * minute), now, "Asia/Tokyo"),
    false,
  );
});

test("activity times render the same UTC fields in every time zone until the page is interactive", () => {
  const original = process.env.TZ;
  try {
    const markup = ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"].map(
      (timeZone) => {
        process.env.TZ = timeZone;
        return [
          // PostgreSQL JSON and JavaScript ISO timestamps share one fallback.
          "2026-01-01T07:59:00.123456+00:00",
          "2026-01-01T07:59:00.123Z",
        ].map((value) =>
          renderToStaticMarkup(
            createElement(ActivityTime, { value, interactive: false }),
          ),
        );
      },
    );
    for (const zone of markup)
      assert.deepEqual(zone, [
        '<time dateTime="2026-01-01T07:59:00.123456+00:00" title="2026-01-01 07:59 UTC">2026-01-01</time>',
        '<time dateTime="2026-01-01T07:59:00.123Z" title="2026-01-01 07:59 UTC">2026-01-01</time>',
      ]);
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
  assert.equal(
    dateLabel("2026-01-01T07:59:00Z", false, "relative"),
    "2026-01-01",
  );
  assert.equal(dateLabel("not a date", false, "relative"), "Invalid Date");
});

test("interactive dates read as the runtime's own toLocaleDateString", () => {
  const formats: Intl.DateTimeFormatOptions[] = [
    // The hover time on activity times, and the availability check time.
    {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    },
    {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    },
    // Invitation expiry, and options that name no part of the date.
    {},
    { hour: "numeric", minute: "2-digit" },
  ];
  for (const value of [
    "2026-01-01T07:59:00.123456+00:00",
    "2025-07-04T23:30:00Z",
  ])
    for (const timeZone of [undefined, "UTC", "America/Los_Angeles"])
      for (const format of formats) {
        const options = { ...format, timeZone };
        const expected = new Date(value).toLocaleDateString("en-US", options);
        // Repeated dates read the same.
        assert.equal(dateLabel(value, true, options), expected);
        assert.equal(dateLabel(value, true, options), expected);
      }
  assert.equal(dateLabel("not a date", true, {}), "Invalid Date");
  assert.equal(dateLabel("not a date", true, "relative"), "Invalid Date");
});

test("interactive dates follow a change to the reader's time zone within a minute", (t) => {
  const original = process.env.TZ;
  t.mock.timers.enable({ apis: ["Date"], now });
  try {
    // 20:00 UTC on December 31 is already January 1 in Tokyo.
    const lastOf2025 = "2025-12-31T20:00:00Z";
    process.env.TZ = "America/Los_Angeles";
    assert.equal(readerCalendar(), "America/Los_Angeles 2026");
    assert.equal(dateLabel(lastOf2025, true, "relative"), "Dec 31, 2025");
    assert.equal(
      dateLabel(lastOf2025, true, { hour: "numeric" }),
      "12/31/2025, 12 PM",
    );
    process.env.TZ = "Asia/Tokyo";
    t.mock.timers.tick(minute);
    assert.equal(dateLabel(lastOf2025, true, "relative"), "Jan 1");
    assert.equal(
      dateLabel(lastOf2025, true, { hour: "numeric" }),
      "1/1/2026, 5 AM",
    );
    // The minute timer's calendar check sees a change at once.
    process.env.TZ = "America/Los_Angeles";
    assert.equal(readerCalendar(), "America/Los_Angeles 2026");
    assert.equal(dateLabel(lastOf2025, true, "relative"), "Dec 31, 2025");
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
