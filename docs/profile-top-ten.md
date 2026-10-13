---
status: current
---

# Profile top 10

Each member can pin a ranked list of up to 10 titles they recommend to the
top of their profile. A top 10 placement also strengthens that
recommendation in Find a title and Friends recommend.
[Issue #99](https://github.com/jubishop/screenr/issues/99) implemented it, as
described under [Implementation](#implementation). Its layout builds on the
2026-10-12 [interface design decisions](interface-design.md) that issue #165
implemented.

## Accepted decisions

### Top 10 entries are Recommends — 2026-10-12

**Decision:** Every top 10 entry is one of the owner's current Recommends.
Adding a title to the top 10 also recommends it, following the
[exclusive action lifecycle](title-feed.md#exclusive-recommend-and-want-to-watch--2026-09-09),
so it clears Want to watch. Removing a title from the top 10 keeps the
Recommend.

**Why:** The user accepted making the top 10 a stronger form of
recommendation, so its weight extends the existing recommendation score.

**Rejected alternative:** An independent list could hold titles the owner
does not recommend. It would need a separate ranking signal that could
conflict with Want to watch.

### One ranked list of up to 10 — 2026-10-12

**Decision:** Each member has one list that mixes movies and TV shows,
ranked #1 to #10 by its owner. A list can hold fewer than 10 titles, and
its ranks run from #1 without gaps.

**Why:** The user accepted a ranked list. One combined list matches
[Find a title](title-suggestions.md#movies-and-tv-appear-together--2026-09-07),
which shows both types together.

**Rejected alternatives:** An unordered set of favorites loses the ranking.
Separate movie and TV lists double the profile space and controls.

### Rank-based weight — 2026-10-12

**Decision:** A top 10 Recommend counts more than a plain Recommend, scaled
by rank. #10 counts 1.5 times a plain Recommend, and each higher rank adds
0.05, up to 1.95 times at #1. In Find a title, the multiplier applies to both
social groups and stays within the recommendation score, so recommendation
totals still take priority over Want to watch totals.

| Rank | Multiplier | Direct friend | Friend of a friend |
| ---: | ---: | ---: | ---: |
| #1 | 1.95 | 5.85 | 1.95 |
| #5 | 1.75 | 5.25 | 1.75 |
| #10 | 1.50 | 4.50 | 1.50 |
| Not in top 10 | 1.00 | 3.00 | 1.00 |

**Why:** The issue proposed a 1.5 weight. During the interview, the user
asked that a first-place pick count more than a tenth-place pick, kept 1.5
as the floor, and applied the multiplier to both direct friends and friends
of friends.

**Rejected alternatives:** A flat 1.5 for every rank, a 2.0-to-1.1 scale,
coarser tiers, and weighting only direct friends' top 10 entries.

### Visible to every signed-in member — 2026-10-12

**Decision:** Any signed-in member who is not blocked can see a person's
top 10 on their profile: the ranks, posters, and title names, linked to the
title pages. Profiles still require sign-in, and blocking still hides the
profile. The Recommend entries behind the list, their discussions, and all
other activity keep their friends-only audience. The interface does not
show owners a notice that the list is visible to everyone.

This is a narrow exception to the
[product social scope](product-brief.md#product-social-scope--2026-09-04)
and the
[known-people privacy boundary](product-brief.md#privacy-and-the-known-people-circle--2026-09-07).
It adds no global discovery: no browsing or searching other members' lists
and no app-wide rankings.

**Why:** The user first accepted a friends-only list, then changed it:
"actually let everyone see the top 10 on your profile. thats fun." When the
conflict with the earlier decisions was raised, the user chose a narrow
exception over a broader scope change.

**Tradeoff:** Non-friends learn up to 10 of a person's Recommends. Because
members can see profile friend lists, a viewer can link a friend of a
friend's public top 10 to an anonymous
[Find a title count](title-suggestions.md#anonymous-friends-of-friends-explanations--2026-09-07)
for the same title. That reveals only titles the owner chose to publish;
issue #107 covers identification through small second-degree groups.

**Rejected alternatives:** Letting non-friends open the Recommend entries
and discussions, showing the list without sign-in, and a muted "Everyone on
Screenr can see your top 10" note while adding or editing.

### Add from the title page — 2026-10-12

**Decision:** The title page header gets an Add to top 10 control beside
Recommend. A newly added title takes the next open rank. When the list is
full, an in-page prompt lists the current 10 and asks which one to remove.
The entries below the removed title move up, the new title joins at #10,
and the removed title stays recommended. Cancel leaves the list unchanged.

**Why:** The user accepted adding from the title page and reordering on the
profile, and accepted the remove-then-append behavior for a full list.

**Rejected alternatives:** Choosing a rank while adding, adding only from
the profile, giving the new title the removed title's rank, and blocking
additions until the owner makes room.

### Withdrawing a top 10 Recommend — 2026-10-12

**Decision:** Withdrawing the Recommend on a top 10 title, or switching it
to Want to watch, first shows a confirmation that the title will also leave
the top 10 at its rank. If confirmed, the entries below move up.
Recommending the title again does not restore its place.

**Why:** The user accepted confirming before a ranked place is lost.

**Rejected alternatives:** Removing it silently, and blocking the
withdrawal until the title leaves the top 10.

### Reorder in an edit mode — 2026-10-12

**Decision:** On their own profile, the owner opens an edit mode that shows
Move up, Move down, and Remove on each entry. Each change saves immediately.

**Why:** The user accepted controls that work with keyboard and touch
without a drag-and-drop dependency and keep the profile uncluttered outside
editing.

**Rejected alternatives:** Drag and drop, and always-visible controls.

### Poster row at the top of the profile — 2026-10-12

**Decision:** Show the top 10 beneath the profile header and above the
friends list and activity, as one horizontally scrolling row of numbered
posters with title names beneath.

**Why:** The user accepted a row about one poster tall, which keeps
activity near the top of a phone screen, consistent with the 2026-10-12
design review.

**Rejected alternatives:** A vertical numbered list and a wrapping poster
grid, which take most of a phone screen.

### No feed entries for top 10 changes — 2026-10-12

**Decision:** Adding, reordering, or removing top 10 entries creates no feed
entry or notification. The underlying Recommend keeps its existing feed
entry and discussion.

**Why:** The user accepted avoiding feed noise from reordering and a new
feed item type.

**Rejected alternatives:** A feed entry for additions, and a rank badge on
the existing Recommend entry.

### Show ranks where friends are named — 2026-10-12

**Decision:** Wherever a direct friend is named as a recommender, show
their rank beside the name, as in "Maya Chen (#1)". List top 10
recommenders first, best rank first, then the other recommenders in that
surface's existing order. This applies to Find a title explanations, the
title page friend line from issue #165, and Friends recommend.
Friend-of-friend counts in Find a title stay plain anonymous counts that do
not mention top 10 placements.

**Why:** The user accepted showing ranks on every surface that names
friends. Listing top 10 recommenders first keeps the strongest endorsements
within the friend line's three-name limit. The user also declined adding top
10 detail to second-degree counts, which would reveal more about small
second-degree groups.

**Rejected alternatives:** Keeping each surface's name order, showing ranks
only in Find a title, and adding top 10 counts to second-degree
explanations.

### Friends recommend uses the weights — 2026-10-12

**Decision:** The planned Friends recommend view (issue #102) sorts by the
sum of its direct friends' multipliers instead of a plain count: 1 for a
Recommend outside the top 10, and 1.5 to 1.95 for a top 10 Recommend. Ties
still break on the most recent recommendation. This updates the
[recommendation ordering decision](product-brief.md#recommendation-ordering-and-filters--2026-09-04).

**Why:** The user chose to apply the weights there too, so both
recommendation views rank alike. No further reason was given.

**Rejected alternatives:** Keeping the plain count while showing ranks, and
leaving the view unchanged.

## Implementation guidance

The guidance below follows the accepted decisions and existing application
behavior. It describes engineering choices, not additional interview
answers.

### Storage and lifecycle

- Store each entry with its owner, title, and rank. Keep at most one entry
  per owner and title, one per owner and rank, and 10 per owner. Additions,
  full-list replacements, reorders, and removals keep ranks contiguous from 1
  within one transaction.
- Remove the entry and close the gap in the same transaction as a withdrawn
  Recommend or a switch to Want to watch. The confirmation appears wherever
  those actions are offered, including full feed entries.
- Adding a title the owner does not recommend activates Recommend through
  the existing action path, with its usual feed and notification behavior.
- Unfriending and blocking do not change anyone's list.

### Ranking

- Use integer twentieths so scores stay exact: a plain Recommend contributes
  20 and a top 10 Recommend contributes `40 - rank` (39 at #1, 30 at #10).
- Find a title multiplies each contribution by the 3:1 group weight and sums
  it as the recommendation score. Want to watch totals, viewer exclusions,
  and the tie-breaks stay unchanged. Do not return scores or second-degree
  ranks in response data.
- Any threshold that issue #107 sets for second-degree signals also governs
  their top 10 boost.
- Friends recommend sums the contributions of current, unblocked direct
  friends, then breaks ties by the most recent recommendation.

### Presentation

- Load a profile's top 10 for every signed-in viewer who can see the
  profile, separately from the friends-only `can_read` activity. Return only
  title identity, public title metadata, and rank, with no feed item IDs or
  links to the Recommend entries.
- Hide the section on another member's profile when the list is empty. On
  the owner's profile, show a short empty state that explains adding from a
  title page.
- Put Edit on the Top 10 heading row, like the heading-row buttons in issue
  #165. Use #165's inline SVG icon set for edit, move, and remove.
- Give rank numbers their own background so they meet contrast requirements
  over any poster in both color schemes. Posters keep their own colors.
- Make each poster a keyboard-accessible link whose name includes its rank
  and title, and handle missing posters.
- On the title page, show the control's current state, such as "#3 in your
  top 10", with a way to remove it. Use in-page prompts, not browser
  dialogs, for the full-list choice and the withdraw confirmation, matching
  #165's confirmations.
- Leave the control off feed entries, which #165 limits to two action rows
  on phone.

## Implementation

[Issue #99](https://github.com/jubishop/screenr/issues/99) implements the
decisions above.

### Storage and actions

Migration `025-profile-top-ten.sql` adds `top_ten`: one row per owner and
title with a rank from 1 to 10, unique per owner and title and per owner and
rank. The rank key is checked at the end of each statement, so one statement
can swap or shift ranks. `src/server/top-ten.ts` reads lists and changes
them inside the shared domain transaction, whose lock orders every write.
Adding takes the next rank, removing moves the entries below it up, and
moving swaps an entry with its neighbor; a move past either end changes
nothing.

`updateTopTen` in `src/server/title-actions.ts` serves the `top-ten` action,
whose `change` is `add`, `remove`, `up`, or `down`. Adding recommends the
title through the usual Recommend write in the same transaction, so a new
Recommend gets its normal feed entry; a title already listed keeps its rank
and an existing Recommend keeps its activity date. A full list refuses an
addition unless `replace` names a listed title, which leaves the list first
and stays recommended. Removing a title that is not listed changes nothing,
and moving one is an error. Withdrawing Recommend, or switching to Want to
watch from a title action or the status menu, removes the entry and closes
its gap in the same write. Progress statuses go with Recommend, so they keep
the entry. No list change adds a feed entry or notification of its own.

The release before migration 025 withdrew Recommend without knowing about
the list, so the `feed_item_leave_top_ten` trigger removed the entry and
closed the gap whenever a Recommend turned off. Once every retained release
removed the entry itself, migration `026-drop-top-ten-guard.sql` dropped the
trigger and its function
([issue #198](https://github.com/jubishop/screenr/issues/198)).

### Reads and ranking

Profile screens include `topTen` for every member who can load the profile,
beside the friends-only activity: the title ID, name, poster path, and rank,
with no entry IDs. A blocked profile still fails to load. Title screens
include the viewer's own list for the header control and the full-list
prompt, and each feed entry carries `viewer_top_ten_rank`, the reader's own
rank for its title, for the withdraw confirmation.

`src/server/title-suggestions.ts` sums recommendations in twentieths: 20 for a
plain Recommend or `40 - rank` for a top 10 one, times the 3:1 group weight.
It drops second-degree groups below the minimum before summing, so the
minimum also governs their boost. Each direct friend in `recommended_by`
carries `rank`, top 10 recommenders first by rank, then by username. The title
page friend line (`friendActivity` in `src/server/feed.ts`) lists top 10
recommenders first by rank, then newest first.
`src/server/friends-recommend.ts` sums the same contributions for direct
friends, without a group weight, and names top 10 recommenders first by rank,
then newest first; `src/components/friends-recommend.tsx` shows each rank
beside the name.

### Interface

`src/components/top-ten.tsx` renders the profile section and the full-list
prompt. The row is an ordered list of title links named like "#1 Title",
with the rank on its own ink fill over the poster and the name clamped to two
lines beneath. Its posters are 84px wide on phone and 104px on desktop, and
the row scrolls sideways inside the page. Edit mode shows the same entries as
a vertical list with Move up, Move down, and Remove icon buttons, so up and
down match the order on screen. Focus follows a moved entry, falling back to
its other move button at either end, and moves to the next Remove after a
removal, or to the heading once the list is empty, which shows the empty
state.

The title header adds Add to top 10 beside Recommend. Once listed it
reads "✓ #3 in your top 10", and choosing it removes the title from the list.
`src/components/title-view.tsx` and full feed entries in
`src/components/feed.tsx` confirm with `ConfirmAction` before a top 10 title
loses its Recommend. Cancel or a confirmed change returns focus to the
control that opened the prompt, and a prompt closes when a change elsewhere
makes it unnecessary.

### Tests

`tests/app/top-ten.test.ts` covers adding, the full list, moves and removals,
the Recommend lifecycle without a database trigger, the migration's
constraints, who sees a list, and the action route.
`tests/app/legacy-trigger-migration.test.ts` covers the guard trigger and
its removal by migration 026.
`tests/app/title-suggestions.test.ts` covers the weights in both groups and
under the minimum, `tests/app/friends-recommend.test.ts` covers the summed
weights and ranks in Friends recommend, and `tests/app/title-page.test.ts`
covers ranks in the friend line. `tests/browser/top-ten.spec.ts` covers the poster row, edit
mode, adding, the full-list prompt, the confirmations, and the ranks beside
friends' names at phone and desktop widths, auditing contrast in both color
schemes.

## Scope boundary

Watch together compares Want to watch choices, and recommendations do not
affect it, so the top 10 does not change it. The top 10 adds no browsing,
searching, or app-wide ranking of members' lists.
