---
status: current
---

# Usage telemetry

How Screenr measures the
[initial usage measures](product-brief.md#initial-usage-measures--2026-09-05)
for the first release. [Issue #105](https://github.com/jubishop/screenr/issues/105)
tracks implementation. Measurement stays within the
[privacy and known-people boundary](product-brief.md#privacy-and-the-known-people-circle--2026-09-07).

## Accepted decisions

### First-party storage and an owner report — 2026-10-12

**Decision:** Store usage data in a few minimal tables in Screenr's own
PostgreSQL database. Provide a `npm run report:usage` command that the owner
runs on the server to print weekly figures for the three measures. Use no
third-party analytics service and add no dependency. Existing encrypted
backups cover the tables.

**Why:** The user chose first-party storage, consistent with the privacy
boundary and the
[fewer-dependencies preference](../memory/development-preferences.md#third-party-dependencies).

**Rejected alternatives:** A self-hosted analytics service adds another
service to operate and does not capture the social measures without custom
events. Using only existing data would approximate weekly returns, because
sessions do not record each visit.

### Weekly returns from active days — 2026-10-12

**Decision:** Record at most one row per member per day, holding only the
member and the Pacific date, when the member loads or navigates a signed-in
page or performs any action. Background screen refreshes do not count.
Weeks run Monday through Sunday, Pacific time. The report shows weekly active
members and how many of them were also active the previous week.

**Why:** The user accepted this definition of returning each week. Ignoring
background refreshes keeps a tab left open from counting as activity, and
day-level rows hold no pages or times.

**Rejected alternatives:** Counting every request, including refreshes, and
a per-visit log with timestamps and pages.

### Save attribution, observed and inferred — 2026-10-12

**Decision:** Record each Want to watch save with the member, title, date,
the surface where it was made, and whether any direct friend was actively
recommending the title at that moment. Store only yes or no, never which
friend. Surfaces include a friend's feed entry, Friends recommend, a Find a
title suggestion, the title page, and Watch together.

The report shows two separate lines:

- **Observed:** saves made on a surface that presented a friend's
  recommendation, such as the action on a friend's Recommend entry, Friends
  recommend, or a suggestion tile whose explanation names a recommending
  friend.
- **Inferred:** saves of a title that a direct friend was recommending at the
  time, made from any surface.

Each line follows its titles to a later Watching, Caught up, or Finished
status once [watch statuses](https://github.com/jubishop/screenr/issues/100)
exist. Until then, the report shows the saves alone.

**Why:** The user accepted recording both because the
[measurement decision](product-brief.md#first-release-success-and-measurement--2026-09-05)
requires separating observed app actions from inferences about
recommendation influence.

**Rejected alternatives:** Observed saves alone miss a member who saw a
recommendation and then saved from the title page. Inferred saves alone
cannot separate influence from coincidence.

### Conversation measures from existing comments — 2026-10-12

**Decision:** Compute this measure from the existing feed and comment data,
with no new tables. A conversation is a top-level feed entry with its
comments and replies. Its participants are the entry's owner and every
comment author. Each week, the report shows:

1. Conversations that received a comment that week and have at least two
   participants.
2. How many of those had back-and-forth: a participant posted again after
   another person replied.
3. Members who commented in a conversation that week and also did in an
   earlier week.

A comment removed later still counts as activity at the time it was posted.

**Why:** The user accepted these definitions for conversations involving at
least two people, including repeat participation.

**Rejected alternatives:** Counting only commenters as participants would
not treat a single reply to a recommendation as a conversation. Reporting
only the first count would omit repeat participation.

### No member notice; totals-only report — 2026-10-12

**Decision:** Add no member-facing notice or opt-out for this measurement.
The owner report prints totals only, never figures for individual members,
and no data is sent to third parties.

**Why:** The user chose not to add a notice because the measurement is
first-party and aggregate, within a private, non-commercial circle.

**Rejected alternatives:** A short note on the Account page, and a note with
an opt-out switch.

### Twelve-month retention — 2026-10-12

**Decision:** The worker's existing cleanup deletes active-day and
save-attribution rows older than 12 months. Conversation figures come from
existing feed and comment data, which this decision does not change.

**Why:** The user accepted 12 months as enough to see trends across the
first release and to follow saves to later watch statuses, without keeping
personal activity indefinitely.

**Rejected alternatives:** Keeping the rows indefinitely, and keeping them
for 90 days.
