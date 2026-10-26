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

**Updated — 2026-10-13:** The
[native iPhone app](ios-app.md#app-visits-and-client-split-in-usage-telemetry--2026-10-13)
counts as activity too. Its first screen read after launch, or after
returning to the foreground, records the day as a page load does. Each row
also records which clients the member used that day: web, iOS, or both. This
supersedes "holding only the member and the Pacific date." The report shows
app adoption.

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

**Updated — 2026-10-13:** The
[public privacy policy](product-brief.md#public-privacy-policy--2026-10-13)
describes this measurement and its 12-month retention. The owner approved that
wording. The app still shows no notice and offers no opt-out.

### Twelve-month retention — 2026-10-12

**Decision:** The worker's existing cleanup deletes active-day and
save-attribution rows older than 12 months. Conversation figures come from
existing feed and comment data, which this decision does not change.

**Why:** The user accepted 12 months as enough to see trends across the
first release and to follow saves to later watch statuses, without keeping
personal activity indefinitely.

**Rejected alternatives:** Keeping the rows indefinitely, and keeping them
for 90 days.

## Implementation

Migration `db/015-usage-telemetry.sql` adds the two tables below,
`db/021-save-follow-through.sql` adds the
[follow-through](#save-follow-through) flag to saves, and
`db/031-active-day-clients.sql` adds the [clients](#active-days) to active
days. The previous release ignores them, so activation and rollback stay
compatible. `src/server/usage.ts` records active days, prunes old rows, and
builds the report.

### Active days

`member_active_day` holds one row per member and Pacific date, with two
other columns: `web` and `ios`, whether the member used the website or the
iPhone app that day. A day used on both has both. Recording inserts the row
when it is missing, and otherwise sets the client only when the row lacks it,
outside the shared domain lock. Migration 031 marks the days recorded before
it as website days. Its column defaults let the previous release, which
inserts only the member, keep recording during a rollback; those days count
as website days too.

Each member page render records a website day through `currentMember` in
`src/server/session.ts`. That covers loading a signed-in page and client
navigation, which renders the page on the server. The action route in
`src/app/api/screenr/[action]/route.ts` records the day for every member POST
action declared in `src/server/actions.ts`, including rejected ones, and for
title searches. A request with a valid iPhone
[`Screenr-Client` header](data-and-access.md#client-headers) records an
iPhone app day; any other records a website day.

Screen and notification reads, which clients repeat in the background while
a page, an app screen, or the notification panel stays open, record nothing,
with one exception: a `screen` read that carries `Screenr-Visit: 1`. The
iPhone app sends that header on its first screen read after launch and after
each return to the foreground, and nowhere else
([app visits](../ios/README.md#visits)). Its
[Siri and Shortcuts actions](../ios/README.md#siri-shortcuts-and-spotlight)
read screens without it; their searches and saves record the day as any
search or save does. The route records the day before
reading, so a 304 for an unchanged screen records it too. Any other value of
the header, or the header on another read, records nothing. Profile setup
records nothing; the member page that follows it does, and so does the app's
next screen read, since a visit that gets no successful answer, such as the
403 before setup, moves to the next one. Photo changes record the day once
the person has a profile, so a photo added during setup records nothing.

### Save attribution

`updateTitleActivity` in `src/server/title-actions.ts` adds a `want_to_watch_save` row
in the same transaction when Want to watch turns on. It adds nothing when the
title was already saved, when Want to watch turns off, or for Recommend. The
row holds the member, title, Pacific date, surface, and
`friend_recommending`: whether any current direct friend had an active
Recommend for the title at that moment. The member's own Recommend does not
count, and the row never identifies the friend.

The client sends one of these surfaces with the Want to watch action:

| Surface | Save made from | Observed |
| --- | --- | --- |
| `friend_recommendation` | A friend's active Recommend entry in any feed | Yes |
| `friend_entry` | Any other friend's entry, such as Want to watch, a review, or a comment | No |
| `suggestion_recommendation` | A title page opened from a suggestion tile naming a recommending friend | Yes |
| `suggestion` | A title page opened from another suggestion tile | No |
| `watch_together` | A title page opened from Watch together | No |
| `title` | A title page reached another way, such as search or a feed link | No |
| `friends_recommend` | The Friends recommend tab on Find a title, or a title page opened from it | Yes |
| `shortcut` | The iPhone app's Add to Want to watch action in Siri or the Shortcuts app | No |

Suggestion tiles and Watch together have no inline title actions, so their
links add `?from=<surface>` to the title page address. Friends recommend
sends its surface with its own Want to watch action, and its title links add
`?from=friends_recommend`. The title page sends that surface with its Want to
watch action. The member route parser ignores
the parameter, so it does not change which screen loads; a copied address
keeps it. A save without a surface, from a page loaded before this release,
stores no surface and can count only as inferred. An unknown surface is
rejected.

### Save follow-through

Each save row also holds `followed_through`, false when saved. When a member
chooses Watching, Caught up, or Finished for a title, `updateWatchStatus`
sets it, in the same transaction, on every earlier save of that title by the
same member. A status chosen before a save never counts for it, because the
save comes later. Stopped watching alone sets nothing, but a save followed by
Watching and then Stopped watching stays followed. Clearing a status later
keeps the flag. The flag records only that this happened, not which status
or when. Another member's status for the same title never changes it.

Migration 021 marks saves made before it whose member's current status for
the title is Watching, Caught up, or Finished. A save turns off any progress
status, so that status came after every save. A status that was cleared or
changed to Stopped watching before the migration cannot be recovered, so its
saves stay unfollowed. So do saves whose member chose a status while a
rollback ran the previous release.

### Owner report

`npm run report:usage` runs `scripts/report-usage.ts`, which reads `.env` when
present. It prints 12 weeks ending with the current week. Pass
`--weeks N` (1–104) or `--through YYYY-MM-DD`, any date in the last week to
show. On the server, run it as the service user with the production
environment, through the
[release-script runner](deployment.md#release-scripts-and-jobs):

```sh
sh /usr/local/lib/screenr-deploy/run-release-script.sh /opt/screenr/current scripts/report-usage.ts --weeks 12
```

The report only reads data. Every figure leaves out the
[demo circle for Apple review](running-screenr.md#demo-circle-for-apple-review):
demo accounts' active days and saves, and entries and comments they posted.
It prints a table for each measure, a second one for saves, and one for app
adoption, with one row per week and an asterisk on the week in progress:

- **Members who return each week:** members with an active day that week, and
  how many of them also had one the week before, even when that week falls
  outside the range shown.
- **Where active members used Screenr:** those members split by the clients
  they used that week: the website only, the iPhone app only, or both, on
  the same day or on different days. The three add up to the week's active
  members.
- **Want to watch saves:** saves that week, observed saves (the surfaces
  marked Observed above), and inferred saves (`friend_recommending`). Each
  counts a member and title once per week, so turning Want to watch off and on
  again counts once. A second table shows how many of those saves, observed
  saves, and inferred saves are [followed through](#save-follow-through):
  the same member later marked the title Watching, Caught up, or Finished. A
  member and title saved twice in a week count once when either save was
  followed. Each save counts in the week it was made, so recent weeks rise as
  members start watching.
- **Conversations with at least two people:** feed entries that received a
  comment or reply that week and whose owner and commenters number at least
  two by the week's end; how many of those had back-and-forth by the week's
  end, counting the entry as its owner's first post; and members who
  commented that week and in any earlier week. Entries include Recommend,
  Want to watch, watch progress, review, earlier discussion, standalone
  comment, and title-less post entries. Posting a
  standalone comment or post starts a conversation and does not count as
  commenting.
  Removed comments count when they were posted.

### Retention and tests

About once a minute, the worker's existing cleanup in `scripts/worker.ts`
deletes expired email jobs and then active days and saves dated before the
Pacific date 12 months earlier. A day's clients and a save's follow-through
flag go with them.

`tests/app/usage-telemetry.test.ts` covers the recording rules through the
action route, including background reads, the app's visits and polls, a
visit answered with 304, the client of each day and a day used on both, row
contents, and save attribution for friends, pending requests, and inactive
or own Recommends. It covers follow-through recorded by the status write,
including statuses chosen before the save, other members' statuses, Stopped
watching, and Watching then Stopped watching, and migration 021's marking of
earlier saves. It covers each report figure at Monday boundaries, including
a week that ends after daylight saving time ends and the client split, the
printed command output without member identities, and 12-month cleanup.
`tests/browser/usage-telemetry.spec.ts` checks that page loads record a
website day, that client navigation records a day while background refreshes
do not, and the feed and title page surfaces.
`tests/browser/title-suggestions.spec.ts` checks the suggestion tile surface.
In the app, ScreenrKit's `VisitTests` cover which screen reads carry the
visit, and `ShellTests` checks it across a launch and a return from the
background.
