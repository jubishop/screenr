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

### Prompt to save streaming services — 2026-10-12

**Decision:** When the viewer has no saved streaming services, show a short
note above the Watch together results: "Save your streaming services to see
what you can watch right now." Link it to the streaming services setting on
the Account page. The note does not change which titles appear or their
order.

**Why:** The user accepted the prompt after the 2026-10-12
[design review](interface-design.md) found that a viewer without saved
services sees shared titles under "Not on your services" with no hint about
the cause.

### At home and In theaters modes — 2026-10-16

**Decision:** Keep the single Watch together link on a friend's profile.
The page switches between At home and In theaters, with At home selected
by default. At home is the comparison described above, unchanged.
In theaters lists shared movies that are in US theaters now, following the
[In theaters decision](title-availability.md#in-theaters-from-a-recent-us-theatrical-date--2026-10-16).
It shows no showtimes, theater locations, or ticket links, and uses no
member location.

**Why:** The user wants one Watch together option for watching at home and
another for going out to a theater. They chose in-theaters status alone
because showtimes need a separate, usually paid, provider and a member
location setting.

**Rejected alternatives:** Two separate links on the friend's profile.
Adding showtimes and nearby theaters. Filing the data source as research
first.

Implementation is tracked in [issue #311](https://github.com/jubishop/screenr/issues/311)
and, for the iPhone app, [issue #312](https://github.com/jubishop/screenr/issues/312).

### In theaters uses shared choices — 2026-10-16

**Decision:** In theaters includes only movies that both participants
currently mark Want to watch, the same rule as At home.

**Why:** The user chose to keep the shared-choice rule.

**Tradeoff:** The list will often be short or empty, because a movie must
be both a shared choice and in theaters now. The rejected alternative
listed movies that only one participant wants below the shared ones.

### Unknown release data in In theaters — 2026-10-16

**Decision:** When a movie's release data cannot be loaded, In theaters
lists it in a separate Availability unknown section below the list instead
of leaving it out. This applies to Watch together and to
[Want to watch pages](product-brief.md#in-theaters-on-want-to-watch-pages--2026-10-16),
matching the Availability unknown section At home already uses.

**Why:** The user accepted this.

**Rejected alternative:** Leaving such movies out of In theaters.

### The selected mode stays in the URL — 2026-10-16

**Decision:** The page URL records the selected mode, such as
`mode=theaters`, so reloading the page keeps At home or In theaters. A URL
without the mode opens At home. This applies to Watch together and to Want
to watch pages.

**Why:** The user accepted keeping the choice in the page address.

**Rejected alternative:** Starting in At home on every reload, as the
title-type filter resets to All.

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

The page shares the search result title card in
`src/components/title-card.tsx`. Its All / Movies / TV filter stays selected
during successful background refreshes; opening or reloading the page starts
with All. Empty states distinguish no shared choices from no matches for the
selected title type. **Ready to watch** contains titles with a matching saved
service or a free option. **Not on your services** keeps other known shared
choices below. **Availability unknown** keeps failed lookups separate. Each
section preserves newest-shared-first ordering. Service notes use broad
identities without plan or reseller labels. The server reports only whether
the viewer has saved services. Without any, the page shows the prompt above
the results, linked to `/account#streaming-services`.

The existing screen refresh checks choices and access every three seconds
while visible and when the page becomes visible again. A failed refresh
clears private results until a successful read. Unfriending or blocking
makes the comparison unavailable on the next access check. Data already
delivered to a browser cannot be retracted.
