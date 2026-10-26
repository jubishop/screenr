---
status: current
---

# Title availability

Accepted decisions for [issue #7](https://github.com/jubishop/screenr/issues/7)
and the [viewing-scope change](https://github.com/jubishop/screenr/issues/62).
Screenr obtains US at-home viewing options and shows them on movie and TV
title pages. The accepted decisions and implementation are described below.
[Release status](#release-status-on-title-pages-and-cards--2026-10-16)
covers theaters and upcoming dates for
[issue #310](https://github.com/jubishop/screenr/issues/310).

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
request to investigate theatrical availability alongside streaming. The
[2026-10-16 release status decision](#release-status-on-title-pages-and-cards--2026-10-16)
ends that deferral.

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

## Alphabetical service order — 2026-09-08

**Decision:** Sort services alphabetically by their display names within
both Subs and Free. Apply sorting after grouping duplicate variants.

**Why:** The user accepted predictable ordering that makes services easy
to find.

**Tradeoff:** The display does not prioritize popular services or preserve
TMDB's provider order.

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

## Service names only in the UI — 2026-09-10

**Decision:** Keep visible notes identifying the services that carry a
title, using only the broad grouped names, such as "On AMC+" or "Free on
Tubi". Apply this across title pages, service selection, discovery, and
Watch together. Do not display subscription-plan variants or reseller
notes such as "via Amazon". A channel-only listing still uses its broad
service name.

This supersedes the 2026-09-08 decision to show channel-only route notes.
Keep source provider IDs and registry membership for grouping and matching;
their plan or reseller distinctions are not user-facing labels.

**Why:** The user explicitly asked to retain service notes while using
broader grouping identities everywhere in the UI during
[issue #93](https://github.com/jubishop/screenr/issues/93).

**Tradeoff:** A grouped service match does not verify access through a
particular plan or reseller. The UI does not distinguish those entitlements.

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

**Original issue #7 scope:** The title-page availability section is the only UI addition.
Do not add service preferences, country settings, discovery filters,
availability on other pages, recommendation changes, or Watch together
changes in that issue. Issue #93 adds the
[saved-service discovery](product-brief.md#saved-streaming-services-and-discovery--2026-09-10)
and [Watch together](watch-together.md#streaming-services-from-either-participant--2026-09-10)
uses.

## Release status on title pages and cards — 2026-10-16

**Decision:** Show whether a movie is in US theaters, and when a movie or
show that is not out yet will be released. Show it on title pages beside
the viewing options, and on title cards in Find a title, Want to watch,
Friends recommend, Watch together, and other title lists. The web app and
the iPhone app both show it. Use US release dates only, following the
[US availability decision](#us-availability--2026-09-07); never fall back to
another country's dates. This ends the theatrical deferral in the
[at-home scope decision](#at-home-scope-and-source--2026-09-07).

**Why:** The user asked for theatrical status and upcoming release dates, and
chose title cards as well as title pages. No further reason was stated.

**Tradeoff:** Title lists need release data for each title, which list
results do not carry today. The rejected alternative was title pages only,
with cards in a later issue.

Implementation is tracked in [issue #310](https://github.com/jubishop/screenr/issues/310).

## In theaters from a recent US theatrical date — 2026-10-16

**Decision:** Infer "In theaters" from TMDB release dates, because TMDB
supplies no showtimes. A movie is in theaters when its most recent US
theatrical release, limited or wide, falls within a fixed recent window.
Start with 45 days, tune the window during implementation, and record the
final value here.

**Why:** The user accepted this recommendation.

**Tradeoff:** The label is an estimate. It cannot confirm that a nearby
theater is showing the movie, and a long run can outlast the window.
Rejected alternatives: ending the window early once a Subs or Free option
is listed, and using TMDB's US now-playing list, which is also derived from
release dates and requires fetching a list with many pages.

**Final window:** 45 days, unchanged after checking live TMDB data on
2026-10-25. TMDB's US now-playing list then began 39 days back, and the
sampled wide releases reached US digital about 45 days after opening: Street
Fighter and Resident Evil both took 46 days. The
[implementation](#release-status-implementation) counts the release day and
the 44 days after it.

## Upcoming movie dates include digital releases — 2026-10-16

**Decision:** Show upcoming US theatrical and digital release dates for
movies, such as "In theaters Nov 21" and "Digital Dec 9". Label a digital
release as Digital. A movie with only a digital release, such as a streaming
original, shows its digital date.

**Why:** The user accepted this recommendation.

**Tradeoff:** US digital releases usually start as rentals or purchases,
which Screenr's viewing options exclude. A digital date must not be presented
as a Subs or Free option. Rejected alternatives: theatrical dates only, and
digital dates only for movies with no theatrical release.

## TV series and season premieres — 2026-10-16

**Decision:** A show that has not premiered shows its premiere date and
network, such as "Premieres Nov 4 on Netflix". A released show with an
announced next-season premiere shows that date, such as "Season 3 premieres
Jan 8". Do not show weekly episode air dates.

**Why:** The user accepted this recommendation.

**Tradeoff:** A show that is currently airing shows no next-episode date.
Rejected alternatives: series premieres only, and also showing the next
episode's air date.

## Display transformation

The product decisions above are settled. Use a small checked-in mapping
from TMDB provider IDs to stable service identities, with a display name,
preferred logo, and each member's standalone or reseller route. Prepare
the map from both US movie and TV provider catalogs. Include singleton
services and verify that each known provider ID belongs to one service.
Do not infer equivalence from similar names at runtime.

Preserve the original cached offers and derive the two display sections
when presenting a title. This lets current, older, and newly fetched cache
entries use the same mapping without a data migration or forced refresh.
The registry's existence does not establish an offer: only the title's
reported eligible providers can put a service in a section. Do not display
channel-only notes.

Retain existing behavior for unmatched providers and missing logos:
unmapped IDs remain visible with their reported names, and missing images
do not remove entries. Give unmatched IDs separate identities until their
mapping is known. Choose each grouped logo deterministically, preferring
the service's catalog logo and then a valid reported member logo. Render
the name without an image when none is usable.

Retain the current omission of empty categories. If neither section has
eligible offers, show "No subscription or free options are listed for the
US." For an older successful result, use "No subscription or free options
were listed when last checked." Preserve the separate request-failure
state, last-checked time, and TV season caveat.

Sort by the service display name with consistent English alphabetical
comparison on the server and client, ignoring case. Use the stable service
identity to break ties. Route notes do not affect service ordering.
Acceptance criteria and mapping examples are in issue #62.

## Current implementation

This implementation includes the Subs and Free display from issue #62 and
the saved-service discovery and comparison views from issue #93. It uses the
existing server-side `TMDB_READ_TOKEN`; no additional provider account is
needed.

Account includes optional **Your streaming services** settings. Members can
search the grouped service list, select services, save, cancel, or clear their
choices. Signup does not require selections. These preferences belong to the
signed-in member and are not exposed on public profiles.

**Find a title** shows all catalog results and circle suggestions by default,
with service notes and indicators for saved services. **My services** includes
saved subscription services and any reported free option. **Watch together**
puts shared choices available through either person's services or a free option
first, followed by known unmatched choices and unknown availability separately.
[Want to watch pages](want-to-watch.md) list a profile owner's Want to watch
titles on the viewer's services or free, then unknown availability, and leave
out the rest. These views use US availability, broad service names, and the
existing cache. They preserve their original title order within each displayed
group.

`src/server/catalog.ts` fetches and validates the US watch-provider response.
`db/007-title-availability.sql` adds a separate cache keyed by title and
country. The cache retains original provider names, IDs, logos, categories,
and the watch-page link. Repeated offers stay in new cache payloads so that
a later occurrence with a missing logo cannot discard a usable earlier logo.
Deduplication happens in the display transformation. Missing or
invalid logos do not remove otherwise valid provider entries. Invalid
responses follow the failure path; links must point to the same title's
HTTPS watch page on TMDB.

`fetched_at` records the last successful fetch, including an empty result.
`refresh_after` controls the next attempt: 24 hours after success or five
minutes after failure. Requests time out after two seconds. Failed refreshes
update only retry timing and preserve the previous payload and successful
fetch time.

`src/server/watch-sources.ts` derives display sections in the common cache
result path. The provider-ID lookup is built once from the checked-in
registry. No catalog request or name inference runs during grouping. The
server sorts services with an English, case-insensitive comparison and a
stable identity tie-breaker; the client renders that same ordered result.
Unknown providers use separate `provider:<id>` identities. Source route
metadata is retained but is not rendered. Canonical logos take precedence;
fallbacks use eligible member ID, reported name, then safe logo path in
deterministic order.

Title screens load availability and trailers concurrently after loading the
title. `src/components/title-availability.tsx` shows Subs and Free,
US region, last-checked time, attribution, and watch-page link. It distinguishes
empty, failed, and older cached data, including older empty results.

`src/server/title-viewing.ts` adds this same availability to catalog results,
circle suggestions, shared Want to watch titles, and Want to watch pages. Each
list reads its cache rows in one query, then requests only missing or expired
entries from TMDB. It allows four concurrent provider requests and stops
starting them after three seconds. Catalog search also stops starting provider
requests seven seconds after the search began, leaving room within the
browser's ten-second deadline. In-flight requests retain the two-second
timeout. Remaining titles use cached data or an explicit unknown state; they
are not dropped. Search summaries create only missing title identities for the
cache and never overwrite richer details.

`db/009-streaming-services.sql` stores each member's selected stable service
identities. `src/server/streaming-services.ts` validates selections against the
registry and replaces them atomically. Account exposes only the signed-in
member's settings. Watch together returns matching services for shared titles,
without disclosing a participant's complete service list or ownership.

`src/components/title-services.tsx` supplies service notes and match indicators
for discovery and Watch together. Free options qualify without a saved
selection. Paid rental and purchase offers do not qualify. Older results keep
an age warning, and failed lookups stay distinct from known unmatched titles.

## Release status implementation

This implements the
[release status decisions](#release-status-on-title-pages-and-cards--2026-10-16)
for the server and web app. The iPhone app receives the same fields; showing
them there is the remaining part of
[issue #310](https://github.com/jubishop/screenr/issues/310).

**Source.** Movie details ask TMDB for
[release dates](https://developer.themoviedb.org/reference/movie-release-dates)
in the same request, with `append_to_response=release_dates`. Only the `US`
result counts: types 2 (limited theatrical) and 3 (theatrical) are
theatrical dates, and type 4 is digital. Premieres, physical and TV
releases, and every other country are ignored, so a movie without a US
result has no label. A show's dates come from its series details: the
premiere is `first_air_date`, or season 1's air date; each later season's
`air_date` is its premiere; and `next_episode_to_air` stands in only when it
is the first episode of a season TMDB has not dated. TMDB gives a show one
set of dates, from its original network, so a show counts only on a US or
worldwide network: the first network whose TMDB `origin_country` is `US` or
empty, as for streaming services such as Netflix. A show only on another
country's network, such as BBC One, gets no label. These shapes were
confirmed against live TMDB responses on 2026-10-25.

**Storage.** [`db/033-title-release.sql`](../db/033-title-release.sql)
adds `title.release`, which keeps only those dates as calendar dates
(`YYYY-MM-DD`, cut from TMDB's midnight-UTC timestamps, never converted to
a time zone). It follows the title details'
[cache](title-catalog.md#title-details): 24-hour freshness and a five-minute
retry after a failure, with the last dates kept. A details response without
usable movie release dates still stores the details, but keeps the last
dates, leaves `fetched_at` unchanged, and retries after five minutes. The
migration marks every stored title due, so each picks up its dates the next
time a title page or list shows it.

**Status.** `src/server/title-release.ts` derives the status each time the
server sends a screen, so a stored row never shows an old status. Today is
the date in `America/Los_Angeles`, the latest mainland US time zone, so no
label calls a title out before its release day there. A movie is in theaters
when its latest US theatrical date on or before today, limited, wide, or a
re-release, is at most 44 days ago. A movie that is not in theaters shows its
next theatrical date, such as "In theaters Nov 21". It shows its first US
digital date while that is ahead, such as "Digital Dec 9"; later digital
dates, which are often a streaming service's arrival, never show, since Where
to watch covers streaming. A show shows "Premieres Nov 4 on Netflix" until
it premieres, then its earliest season premiere still ahead, such as
"Season 3 premieres Jan 8". Next episodes are never shown. Dates name the
month and day, with the year when it is not the current year, as feed times
do.

**Payload.** Title screens send `release` beside `availability`. Every title
list item that carries `viewing`, from the Find a title screen's
`suggestions` and `recommendations`, the `search` action, Watch together's
`titles`, and Want to watch pages' `titles`, also carries `release`. Its shape is `TitleRelease` in
`src/shared.ts`:

```json
{
  "status": "ok",
  "in_theaters": true,
  "upcoming": [
    { "kind": "digital", "date": "2026-12-09", "label": "Digital Dec 9" }
  ]
}
```

`status` is `unavailable` when the release data could not be loaded, which
shows no label. `upcoming` kinds are `theatrical`, `digital`, `premiere`, and
`season_premiere`, in date order. Clients show "In theaters" when
`in_theaters` is set, then each `label`, and never derive either from the
dates. Later features, such as In theaters lists, read `in_theaters` and
`status` from `withViewingOptions` or `getTitleReleases` instead of
computing theatrical status again.

**Lists.** `getTitleReleases` in `src/server/catalog.ts` reads a list's
stored titles in one query and refreshes only missing or expired details, at
most four at a time. `withViewingOptions` runs it beside the availability
lookup with the same deadlines: no request starts after three seconds, or
seven seconds after a search began. A title left unrefreshed keeps its stored
dates, or an unavailable status, and stays listed. Search summaries are
stored without dates, so a search refreshes each new result's details.

**Web.** `src/components/title-release.tsx` shows the status, such as
"In theaters · Digital Dec 9", on title cards, Find a title's suggestion
tiles, and at the top of Where to watch, outside its Subs and Free groups.
The text comes from the screen data, never the reader's clock, so server
and hydration markup match.

## Provider registry and maintenance

[`src/server/watch-provider-registry.json`](../src/server/watch-provider-registry.json)
contains 265 service identities covering all 332 distinct IDs in the US
catalogs fetched on 2026-09-08: 292 movie IDs and 272 TV IDs. These counts
describe that snapshot, not a permanent completeness target. The
[checked-in snapshot](../tests/fixtures/watch-provider-catalogs-us.json)
retains each catalog's IDs and the original provider names and logos.
Catalog data comes from TMDB and its JustWatch-backed provider source.

Each service has a stable key, display name, preferred logo path, and member
IDs. `via: null` means a direct service or plan; a reseller name identifies
a channel. Channel-only services without a canonical logo use a reported
eligible logo instead. A preferred logo does not establish availability.

The map covers small services and singleton channels as well as the issue's
examples. For example, BroadwayHD, MyOutdoorTV, MHz Choice, Cineverse, and
FOX One include their Amazon channels. Carnegie Hall+ combines its Amazon
and Apple TV routes even though neither US catalog lists a direct member.
Sling TV groups Orange and Orange and Blue as plans of one service, following
[Sling's plan comparison](https://www.sling.com/service/compare-plans).
ViX groups its free service and Premium channel; ViX presents free and
Premium as [account options for the same service](https://vix.com/es-es/registro).
These sources were checked on 2026-09-08.

Keep ambiguous catalog identities separate pending evidence. In this
snapshot these include Plex and Plex Channel, FilmBox+ and FilmBox Live,
and Fandango and Fandango At Home. Related but distinct products also retain
separate entries: YouTube and YouTube TV, AMC and AMC+, Hallmark TV and
Hallmark+, and IndieFlix and IndieFlix Shorts. A shared brand or a channel's
logo alone does not justify merging products.

To maintain the registry:

1. Fetch both complete catalogs with the existing server-side TMDB token:
   `GET /3/watch/providers/movie?watch_region=US&language=en-US` and
   `GET /3/watch/providers/tv?watch_region=US&language=en-US`. See the
   [movie list](https://developer.themoviedb.org/reference/watch-providers-movie-list)
   and [TV list](https://developer.themoviedb.org/reference/watch-provider-tv-list).
   This is maintenance work; automated tests use the saved snapshot.
2. Update the snapshot's fetch time, movie/TV ID lists, and combined provider
   records. Preserve each original ID, name, and logo. Review additions,
   removals, name changes, and logo changes before updating service records.
3. Assign every ID in the union to exactly one service. Explicit channel
   labels supply reseller evidence; review spelling variants and plans
   before merging them. Keep stable keys when display names change. Record
   uncertain identities separately; never guess their routes at runtime.
4. Run `npx tsx --test tests/app/watch-provider-registry.test.ts` for coverage,
   unique membership, and data validation. Update public title-screen tests
   for changed identity decisions, then follow the
   [local and CI validation policy](development-workflow.md#local-and-ci-validation).

No migration, cache reset, token change, or extra deployment action is
required for a registry update. Unknown IDs remain visible until reviewed.

## Verification

Exercise the public catalog or title-screen interface with a fake TMDB HTTP
service and the real database, following the existing catalog tests. Cover
movies and TV, all viewing categories, missing US data, empty results,
fresh and expired caches, and failed or malformed provider responses.
Cover both display sections, same-service plans and channels, distinct
products, unknown IDs, eligible logo fallback, retained route metadata,
and deterministic sorting. Include fresh and stale pre-existing cache rows
with all five original categories. Verify that successful data survives a
failed refresh and that failure does not break the title or its conversations.
Browser coverage should verify
the title-page presentation, sections, attribution, link, and data states.
Check desktop, mobile, and 320px width with long names and grouped services.
Assert that plan and reseller suffixes are absent from rendered service names.
The registry test checks the full union rather than a fixed provider count.

`tests/app/streaming-services.test.ts` covers authenticated writes, isolation,
validation, free access, either participant's services, and blocked access.
`tests/app/title-viewing.test.ts` covers enrichment, cache reuse, failure
recovery, bounded cold-list requests, and single-query cache reads for the
suggestion and Watch together screens through the public API.
`tests/browser/streaming-services.spec.ts` covers saving, cancelling, clearing,
failed saves, filters, background preference changes, and responsive grouping.

`tests/app/title-release.test.ts` covers release status through title pages,
Find a title, the Find a title screen, Want to watch, and Watch together, with a fake TMDB
service, the real database, and a fixed US date: both edges of the
theatrical window, limited releases and re-releases, upcoming theatrical and
digital dates, digital-only movies, past dates, missing US data and other
countries' dates, series and season premieres, shows with no announcement
or only weekly episodes, cache reuse and expiry, failed and unusable
responses, one stored-title read per list, and bounded requests within the
search deadline. `tests/browser/title-release.spec.ts` checks the title page
and the cards in Find a title, Friends recommend, Want to watch, and Watch
together at desktop, mobile, and 320px widths.
