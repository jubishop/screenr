---
status: current
---

# Title catalog

Screenr reads movie and TV details and trailers from TMDB on the server, using
the `TMDB_READ_TOKEN` described in [local setup](running-screenr.md#local-setup).
This page covers title search, how title details and trailers are
cached, attributed, and shown, the season and episode lists for TV
discussion labels, and the titles that links shared to the iPhone app name.
[Title availability](title-availability.md) covers US viewing options.

## Title details

TMDB data is cached for 24 hours. A title page refreshes stored title details
after that, with a two-second timeout. If TMDB fails, times out, returns an
invalid title, or no longer has the title, the page shows the stored details
and waits five minutes before retrying. Migration `013-title-retry.sql` adds
the nullable `title.retry_after` column for this delay, which the previous
release ignores; `fetched_at` still records the last successful fetch. Only a
title that was never stored depends on TMDB, with an eight-second timeout.
For such a title, a TMDB 404 returns not found, and any other TMDB failure or
invalid response returns a 502 catalog error. Details whose TMDB ID differs
from the requested ID count as an invalid title, and their contents are stored
under neither ID. Search returns the same catalog
errors. It sends no request for fewer than two non-space characters, rejects
queries over 120 characters, and drops results that are not movies or TV.
Movie details include their US release dates, which share this cache;
title lists also refresh missing or expired details for them. See
[release status](title-availability.md#release-status-implementation).
Title details, trailer, and availability load in parallel, and the optional
caches are written once the title is stored. Actions and comments use the
stored title without contacting TMDB, so members can still remove actions on
a title TMDB dropped.

`public/tmdb.svg` is the unmodified approved short logo from the
[TMDB logo page](https://www.themoviedb.org/about/logos-attribution).
The Credits page supplies the required attribution notice.

## Title trailers

Title pages use TMDB's [movie videos](https://developer.themoviedb.org/reference/movie-videos)
and [TV videos](https://developer.themoviedb.org/reference/tv-series-videos)
endpoints on the server. The first supported official trailer is preferred,
then the first supported unofficial trailer. Only YouTube videos marked
`Trailer` with a valid video ID and nonempty name are supported. Clips,
teasers, other providers, and malformed records are skipped.

Migration `003-title-trailers.sql` adds a separate public metadata cache.
Successful results, including no supported trailer, last 24 hours. Failed or
malformed responses are retried after five minutes. Trailer requests time out
after two seconds. A failure leaves the title details and conversations
available and shows no player. TMDB credentials stay on the server.

Title pages show a one-line Play trailer button beside a direct YouTube link
and load nothing from YouTube until the viewer activates the button
([collapsed trailer decision](interface-design.md#trailer-collapsed-until-played--2026-10-12)).
Activating it opens the responsive 16:9 player inline, moves focus to it, and
requests autoplay, which some browsers block until the viewer presses play
in the player. The open player stays open through background refreshes and
shows fallback text below it. The direct link remains for restricted,
removed, or otherwise unavailable embeds.

The player uses the `www.youtube.com` embed domain,
[YouTube's inline playback parameters](https://developers.google.com/youtube/player_parameters),
and a minimum height of 200 pixels. It delegates autoplay, encrypted media,
fullscreen, and picture-in-picture to that frame, so a page
`Content-Security-Policy` must allow `https://www.youtube.com` frames and a
`Permissions-Policy` must not deny those features to it. Its iframe
explicitly uses `strict-origin-when-cross-origin` to satisfy
[YouTube's referrer requirement](https://developers.google.com/youtube/terms/required-minimum-functionality#embedded-youtube-player-and-player-api-clients).
This sends the site origin without the title path. The site's default
`no-referrer` policy still applies to other requests.

The catalog tests exercise real HTTP and PostgreSQL boundaries. Browser tests
replace YouTube at the network boundary. They check that a title page sends
no YouTube request before Play trailer, the one-line collapsed layout, focus
on the opened player, its delegated features under the page's policy,
conditional rendering, desktop and mobile dimensions, the actual outgoing
referrer, and that background refreshes keep the iframe without reloading it.
Also verify an available real trailer in a local browser before release:
confirm in the network panel that the title page contacts no YouTube domain
before Play trailer, press Play trailer, check advancing playback on desktop
and mobile, and check the provider link.
Automated provider fixtures do not establish live YouTube availability.

## Season and episode lists

The TV discussion composer's
[Season and Episode pickers](title-feed.md#season-and-episode-labels) read
TMDB's [TV series details](https://developer.themoviedb.org/reference/tv-series-details)
and [TV season details](https://developer.themoviedb.org/reference/tv-season-details)
through the `seasons` and `episodes` actions. `titleSeasons` and
`seasonEpisodes` in `src/server/catalog.ts` request them only when a member
opens the composer or chooses a season, with a five-second timeout. The
browser keeps them for that page; the server caches nothing. Seasons and
episodes need positive whole numbers. Specials, TMDB's season 0, are left out
because a label reads "Season N". A season without a name shows "Season N",
and an episode without one shows only its number. A movie ID returns not
found, a TMDB 404 returns not found, and other TMDB failures or malformed
lists return a 502 catalog error, so the post has no label.

## Shared links

The iPhone app's [share extension](../ios/README.md#share-extension) sends the
link and any text another app shared to the `resolve-title` action, such as
`GET /api/screenr/resolve-title?url=…&text=…`. It answers
`{ title, query }`: the stored title the link names, or `title: null` with
the text the extension's search starts from, which may be empty.
`resolveSharedTitle` in `src/server/shared-links.ts` reads the link, or the
first web link in the text when the share has none:

| Link | Result |
| --- | --- |
| TMDB, such as `themoviedb.org/movie/550-fight-club` or a season or other page of `/tv/1396` | That movie or show. |
| IMDb, such as `imdb.com/title/tt0111161/` or a localized `/de/title/…` | TMDB's [find by IMDb ID](https://developer.themoviedb.org/reference/find-by-id), five-second timeout: its movie, or its show, which an episode's or season's ID also names. |
| JustWatch, such as `justwatch.com/us/movie/dune-2021` or a season of `/us/tv-show/severance` | The IMDb ID on the title page, through TMDB's find. |
| Netflix, such as `netflix.com/title/80057281` | A search for the name in the title page's heading. |
| Anything else | A search for the shared text. |

The title then loads like any title page's, stored if it was not. A TMDB 404,
an IMDb ID that TMDB does not know, or a JustWatch page without exactly one
IMDb ID gives a search, as do other links. Other TMDB failures return the
usual 502 catalog error. A link over 2,048 characters returns 400, and only
the text's first 1,000 characters count.

**JustWatch and Netflix findings (2026-10-14):** neither site offers a public
API for this. JustWatch's title pages embed the title's IMDb ID in their page
state, exactly one per page on every title page checked, and most carry
JSON-LD with the name. Netflix's title pages have only `Netflix` as their
`<title>`, no Open Graph title or JSON-LD, and no other catalog's ID; their
first `<h1>` holds the title's name. TMDB has no Netflix IDs, so a Netflix
link cannot name a title directly; the extension's search starts from that
name instead, and the member picks the title. Shared Netflix links checked:
Stranger Things, Breaking Bad, Squid Game, and Dark.

The server requests only the shared page's own path on
`https://www.justwatch.com` or `https://www.netflix.com`, follows at most
three redirects within that site, stops after five seconds, and reads at most
5 MB; title pages run about 1 to 1.5 MB. A failed page leaves the search: the
JustWatch link's name, such as "dune" from `dune-2021`, or the shared text.
No other site is fetched. Tests serve both sites' pages from a loopback
server named by `SCREENR_TEST_PAGES_URL`.

The search text is the name in quotes, if any, or the text without links,
site names such as "Netflix" or "IMDb", a leading "Watch" or "Check out"
beside them, and a trailing year or kind, such as "Fight Club" from "Fight
Club (1999) - IMDb" and "Stranger Things" from "Check out Stranger Things on
Netflix!". It is at most 120 characters, the search's limit.
`tests/app/shared-links.test.ts` covers each source against fake TMDB and
page servers.
