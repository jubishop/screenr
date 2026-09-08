---
status: current
---

# Title availability

Accepted decisions for [issue #7](https://github.com/jubishop/screenr/issues/7).
Screenr obtains US at-home viewing options and shows them on movie and TV
title pages. The accepted decisions and implementation are described below.

## At-home scope and source — 2026-09-07

**Decision:** Use TMDB's JustWatch-backed watch-provider data through the
existing server-side catalog client. Identify services and preserve their
subscription, free, ad-supported, rental, and purchase categories. Store
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
