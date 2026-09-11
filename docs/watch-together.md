---
status: current
---

# Watch together

Watch together helps friends find something they both want to see.
[Issue #26](https://github.com/jubishop/screenr/issues/26) tracks implementation.
The decisions below were accepted in the product interview.

## Accepted decisions

### Watch together entry point and participant scope — 2026-09-07

**Decision:** Add a Watch together link to an accepted friend's profile.
Open a dedicated page that compares the signed-in viewer's and friend's
Want to watch choices. The first interface covers these two people. Keep
the implementation flexible enough to support more participants later.
Apply the existing friendship and blocking rules.

**Why:** The user wants to help friends decide what to watch together and
sees potential value in comparing more than two people's choices later.

**Tradeoff:** The first interface has no group-selection controls. The
decisions below define the page behavior.

### Watch together shared titles — 2026-09-07

**Decision:** Include every title that both participants currently mark
Want to watch. Exclude titles that only one participant has marked. Use
current choices, so removing Want to watch removes the title from the
shared results.

**Why:** The user specified every shared title when asked whether to show
shared choices or everything either participant has added.

**Tradeoff:** Titles wanted by only one participant do not appear as
suggestions in this view.

### Watch together ordering — 2026-09-07

**Decision:** Order shared titles by when they most recently became a
shared Want to watch choice, newest first. For two people, this is the later
of their current Want to watch additions. Adding a title again after
removing it can make it a new shared match.

**Why:** The user accepted newest shared matches first so new options are
easy to notice.

**Tradeoff:** Alphabetical order would make a known title easier to find,
but it would not surface new shared choices first.

### Watch together title-type filter — 2026-09-07

**Decision:** Provide All, Movies, and TV filters. Select All by default.
Each filter preserves the newest-shared-first ordering.

**Why:** The user accepted the filter so participants can narrow the list
to the kind of title they feel like watching.

### Watch together title actions — 2026-09-07

**Decision:** Selecting a result opens its existing title page. Users change
their Want to watch choice there. The Watch together page provides browsing
and filtering, with no inline changes to title choices.

**Why:** The user chose to use the existing title pages for changes.

### Streaming services from either participant — 2026-09-10

**Decision:** Compare each shared Want to watch title with the streaming
services saved by either participant. A matching service held by one person
is enough; both people do not need the same service. Show matching titles
first. Keep shared titles without a matching service in a separate section
below, explaining that neither person has a listed service for them.
Preserve the existing shared-choice ordering within each section.

This extends the earlier single-list presentation. It does not change the
requirement that both participants currently want to watch each title.
Implementation is tracked in [issue #93](https://github.com/jubishop/screenr/issues/93).

**Why:** The user wants Watch together to prioritize titles the pair can
watch using a service one of them has, while retaining their other shared
choices below.

### Free options qualify automatically — 2026-09-10

**Decision:** A reported free or ad-supported US option also puts a shared
title in the top section, even when neither participant selected that
service. Label the free option clearly. Paid rental and purchase offers do
not qualify.

**Why:** The user accepted including these options because they do not
require a paid subscription.

## Implementation

The profile link opens `/watch-together?with=<friend-username>`. The signed-in
viewer is always a participant. The page accepts exactly one friend; missing,
repeated, self, and inaccessible participant requests do not return a comparison.
The server uses the same current friendship and blocking rules as private feeds.

`src/server/watch-together.ts` reads participants, permissions, and active
Want to watch choices in one PostgreSQL snapshot. It groups by title identity
and requires a choice from every participant. The query accepts a participant
list to support a future group interface without a separate pair-specific data
model. This does not expose group selection or establish future group rules.

The latest participant addition determines the shared date. Replies and
recommendations do not affect it. Equal dates sort by title name, then title ID,
for stable results. The query returns every match without a feed-sized limit.
The shared-choice query needs no persistent private cache. Issue #93 adds
member service selections in `db/009-streaming-services.sql`. After the
permission check, the server combines the participants' selected service
identities and reads viewing options through the existing availability cache.
It returns only the services matching each shared title, not either person's
full settings or whose service matched.

The page reuses the existing title-result layout and poster component. Its
All / Movies / TV filter stays selected during successful background refreshes;
opening or reloading the page starts with All. Empty states distinguish no
shared choices from no matches for the selected title type. **Ready to watch**
contains titles with a matching saved service or a free option. **Not on your
services** keeps other known shared choices below. **Availability unknown**
keeps failed lookups separate. Each section preserves newest-shared-first
ordering. Service notes use broad identities without plan or reseller labels.

The existing screen refresh checks choices and access every three seconds
while visible and on focus. A failed refresh clears private results until a
successful read. Unfriending or blocking makes the comparison unavailable on
the next access check. Data already delivered to a browser cannot be retracted.
