import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dateLabel, relativeTime } from "../../src/components/client";
import { ActivityTime } from "../../src/components/activity-time";

const minute = 60_000,
  hour = 60 * minute,
  day = 24 * hour;
const now = Date.parse("2026-10-12T15:30:00.000Z");
const ago = (elapsed: number) => new Date(now - elapsed).toISOString();

test("activity times count minutes, hours, and days under a week", () => {
  for (const [elapsed, label] of [
    [0, "now"],
    [minute - 1, "now"],
    [minute, "1m"],
    [5 * minute + 59_999, "5m"],
    [hour - 1, "59m"],
    [hour, "1h"],
    [2 * hour + 30 * minute, "2h"],
    [day - 1, "23h"],
    [day, "1d"],
    [3 * day + 23 * hour, "3d"],
    [7 * day - 1, "6d"],
  ] as const)
    for (const timeZone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"])
      assert.equal(relativeTime(ago(elapsed), now, timeZone), label);
});

test("activity times a week or older show the reader's local date, with the year only outside the current year", () => {
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

test("the current year follows the reader's time zone", () => {
  // 03:00 UTC on New Year's Day is still December 31 in Los Angeles.
  const newYear = Date.parse("2027-01-01T03:00:00Z");
  const december = "2026-12-20T12:00:00Z";
  assert.equal(
    relativeTime(december, newYear, "America/Los_Angeles"),
    "Dec 20",
  );
  assert.equal(relativeTime(december, newYear, "UTC"), "Dec 20, 2026");
  assert.equal(relativeTime(december, newYear, "Asia/Tokyo"), "Dec 20, 2026");
});

test("relative times count elapsed time across daylight saving changes", () => {
  const pacific = "America/Los_Angeles";
  // Daylight saving began at 2:00 AM PST on March 8, 2026 (10:00 UTC):
  // 1:30 AM PST to 4:30 AM PDT is two hours.
  const spring = Date.parse("2026-03-08T11:30:00Z");
  assert.equal(relativeTime("2026-03-08T09:30:00Z", spring, pacific), "2h");
  assert.equal(relativeTime("2026-03-07T11:31:00Z", spring, pacific), "23h");
  assert.equal(relativeTime("2026-03-01T11:31:00Z", spring, pacific), "6d");
  assert.equal(relativeTime("2026-03-01T11:30:00Z", spring, pacific), "Mar 1");
  // It ended at 2:00 AM PDT on November 1, 2026 (09:00 UTC): 1:30 AM PDT to
  // 1:30 AM PST is one hour.
  const autumn = Date.parse("2026-11-01T09:30:00Z");
  assert.equal(relativeTime("2026-11-01T08:30:00Z", autumn, pacific), "1h");
  assert.equal(relativeTime("2026-10-25T09:30:00Z", autumn, pacific), "Oct 25");
});

test("a reader clock running behind shows recent activity as now", () => {
  assert.equal(relativeTime(ago(-5 * minute), now, "UTC"), "now");
  assert.equal(relativeTime(ago(-6 * day), now, "UTC"), "now");
  assert.equal(relativeTime("2026-12-25T12:00:00Z", now, "UTC"), "Dec 25");
  assert.equal(relativeTime("not a date", now, "UTC"), "Invalid Date");
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
