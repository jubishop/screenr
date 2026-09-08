---
status: current
---

# Find a title suggestions

Show relevant titles before the viewer searches on Find a title.
[Issue #39](https://github.com/jubishop/screenr/issues/39) tracks implementation.
This document records accepted decisions and their implementation.
All decisions follow Screenr's
[privacy and known-people boundary](product-brief.md#privacy-and-the-known-people-circle--2026-09-07).

## Accepted decisions

### Initial action scope — 2026-09-07

**Decision:** Show suggestions before a search. Use Recommend and Want to
watch actions, and exclude titles the viewer has marked with those actions.
Implement this with the two existing actions. Add Watching as a suggestion
source and viewer exclusion when watch-status tracking is implemented.

**Why:** The user accepted this scope after source inspection confirmed
that Watching has no stored state or controls yet. It lets suggestions
ship without expanding this issue into watch-status tracking.

**Tradeoff:** The first implementation cannot use Watching activity.

### Viewer exclusions follow current choices — 2026-09-07

**Decision:** Exclude a title while the viewer currently marks either
Recommend or Want to watch. Once both actions are removed, the title can
appear again if it otherwise qualifies for suggestions. A past action
does not permanently exclude a title.

**Why:** The user accepted using current choices for exclusions and making
a title eligible again after both choices are removed.

**Tradeoff:** A title the viewer previously removed can return. Removal
does not act as a permanent dismissal from suggestions.

### Second-degree activity can qualify a title — 2026-09-07

**Decision:** A title can appear when only friends of friends recommend it
or mark it Want to watch. Direct-friend support is not required. Apply the
same viewer exclusions, weighted ranking, and anonymous explanation rules.
When there is no direct-friend activity, use wording such as "N friends of
friends recommend this" without implying that a direct friend also does.

**Why:** The user accepted using second-degree signals to discover titles
that no direct friend has marked.

**Tradeoff:** Some suggestions have no named direct-friend explanation.
Their contributors remain anonymous.

### Ordering and social distance — 2026-09-07

**Decision:** Use a 3:1 weighting: a direct friend's action counts as 3;
a friend's friend's action counts as 1. Compare weighted recommendation
totals first, weighted Want to watch totals second, then the most recent
of those actions. Count each person once per action, even if several mutual
friends connect them to the viewer. A direct friend belongs only to the
direct-friend group and is not also counted as a friend of a friend.

For example, four second-degree recommendations score 4 and can outrank
one direct-friend recommendation, which scores 3. Recommendation totals
take priority over Want to watch totals rather than combining the two
action types into one score.

**Why:** The user accepted giving endorsements priority over interest alone
and requested a lower-weight contribution from friends of friends. The
user selected 3:1 rather than the proposed 4:1 weighting. No additional
reason for the exact ratio was stated.

**Tradeoff:** This extends discovery beyond direct friends. The anonymous
count decision below defines what can be revealed about second-degree
signals. It does not grant access to another person's posts or discussions.

### Explanations on title tiles — 2026-09-07

**Decision:** Present suggestions as a tiled list. Under each tile's image,
explain why the title appears, including who recommends it or has marked it
Want to watch. Identify direct friends by name; explain friends-of-friends
activity through anonymous counts under the decision below.

**Why:** The user requested visible reasons beneath each title's image.

### Anonymous friends-of-friends explanations — 2026-09-07

**Decision:** Explain second-degree activity with counts such as "N friends
of friends also recommend this" or the equivalent for Want to watch. Do
not identify those people or their mutual-friend connections. Do not return
their names, usernames, avatars, user IDs, activity-entry IDs, or connecting
friendship paths in suggestion display data. Do not provide links or
drill-down controls that reveal who contributed to a second-degree count.
Direct-friend explanations can identify the friends and their actions.

Keep the existing access rules for profiles, posts, reviews, and discussion
threads. Using a second-degree action to suggest a title does not grant
access to that person's activity entry or its replies.

**Why:** The user rejected named second-degree explanations to preserve
privacy and requested anonymous counts instead. The user then reinforced
the close-circle privacy rule and selected 3:1 ranking, retaining the
anonymous exception without allowing second-degree identities here.

**Tradeoff:** Counts reveal that second-degree activity exists, while
withholding attribution to individual people. This is a limited aggregate
exception to the existing direct-friend activity audience, not a broader
change to content access.

### Switching between suggestions and search — 2026-09-07

**Decision:** While browsing suggestions, keep them visible as the viewer
types. Submitting a search replaces suggestions with search results.
Clearing the search box restores suggestions without requiring another
submission.

Normal catalog search can return titles the viewer already recommends or
wants to watch. The viewer exclusions apply only to suggestions.

**Why:** The user accepted this transition between browsing and explicit
search, including automatic restoration when the search box is cleared.

**Tradeoff:** Typing alone does not run a search or filter suggestions.

### Suggestion tile actions — 2026-09-07

**Decision:** Selecting a suggestion tile opens the existing title page.
The viewer reads details and eligible discussions and changes Recommend
or Want to watch there. Do not add inline title actions to suggestion tiles.

**Why:** The user accepted the existing search and Watch together pattern
to keep suggestion tiles easy to browse.

**Tradeoff:** Saving a suggested title requires opening its title page.

### Movies and TV appear together — 2026-09-07

**Decision:** Show movies and TV shows together in one ranked suggestion
list. Do not add type filters, separate sections, or visible movie/TV type
labels to suggestion tiles for now. Title identity still distinguishes
movies from shows for correct links and deduplication.

**Why:** The user rejected the proposed All, Movies, and TV filters and
said the two types can appear together without distinction for now.

**Tradeoff:** Viewers cannot narrow suggestions by title type. This decision
covers the suggestion list; it does not remove existing controls or title
information elsewhere in the app.

### Show all eligible titles — 2026-09-07

**Decision:** Show every eligible title in the agreed ranked order, with
no fixed suggestion limit for now.

**Why:** The user accepted keeping all eligible titles available at this
stage, consistent with Watch together.

**Tradeoff:** The list can become long as the viewer's circle adds titles.

## Implementation guidance

The guidance below follows the accepted decisions and existing application
behavior. It describes engineering choices, not additional interview answers.

### Sources and access

- Use active Recommend and Want to watch records. Removed actions do not
  qualify or rank a title, even when replies keep their feed entries visible.
  Comments and replies are not recommendation signals or viewer exclusions.
- Derive direct friends from current accepted friendships, subject to
  blocking. Derive friends of friends through two current accepted,
  unblocked friendship edges. Exclude the viewer, direct friends, anyone
  blocked in either direction by the viewer, and anyone more than two
  friendships away. A pending request does not establish an eligible edge.
- Deduplicate each person within their social group and each title by its
  catalog identity. Multiple connecting friends must not multiply a signal.
  A person can contribute once to each action total when both are active.
- Read eligibility, current actions, viewer exclusions, and aggregates in
  one consistent database snapshot. Return named direct-friend contributors
  and ordinary second-degree person counts for each action. The 3:1 scores
  determine order; they are not the person counts shown in explanations.
- Do not widen `screenr_can_read` or load second-degree private feed entries
  into browser data to calculate anonymous counts. Existing activity and
  discussion endpoints keep their access rules. Apply the same restriction
  to initial rendered data and subsequent screen API responses.
- Unfriending, blocking, and action changes affect subsequent reads. A former
  direct friend can contribute anonymously only if an eligible two-edge
  connection remains; a blocked person cannot contribute through another
  mutual friend. Removing the final eligible connection removes that signal.
- Read existing stored title metadata for suggestions. The implementation
  needs no live TMDB request per tile, new catalog recommendation service,
  schema migration, or new dependency.

### Ordering and presentation

- Sort descending by `3 * direct_recommenders + second_degree_recommenders`,
  then `3 * direct_want_to_watch + second_degree_want_to_watch`, then the
  latest activation of an eligible, currently active action. Replies do not
  affect this time. Use title name and catalog ID as stable final tie-breaks.
- Use a responsive poster grid with the title and social explanations
  beneath each image. Handle missing posters and singular/plural counts.
  Explain Recommend and Want to watch separately and omit zero-count claims.
  Keep the tile link keyboard-accessible and readable on phone and desktop.
- Preserve the current screen refresh conventions and the viewer's search
  text and display mode during refreshes. Returning from a title page reads
  current choices, so a newly saved title is excluded from suggestions.
- Treat whitespace-only search input as empty. Clearing it must invalidate
  any in-flight search so a late response cannot replace restored suggestions.
  Likewise, an older request cannot overwrite a newer submitted search.
  Editing a submitted query keeps its existing results until the next submit
  or clear, consistent with the existing submit-based search.
- With no eligible suggestions, show a short empty message and keep search
  available. Do not substitute globally popular titles or explain absence
  using private people or activity. Distinguish empty suggestions from a
  failed load and from a submitted search with no matches.
- A failed suggestion refresh must not continue to present unverifiable
  private social data as current or prevent catalog search. Provide a clear
  retry path and preserve search text.

### Implementation

`src/server/title-suggestions.ts` implements the single-snapshot query.
It separates current direct friends from unique eligible second-degree
people, then filters and aggregates active actions. It reads names only
for direct-friend attribution. Its explicit response fields contain public
title metadata, direct-friend names/usernames, and anonymous second-degree
counts. Ranking scores, second-degree identities, and connecting paths are
not returned. `src/server/screens.ts` includes these suggestions for `/search`.

`src/components/title-search.tsx` owns the search input, results, and tiled
suggestions. `src/components/screen.tsx` keeps it mounted when suggestion
reads fail, clearing social data through the existing screen refresh logic
while preserving search text and submitted results. Search requests have a
timeout and an abort controller. Clearing, submitting a newer query, or
leaving the page cancels the old request; only the current request can
publish results or errors. The existing Poster component accepts responsive
image sizes for the grid.

`tests/app/title-suggestions.test.ts` exercises the public screen loader
against PostgreSQL, including weighting, unique connections, current choices,
blocking, preserved discussions, and 205 eligible titles. Browser coverage
in `tests/browser/title-suggestions.spec.ts` uses the real app and the local
catalog fixture to check identity privacy in initial page data and API
responses, tile layout/navigation, search transitions, delayed responses,
and recovery from network failures. The issue owns the acceptance checklist.

## Scope boundary

Watching follows future watch-status tracking. This issue does not build
that tracking, the separately planned Friends recommend view, filters,
inline title actions, permanent dismissals, or global recommendations.
It does not expand access to profiles, activity entries, or discussions.
