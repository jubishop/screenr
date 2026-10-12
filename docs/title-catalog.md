---
status: current
---

# Title catalog

Screenr reads movie and TV details and trailers from TMDB on the server, using
the `TMDB_READ_TOKEN` described in [local setup](running-screenr.md#local-setup).
This page covers title search and how title details and trailers are
cached, attributed, and shown. [Title availability](title-availability.md) covers US viewing options.

## Title details

TMDB data is cached for 24 hours. A title page refreshes stored title details
after that, with a two-second timeout. If TMDB fails, times out, returns an
invalid title, or no longer has the title, the page shows the stored details
and waits five minutes before retrying. Migration `013-title-retry.sql` adds
the nullable `title.retry_after` column for this delay, which the previous
release ignores; `fetched_at` still records the last successful fetch. Only a
title that was never stored depends on TMDB, with an eight-second timeout.
For such a title, a TMDB 404 returns not found, and any other TMDB failure or
invalid response returns a 502 catalog error. Search returns the same catalog
errors. It sends no request for fewer than two non-space characters, rejects
queries over 120 characters, and drops results that are not movies or TV.
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
on the opened player, conditional rendering, desktop and mobile dimensions,
the actual outgoing referrer, and that background refreshes keep the iframe
without reloading it. Also verify an available real trailer in a local
browser before release: confirm in the network panel that the title page
contacts no YouTube domain before Play trailer, press Play trailer, check
advancing playback on desktop and mobile, and check the provider link.
Automated provider fixtures do not establish live YouTube availability.
