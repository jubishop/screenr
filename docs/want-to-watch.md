---
status: current
---

# Want to watch pages

A profile's Want to watch page lists the profile owner's current Want to
watch titles that the viewer can watch now.
[Issue #313](https://github.com/jubishop/screenr/issues/313) built it for the
web, following the [Want to watch page decision](product-brief.md#want-to-watch-page--2026-10-16).
[Issue #311](https://github.com/jubishop/screenr/issues/311) adds its
[At home and In theaters switch](product-brief.md#in-theaters-on-want-to-watch-pages--2026-10-16),
and [issue #314](https://github.com/jubishop/screenr/issues/314) adds the page
to the iPhone app. The page described here becomes At home.

## Implementation

The viewer's own profile and accepted friends' profiles link to
`/people/<username>/want-to-watch` above the Friends list. The link appears
when the profile's `can_read` is true, so non-friends, pending requests, and
blocked members see no link. `src/member-routes.ts` parses the route, and
`memberTitle` names the page "Want to watch · <display name>", or the
`@username` until the owner loads.

`src/server/want-to-watch.ts` checks access and reads the owner's active Want
to watch entries in one PostgreSQL statement, so both come from one snapshot.
Access uses `screenr_can_read`: the viewer's own page always loads; another
member's needs an accepted friendship and no block in either direction.
Missing, inaccessible, and blocked pages respond 404 with "Want to watch not
found." from both the page and the screen API, and a refresh after an
unfriend or block shows that message. Titles are ordered by when they became
Want to watch, newest first, then by name and ID. A title moved off Want to
watch, by clearing it, recommending it, or choosing a progress status, drops
out on the next read; saving it again puts it first.

The read then loads the viewer's saved services and the titles' viewing
options together, through `withViewingOptions` in `src/server/title-viewing.ts`.
That reads the availability cache for the whole list in one query and does
bounded provider work, as for Watch together and Find a title. The cache,
grouping, failure retry, and older-data label follow
[title availability](title-availability.md) unchanged.

Each title's `access` comes from `viewingAccess` in `src/viewing.ts`: a
subscription offer on one of the viewer's saved services, or any free or
ad-supported option, makes it `available`; a failed lookup makes it
`unknown`. Rental and purchase offers never count. The server drops
`unmatched` titles, so the page receives only titles it shows. The owner's
saved services are never read: on a friend's page, the viewer's services
decide, and the response is the same whatever the owner saves.

The screen payload, which the iPhone app also reads through
`/api/screenr/screen?path=/people/<username>/want-to-watch`, is:

```text
kind               "want-to-watch"
owner              the profile owner: user_id, username, display_name, photo
viewerHasServices  whether the viewer has saved any streaming services
hasWantToWatch     whether the owner has any current Want to watch titles,
                   including ones the viewer cannot watch now
titles             newest first; each title's fields, viewing, access
                   ("available" or "unknown"), and matchingServiceIds, the
                   viewer's saved services that carry it
```

Titles have the same shape as Watch together's, so ScreenrKit decodes them as
`SharedTitle` in `WantToWatchScreen`. The iPhone fixtures are in
`ios/ScreenrKit/Fixtures/screen/want-to-watch/`.

`src/components/want-to-watch.tsx` renders the page with the shared
`src/components/title-card.tsx`, whose service notes read "On Netflix" or
"Free on Tubi TV" and mark the viewer's matching services. Each card also
shows the title's
[release status](title-availability.md#release-status-implementation), such
as "In theaters", from the `release` field. Selecting a title
opens its title page; the page has no inline title actions. The All, Movies,
and TV filter in `src/components/title-kind-filter.tsx`, shared with Watch
together, keeps the server's order and resets to All on reload. **Ready to
watch** lists the available titles, and **Availability unknown** follows it.
The At home and In theaters switch from issue #311 goes between the page
heading and the filter.

Empty states distinguish an owner with no Want to watch titles ("No Want to
watch titles yet.", with Find a title on the viewer's own page), titles none
of which the viewer can watch now ("Nothing to watch right now."), and none
for the selected title type ("No movies to watch right now."). A viewer
without saved services sees Watch together's "Save your streaming services to
see what you can watch right now." note, linked to
`/account#streaming-services`. The page refreshes like other member screens.

Saves started from this page's title links count under the `title` surface in
[usage telemetry](usage-telemetry.md#save-attribution).

## iPhone app

The iPhone app follows the web page. `Destination.wantToWatch(username:)`
reads and writes `/people/<username>/want-to-watch`, so universal links and
`screenr-dev://` links open it: the viewer's own page above the You tab's
profile, and a friend's on the current tab. `ProfileView` links to it above
the Friends list when the profile's `canRead` is true. `WantToWatchView` and
`WantToWatchList` render ScreenrKit's `WantToWatchScreen`, whose extension
in `ios/ScreenrKit/Sources/ScreenrKit/People/WantToWatch.swift` holds the
sections, the count, the empty states, and the introduction in the web's
words. The page polls like other screens. The services note opens Settings,
where streaming services are saved, and each title opens its title page
without a list's surface, so a save there reports `title`. Block closes the
blocked person's page on every tab. On the viewer's own page, each title
joins Spotlight, since the viewer saved it to Want to watch; a friend's page
adds nothing. The At home and In theaters switch from
[issue #312](https://github.com/jubishop/screenr/issues/312) goes between
the introduction and the filter.

## Verification

`tests/app/want-to-watch.test.ts` uses a fake TMDB service and the real
database. It covers saved-service matches, free options, rental-only
exclusion, the viewer's services deciding on a friend's page, unknown and
older availability, ordering, titles moved off Want to watch, one cache read
for the list, and the friendship and blocking rules.
`tests/app/member-routes.test.ts` covers the route and its document title.
`tests/browser/want-to-watch.spec.ts` covers the profile links, the page at
1440, 390, and 320px without horizontal overflow, keyboard use of the link,
filter, and title rows, the empty states and services note, refreshes, and
the unfriend result, with no page or hydration errors.

In the iPhone app, ScreenrKit's `WantToWatchTests`, `DestinationTests`,
`RouterTests`, `ProfileModelTests`, and `TitleSpotlightTests` cover the
model, route, placement, Block, and Spotlight. The UI tests'
`WantToWatchTests` open the viewer's own page from the You tab, filter it,
and open a title, open a friend's page, check that a non-friend's profile has
no link, audit the largest text size, and render every
`screen/want-to-watch` fixture from its link. `ShellTests` opens the
viewer's own page from a link.
