---
status: current
---

# Title availability

Accepted decisions for [issue #7](https://github.com/jubishop/screenr/issues/7)
and the [viewing-scope change](https://github.com/jubishop/screenr/issues/62).
Screenr obtains US at-home viewing options and shows them on movie and TV
title pages. The accepted decisions and implementation are described below.

## At-home scope and source — 2026-09-07

**Decision:** Use TMDB's JustWatch-backed watch-provider data through the
existing server-side catalog client. Identify services and preserve their
original subscription, free, and ad-supported categories in the source data.
Display subscription offers under Subs and both free offer types under
Free. The
[2026-09-08 scope decision](#subscription-and-free-viewing-only--2026-09-08)
supersedes the original inclusion of rental and purchase offers. Store
provider IDs, names, logos, and the supplied TMDB watch-page link. Credit
JustWatch when displaying this data.

**Why:** The user confirmed that identifying services and viewing options
is sufficient. Screenr can obtain this information through its existing
catalog provider.

**Tradeoff:** Prices and direct playback links are outside the first
version. The supplied TMDB watch page provides further viewing information.
Theatrical availability is deferred. This replaces the issue's original
request to investigate theatrical availability alongside streaming.

Use these [movie](https://developer.themoviedb.org/reference/movie-watch-providers)
and [TV](https://developer.themoviedb.org/reference/tv-series-watch-providers)
endpoints:

```text
GET /3/movie/{movie_id}/watch/providers
GET /3/tv/{series_id}/watch/providers
```

TMDB documents country-specific provider data, the watch-page link, and
required JustWatch attribution. These endpoints do not supply prices or
direct playback links. Its [discovery reference](https://developer.themoviedb.org/reference/discover-movie)
lists the category values `flatrate`, `free`, `ads`, `rent`, and `buy`.
Sources checked on 2026-09-07.

## Subscription and free viewing only — 2026-09-08

**Decision:** Exclude rental and purchase offers from Screenr's title
availability display. Use exactly two main sections: Subs and Free.
Subs contains subscription (`flatrate`) offers. Free combines `free` and
free ad-supported (`ads`) offers, with no separate Free with ads category.
This supersedes both the rental and purchase scope and the separate free
and ad-supported display categories accepted on 2026-09-07.

Exclude offers by category, not whole providers. A service with rental or
purchase offers can still have eligible subscription or free offers for a
title. Apply this rule to existing cached results as well as new responses,
before any grouping of duplicate services. Paid subscriptions with ads
remain subscription offers. When the same provider appears in both `free`
and `ads`, show it once under Free.

**Why:** The user wants only subscription and free viewing categories. No
further reason was stated for excluding rental and purchase offers.

**Tradeoff:** Titles with only rental or purchase offers will have no listed
subscription or free options. The empty state must describe that limited
scope without claiming the title is unavailable everywhere. The supplied
external TMDB watch page may still list rental and purchase offers. Free
means no payment is required for the offer; it does not promise ad-free
viewing.

Implementation is tracked in [issue #62](https://github.com/jubishop/screenr/issues/62).
The section structure and duplicate-service behavior are defined below.

## Group services within each viewing category — 2026-09-08

**Decision:** Make Subs and Free the first division in the source list.
Group duplicate variants of a service within each section. For example,
Netflix and Netflix with ads share one entry under Subs; Apple TV and its
Amazon channel share one Apple TV entry in the applicable section.

If a service has both subscription and free offers for the same title,
show it once under Subs and once under Free. Deduplicate by service within
each section, never across the entire title's source list. A single list
with category labels beside each service was rejected.

**Why:** The user wants payment category to be the first distinction while
removing duplicate service variants within each category.

**Tradeoff:** A service can appear twice when it has offers in both
categories. Those entries convey different viewing options.

Issue #62 covers both the category changes and duplicate-service grouping.
Use the service identity boundary below when preparing the provider map.

## Service identity boundary — 2026-09-08

**Decision:** Merge plans and reseller versions of the same service. Keep
distinct products separate even when they share a brand or owner. YouTube
and YouTube TV remain separate entries, as do AMC and AMC+.

**Why:** The user confirmed that YouTube and YouTube TV are very different
products. A shared brand does not make their viewing options equivalent.

**Tradeoff:** Some related names remain in the list because they identify
different services. Reducing the entry count must not erase that distinction.

The provider map must follow this boundary across the full supported US
catalog. Its exact records are implementation work, not permission to merge
products solely because their names are similar.

## Channel-only availability notes — 2026-09-08

**Decision:** When only a reseller's channel is listed for a service, keep
one entry under the service's name and add a small route note, such as
Apple TV with "via Amazon". Omit that note when the standalone service is
also listed in the same section for the title.

Apply the rule independently within Subs and Free. A standalone offer
under Free does not remove a required route note under Subs. If several
resellers are listed without a standalone offer, combine their distinct
names in the same note rather than adding service entries. Only mention
routes actually reported for that title and section.

**Why:** The user accepted retaining useful access information without
adding duplicate service entries.

**Tradeoff:** Channel-only entries need a little more text. A grouped name
alone must not imply that a standalone offer was reported.

## US availability — 2026-09-07

**Decision:** Select the `US` result for the first version. Keep country
explicit in stored availability records so other countries can be supported
later.

**Why:** The user confirmed US-only coverage for now. No further reason
was stated.

**Tradeoff:** These results describe the US catalog. They do not establish
availability when a member watches from another country. Missing US data
must not fall back to another country's results.

## Cache and failure behavior — 2026-09-07

**Decision:** Cache availability separately from title details, keyed by
title and country. The title key includes whether the entity is a movie or
TV show. Refresh on demand after 24 hours. Preserve the last successful
result on request failure and retry after a short delay. Keep a successful
empty result distinct from a failed request.

**Why:** The user accepted this implementation recommendation. It follows
the existing catalog cache duration and avoids a provider request on every
title-page refresh. Preserving the last successful data makes temporary
provider failures less disruptive.

**Tradeoff:** Availability is a cached provider report, not a real-time
guarantee. An empty result means no options are listed, not that a title is
unavailable everywhere. A failed refresh must not make old data appear
newly checked or remove the title details and conversations.

Successful empty results also use the 24-hour cache. Implementation should
bound provider request time and keep freshness separate from retry timing.
With no successful result, report that availability could not be loaded.
If older data is displayed after a failed refresh, make its age clear.

## Title-page display — 2026-09-07

**Decision:** Show how each movie or TV show can be watched from home on
its title page. Show US providers by viewing category, with their names and
logos, the supplied TMDB watch-page link, and JustWatch attribution. For TV,
show-level availability must not imply that every season is included.

**Why:** The user explicitly requested this limited display while keeping
the work focused on obtaining availability data.

**Scope:** The title-page availability section is the only UI addition.
Do not add service preferences, country settings, discovery filters,
availability on other pages, recommendation changes, or Watch together
changes in this issue. Further product uses need separate issues.

## Implementation

This section describes the implementation delivered for issue #7, which
still includes rental and purchase offers and separates free and
ad-supported offers. Issue #62 tracks applying the two-category display.

`src/server/catalog.ts` fetches and validates the US watch-provider response.
`db/007-title-availability.sql` adds a separate cache keyed by title and
country. Provider names, IDs, and categories remain distinct. Missing or
invalid logos do not remove otherwise valid provider entries. Invalid
responses follow the failure path; links must point to the same title's
HTTPS watch page on TMDB.

`fetched_at` records the last successful fetch, including an empty result.
`refresh_after` controls the next attempt: 24 hours after success or five
minutes after failure. Requests time out after two seconds. Failed refreshes
update only retry timing and preserve the previous payload and successful
fetch time.

Title screens load availability and trailers concurrently after loading the
title. `src/components/title-availability.tsx` shows the viewing categories,
US region, last-checked time, attribution, and watch-page link. It distinguishes
empty, failed, and older cached data, including older empty results.

## Verification

Exercise the public catalog or title-screen interface with a fake TMDB HTTP
service and the real database, following the existing catalog tests. Cover
movies and TV, all viewing categories, missing US data, empty results,
fresh and expired caches, and failed or malformed provider responses.
Verify that successful data survives a failed refresh and that failure does
not break the title or its conversations. Browser coverage should verify
the title-page presentation, categories, attribution, link, and data states.
