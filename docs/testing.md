---
status: current
---

# Testing Screenr

This guide covers the test commands, the browser harness, shared fixtures,
the iPhone API fixtures, resource ownership rules, coverage, and browser
failure diagnostics. Complete
[local setup](running-screenr.md#local-setup) first. The
[development workflow](development-workflow.md#testing) records the decisions
behind browser setup, coverage placement, serving mode, and validation modes.

## Running checks

```sh
npx playwright install chromium
bin/check --full
```

`bin/check --full` preserves the repository foundation tests and adds formatting,
TypeScript, PostgreSQL tests, and the browser suite against a fresh production
build. The browser command performs that build once; the full check does not
build a second artifact afterward.
Plain `bin/check` runs only fast repository static checks; use
`bin/check --documents-only` for Markdown edits. Follow the
[local and CI validation policy](development-workflow.md#local-and-ci-validation)
for focused checks during implementation and full validation before merge.
The local default test database is `screenr_test` on port 5439. Override it
with `TEST_DATABASE_URL`. The test role must be able to create databases.
All test databases are disposable and are reset by the harness; never point
these commands at a database with records to keep.

## Running one suite

Browser tests use `tests/browser/<feature>.spec.ts`. Application and database
tests use `tests/app/<feature>.test.ts`. Related features use the same name in
both directories. Each feature file has one feature responsibility; do not
recreate a catch-all suite or divide a feature into numbered fragments. Shared
helpers use neither suffix, and feature-only helpers stay beside their tests.

With the latest Node LTS release selected, run one suite by its filename:

```sh
npx tsx scripts/test-database.ts
npx tsx --test tests/app/reactions.test.ts
npm run test:browser -- tests/browser/reactions.spec.ts
```

Set `TEST_DATABASE_URL` to a dedicated database ending in `_test` when another
checkout is running application tests. The browser harness already owns a
checkout-specific database and port range. `npm test` discovers all application
`*.test.ts` files and keeps file execution serial; `npm run test:browser`
discovers all browser `*.spec.ts` files with two workers and full parallel
scheduling.

Long scenarios that follow the same saved entries, drafts, or identities
through later changes stay as one scenario. Their later checks depend on the
earlier state, so splitting them would remove the persistence,
authorization, or state-preservation evidence.

## Browser harness

The browser harness derives four loopback ports and a database named
`screenr_browser_<checkout hash>_test` from the checkout's canonical path.
Separate worktrees get separate defaults, Next output, screenshots, and
`.cache/mail` captures. The harness prints its URL and database name at startup.
Browser-facing harness URLs use `127.0.0.1` to match their IPv4-only listeners. Do not replace
this address with `localhost`: Chromium can try IPv6 first, where these servers
do not listen. On macOS, an ephemeral client port that equals that destination
port can form a TCP connection to itself. Chromium then receives its own HTTP
request and reports `ERR_INVALID_HTTP_RESPONSE`, without reaching the proxy.
Next's development image metadata still supplies its own `localhost` origin;
the preview test checks that framework-generated value separately.
`TEST_DATABASE_URL` must name a loopback PostgreSQL test database without URL
query parameters. The browser harness uses the same server and credentials,
with its separate database name.

The standard `npm run test:browser` command builds the current checkout with
`next build`, then serves its generated standalone server with `NODE_ENV=production`.
This uses the same entry point as a packaged release. The harness copies the
build's static assets and `public/` into the standalone directory before serving.
There is no build-reuse switch: focused runs also build first, even when `.next/`
already exists. Compiler caches remain local and may be reused by Next. Listing
tests with `--list` does not start a server or build.

Use `npm run test:browser:dev` to diagnose behavior specific to `next dev`.
This diagnostic command does not perform a production build. A full check
always selects production serving, even if `SCREENR_BROWSER_MODE=development`
is inherited. Direct Playwright and harness calls default to production;
`SCREENR_BROWSER_MODE` accepts only `production` or `development`.

The harness sets its disposable database, auth origin, test Google credentials,
UTC timezone, and local catalog before building. It clears inherited catalog
and email service credentials and the Sentry DSN. No production service or
private dotenv file is needed. Keep credentials out of `NEXT_PUBLIC_*` and
Next's `env` configuration; those values are included in browser bundles.
Normal server configuration stays runtime configuration. The auth fixture
remains a separate process running the real auth handlers with a local Google
provider and file email capture. Next's
production pages and API handlers read the same real signed sessions. Because
the fixture answers `/api/auth/*`, the built auth route runs only in the
[release packaging check](deployment.md#build-and-activate-a-release) and the
deployment's public checks.

`SCREENR_BROWSER_TEST=1` permits the catalog fixture in production mode only
with a loopback browser database, a loopback auth origin, and a loopback catalog
URL. The database must be named `screenr_browser_<name>_test` with no connection
query parameters. This opt-in is set only on harness child processes, not in
Next's compiled configuration or deployment settings. File email capture remains
disabled in the production application; the separate auth fixture owns it.

The default browser command runs independent scenarios with two workers.
Use `npm run test:browser -- --workers=1` for serial execution. The archived
[runtime measurement report](archive/browser-runtime.md) records the speed
comparison, retained coverage, and shared-resource audit.

Every browser run, including CI and local full checks, rejects `test.only`
and `test.describe.only` through Playwright's `forbidOnly` setting. A focused
test therefore fails the gate instead of passing after running only part of
the suite. Focus a local run with a spec path, `path:line`, or `--grep`, for
example `npm run test:browser -- tests/browser/feeds.spec.ts`.
`tests/app/browser-harness.test.ts` covers the rejection. Application tests
need no equivalent setting: `node:test` ignores `only` unless `--test-only`
is passed, and `npm test` does not pass it.

To override a port collision, set `SCREENR_BROWSER_PORT` to the first port in a
free four-port range (1024 through 65532). The following ports serve the catalog,
OAuth fixture, and Next, in that order. Set `SCREENR_BROWSER_DATABASE` to override
the database; it must match `screenr_browser_<name>_test`, contain only lowercase
letters, digits, and underscores, and be at most 63 characters. It must differ
from the database in `TEST_DATABASE_URL`. All browser URLs, callbacks, assertions,
and direct database access use these settings.

Server reuse is disabled. An occupied port fails before fixture reset. Database
locks also reject concurrent runs with the same browser database or checkout.
A port hash collision produces a conflict error; it cannot reuse another server.
Run only one browser suite per checkout at a time. Do not run a separate build
or development server in that checkout while validation owns `.next/`.

Run the repeatable concurrent check with:

```sh
npm run test:browser:isolation
npm run test:browser:isolation -- --warm
```

This copies the current non-ignored Git working files and installed dependencies
into two temporary checkout directories, then runs both complete browser suites
at the same time. It verifies that each build directory resolves inside its
own checkout. It also checks that active database and checkout conflicts
fail before reset. It removes its databases and successful temporary copies.
Failed copies retain browser logs and traces at the printed paths. It does not
create Git branches or alter another worktree. `bin/check --full` includes
configuration and port-conflict regression tests and one complete browser suite;
run the concurrent check after changing browser harness isolation.
The `--warm` option runs each copied suite twice, first with no Next cache,
then with that checkout's cache from the first run. Each run resets its own
database. Successful phase logs are named `browser-fresh.log` and
`browser-warm.log`; a failed phase also writes `browser.log`.

## Fixtures

Feature tests use `tests/browser/member-fixture.ts` to prepare members without
repeating the signup interface. The fixture creates an invited user, runs the
real profile setup, and obtains a signed session from the real auth handler.
Only email delivery is replaced with an in-memory code capture. The browser
and application still use normal sessions and access checks. `member` creates
a mobile browser context; `signIn` prepares the test's existing page.
`prepareFriendship` sends and accepts requests through the authenticated API.
For people a test never signs in as, `person` creates a completed profile
without a session, and `friend` accepts a friendship between two user IDs
through the relationship rules. `userId` reads the user behind a page's
session. Specs import these helpers instead of defining their own copies.

- Every application suite that uses the test database or server modules
  imports [social-fixture.ts](../tests/app/social-fixture.ts) first. Before
  server modules load, the module validates the test database, exported as
  `testDatabaseURL`, and sets authentication configuration. It also clears
  provider settings inherited from the shell: the TMDB token and catalog URL,
  the email transport, Resend key and sender, the Google web and iOS clients,
  the Sign in with Apple settings, and the Sentry DSN. Tests therefore never
  call TMDB, Resend, Google, Apple, or Sentry, even when a developer shell
  exports real credentials. A suite that exercises a provider sets fake values
  after the import and answers with a loopback server or a replaced `fetch`;
  `tests/app/failure-logs.test.ts` runs a loopback Sentry endpoint, and
  [identity-providers.ts](../tests/app/identity-providers.ts) fakes Apple's
  and Google's key, token, and revoke endpoints with keys generated per run.
  `tests/app/social-fixture.test.ts` covers the clearing.
- Suites call `useDatabase()` once at file scope to register the migration,
  per-test user/verification reset, and final pool shutdown. A suite that
  resets other tables imports `db` and registers its own hooks instead. Node
  isolates files in separate processes; keep `--test-concurrency=1` when
  running them together against one database.
- The same helper contains pending/completed members, accepted friendship,
  a signed session cookie for route tests (`cookieFor`), the bearer token a
  native client receives from the same sign-in (`bearerFor`), and a small
  discussion fixture. Feature-specific setup and assertions stay in their
  feature files. No suite imports another test file.
- Authorization tests assert the exact error: status and message for
  Screenr's errors, or status and code for Better Auth's. The helper's
  `denied` lists each access denial, and `assertRouteError` checks a route's
  status and JSON error. A bare rejection, a status alone, or a loose pattern
  such as `/not found/` would also accept a SQL error, another denial, or a
  different 4xx.
- Every browser spec imports `test` from
  [monitored-test.ts](../tests/browser/monitored-test.ts). Its automatic
  per-test fixture resets and checks page and hydration errors in every spec.
  Extra tabs and complete signup pages are monitored explicitly with
  `monitorErrors`. `tests/app/browser-harness.test.ts` fails when a spec takes
  `test` from Playwright, the script guard, or the database or member fixture
  instead ([#154](https://github.com/jubishop/screenr/issues/154)).
- That fixture extends the
  [member fixture](../tests/browser/member-fixture.ts), which owns real signed
  sessions, independent member contexts, cleanup, and member-page error
  checks. Its `watchErrors` holds the one page and hydration error filter that
  both fixtures use. The
  [database fixture](../tests/browser/database-fixture.ts) closes the shared
  pool only at worker shutdown.
- [Journey helpers](../tests/browser/journey-helpers.ts) retain complete
  email signup and browser friendship setup for scenarios that test those
  journeys. [Refresh helpers](../tests/browser/refresh-helpers.ts) wait for
  screen responses. A scenario that waits for the read it starts opens the
  page with polling paused, then returns to the page until it reads once. A
  refresh aborts any read still in flight, and Playwright never finishes a
  response whose request then fails, so waiting for a poll's response could
  hang ([#197](https://github.com/jubishop/screenr/issues/197)). Unchanged
  screen reads answer 304 and render nothing, so scenarios that check what a
  refresh keeps, such as drafts and focus, use `renderRefreshes` to read and
  render the whole screen, as a return to the page in these helpers does.
  A scenario that clicks Try again after a failed read also pauses polling: a
  successful poll could remove the button before the click
  ([#200](https://github.com/jubishop/screenr/issues/200)).
- Scenarios that test polling intervals or request deadlines don't sleep.
  They install and pause Playwright's clock in the member's context, advance
  it explicitly, and hold the timed request in a route until the test
  continues it. The slow and timed-out refresh scenario in `feeds.spec.ts`
  follows this pattern.
- Page loads pass through the offline service worker. A test that intercepts
  page loads needs the context setting described in
  [installation tests](installation.md#tests).

## iPhone API fixtures

The iPhone app's Swift models are tested by decoding checked-in responses
from the real API
([decision](ios-app.md#hand-written-models-checked-against-server-fixtures--2026-10-13)).
`tests/app/ios-fixtures.test.ts` sends each case through the
`/api/screenr/[action]` handler as the app does, with the viewer's
[bearer token](data-and-access.md#native-client-sessions) and no cookie or
`Origin`, and compares the response with its file under
`ios/ScreenrKit/Fixtures/`. It runs in `npm test`, so `bin/check --full` and
CI fail when a response no longer matches its fixture, when a case has no
file, or when a file has no case. The failure shows the changed fields.

On the Swift side, ScreenrKit's `FixtureDecodingTests` decode every file as
the model its action returns, and `RequestTests` check that ScreenrKit
builds the recorded requests. `swift test` and the iOS CI job fail when a
fixture no longer decodes or names an action without a Swift model. UI tests
run the app against the same files through the
[fixture API](../ios/README.md#fixture-api).

After an intended payload change, regenerate the fixtures and commit the
fixture diff with the server change:

```sh
npm run fixtures:ios
```

The command uses the `npm test` database, including `TEST_DATABASE_URL`. It
rewrites the files whose responses changed and removes files without a case.
Run it again, or run `npm test`, and the files stay unchanged.

### Fixture layout

Each file holds one case, named for the state it shows, such as `default`,
`empty`, `full-top-ten`, or `not-found`:

- `screen/<route kind>/<case>.json`: the `screen` action for each route kind
  in `src/member-routes.ts`.
- `actions/<action>/<case>.json`: every other action in
  `src/server/actions.ts`, under its API name.
- `errors/<case>.json`: errors that any action can return, such as a missing
  session. Every error body is `{"error": "<message>"}`.

### Fixture format

Each file is one JSON object, shown here with a shortened body:

```json
{
  "description": "A member with no friends or activity.",
  "viewer": "nora",
  "request": {
    "method": "GET",
    "action": "screen",
    "path": "/api/screenr/screen?path=%2F",
    "query": { "path": "/" }
  },
  "response": {
    "status": 200,
    "etag": "W/\"<version>\"",
    "body": { "kind": "feed", "conversations": [] }
  }
}
```

- `viewer` is the signed-in member's username, or `null` without a session.
- `request` always has `method`, `action`, and `path`. A GET has `query`. A
  POST has its JSON `body`, or `upload` (`contentType` and `bytes`) when the
  body is a file, as for photo uploads. `headers` lists any extra request
  headers, such as `If-None-Match` or `Screenr-Invitation`.
- `response` has the HTTP `status` and the JSON `body`, which is `null` for
  a 304. A GET's `etag` is the version the server computes for that body.

### Fixture data

`tests/app/ios-fixture-world.ts` builds one world through the real services
and the shared test helpers. Alice, the usual viewer, has friends, requests
in both directions, a blocked member, an invitation link that a friend
joined, notifications, saved services, a photo, and a linked Google account.
The entries include an edited spoiler review, season and episode labels,
spoiler and removed replies, a deleted post, a blocked author's reply, and
reactions. Erin has
a full top 10, and Nora has no friends or activity. A loopback TMDB
stand-in serves the titles, trailers, providers, seasons, and episodes, and
a replaced `fetch` stands in for Google's image server. Every person and
title is fictional.

GET cases share the world. Each POST case first restores a saved copy of the
database, so no case sees another's changes.

Volatile values become placeholders, so regenerating without a payload
change produces no diff:

- **Timestamps:** every timestamp becomes one instant in the format the API
  sent: `2026-10-13T12:00:00.000Z` for JavaScript dates, and
  `2026-10-13T12:00:00.000000+00:00` for PostgreSQL JSON timestamps. The app
  must accept both forms. PostgreSQL drops trailing zeros from the fraction,
  and the whole fraction when it is zero.
- **User IDs:** `user-<username>`.
- **UUIDs:** a record the world created keeps one UUID in every fixture,
  derived from a label such as its owner, title, and type. Other UUIDs, such as a record
  that an action creates, become `00000000-0000-4000-8000-000000000001`
  onward within each fixture.
- **Invitation tokens:** 43-character tokens derived from a label.
- **ETags:** recomputed from the fixture body.

Comment and notification IDs are sequence values. The suite resets the
sequences, so they stay stable. Dates without a time, such as finished and
release dates, are fixed in the world.

### Adding a fixture

The case tables in `tests/app/ios-fixtures.test.ts` are keyed by
`MemberRoute["kind"]` and by the `ActionName` type from
`src/server/actions.ts`. A new route kind or action fails
`npm run typecheck` until it has an entry. To add cases:

1. Add the entry under the action's API name in `actions`, or the route kind
   in `screens`, with one case for each state the app must decode. `read`,
   `write`, and `screen` build GET, POST, and screen cases. Pass the
   expected status for an error case. A request or body may be a function of
   the world, to use its IDs or prepare more state.
2. Add any members or records the cases need to `buildWorld`. Its label
   query names the UUIDs of feed entries, comments, posts, conversations,
   and invitations. Extend it when a new table's UUIDs appear in responses.
3. Register every credential, token, or other volatile value that a case
   sends or receives with `world.placeholders.add`, so no live value is
   written. Session cookies are never recorded.
4. Run `npm run fixtures:ios`, review the new files, and commit them with
   the server change.
5. For a new action, add its ScreenrKit request and model, as the
   [ScreenrKit API](../ios/README.md#screenrkit-api) describes, so
   `swift test` decodes the new files.

## Resource ownership

Browser scenarios run in parallel against one database per checkout, so each
shared resource has a fixed owner:

| Resource | Ownership or isolation |
| --- | --- |
| Database, ports, Next output | Each checkout derives its own database and four-port range. Checkout and database locks reject conflicting runs before reset. |
| Users, relationships, sessions | Each test has distinct usernames and user IDs. Member fixtures create real sessions in separate contexts; no test resets the shared browser database. Rows live for one harness run. |
| Invitations | Each test creates its own invitation. No test reads invitation capacity that another test can consume, and there are no shared invitation files. |
| Email and OAuth state | Fixture email codes are local to each member setup. Complete journeys use distinct email addresses and checkout-local captures. The OAuth fixture keys state by generated authorization codes and tokens. |
| Catalog/cache state | Shared title identities and names are stable fixtures. The availability scenario exclusively owns the failure switch and cache-state changes for its reserved title IDs; it restores the switch in `finally`. |
| Browser routes, errors, drafts, screenshots | Routes and drafts belong to a context. Fixture contexts close even on failure. Error lists remain local to a test/worker, and one case runs at a time in each worker. Screenshots have scenario-specific paths; Playwright owns test-specific traces. |
| Database pools | Server modules share a pool only within their worker. The worker fixture closes it after that worker finishes, not after an individual spec. |

Give each test distinct usernames and relationship data. Invitations are
created per test, including for the complete signup and preview journeys;
there are no shared invitation-capacity files. The harness resets its locked
database once before the suite. Tests must not reset it or change another
test's users. Rows remain for that run, contexts close after each test, and
database pools close when their worker finishes. Run repeated measurements as
separate commands so each starts with a reset database.

Repeated passes cannot prove the absence of every race. Future tests must
preserve these ownership rules. Adding a shared mutable fixture or another
reset requires a new isolation review; more retries or weaker assertions are
not substitutes.

## Coverage

Complete signup, Google sign-in, friendship, invitation, and access-restoration
journeys retain browser interaction. Request-only reaction and title-comment
validation is covered through the real HTTP handler in
`tests/app/discussion-api.test.ts`. `tests/app/api-requests.test.ts` covers
the same handler's 16,000-byte body limit, missing or non-object JSON, unknown
actions, and origin and session checks before a body is read.
`tests/app/profile-photos.test.ts` covers photo upload validation, who may
load a photo and its caching headers, automatic Google copies after signup
and after linking, the removed-photo rule, Use my Google photo, and the
backfill. A replaced `fetch` stands in for Google's image servers, so no test
contacts Google. `tests/browser/profile-photos.spec.ts` adds, replaces, and
removes photos at phone and desktop widths. It fits a detailed camera photo
under the upload limit, falls back to a smaller size when no 512-pixel JPEG
fits, and shows the details of each preparation failure. CI's Chromium cannot
reproduce Safari's larger JPEGs; on macOS, add `--browser=webkit` to run the
spec with Apple's JPEG encoder, which Safari also uses.
`tests/app/id-lookups.test.ts` plans the statements sent by thread reads,
replies, reactions, removals, and invitation revocation against a few hundred
analyzed rows per table, with sequential scans disabled, and requires each ID
lookup to use an `id` index. Focus, drafts,
navigation, rendering, spoilers, and visible access changes remain browser
assertions.

The browser-facing port routes application requests to Next and auth requests
to the real auth handlers with a local identity provider. This keeps OAuth redirects, state cookies, PKCE
verification, account linking, and sessions in the browser flow. The provider
supplies test identities; automated tests do not prove Google's availability
or production credentials. The harness also supplies a fictional TMDB catalog
and captures email locally. It does not use paid services or contact real
recipients. A full run checks:

- Four invited members complete email verification and required profiles.
- Completed invited signups create an accepted friendship with the creator.
  Pending signup gives no content access. Members using the same link do not
  automatically become friends with each other. Other friendships need an
  explicit request and acceptance.
- A recommendation appears in the friend's feed and title page, with one
  canonical item per action. Saving a title persists.
- Each feed supports replies, the latest-three preview, and inline expansion.
  Own replies appear immediately. Incoming items and replies wait behind
  **New activity**. Reordering preserves reading position and drafts.
  Spoilers require a reveal; replies survive a reload and targeted links.
- A movie or TV title can receive multiple standalone comments without an
  existing recommendation or watch action. Only title pages have their
  composer. The same entries and replies persist in all three feeds, with
  spoiler protection for the whole discussion and independent reply groups.
  Posting and refresh failures preserve comment drafts.
- A member posts without a title from the Your circle heading row. A friend
  reads, reacts, and replies on the friends feed and profile, and copies its
  `/?item=` link; title pages and nonfriends don't show it. The reply's
  notification opens the friends feed at the reply, and deletion keeps it.
- The fictional catalog's `tv:998020` lists seasons and episodes, so its
  composer offers Season and Episode pickers. Labels stay visible above the
  spoiler cover in all three feeds. Other TV fixtures list no seasons, so
  their comments post without a label.
- A nonfriend cannot read or write through direct API calls or the page.
- Unfriending removes open-page access and hides historical comments for
  remaining readers; refriending restores them.
- A blocked pair cannot see each other in a mutual friend's conversation,
  while the host retains visibility.
- The profile's More actions menu opens and moves by keyboard, closes on
  Escape, focus loss, or an outside click, and Unfriend and Block need the
  in-page confirmation. A confirmed Block opens the Friends page with a
  focused, dismissible notice and never reloads the hidden profile. Pending
  friend-request notifications accept, or decline after confirmation, by
  keyboard.
- Delete and Remove on comments, Decline on the Friends page, and Revoke
  invitation open the in-page confirmation, by keyboard and pointer at phone
  and desktop widths. Cancel keeps the item and returns focus; no browser
  dialog opens and no write is sent until the action is confirmed.
- The Friends page orders its relationship sections and keeps row actions on
  the person's line at phone and desktop widths. Avatars keep their color
  after a rename and show a whole emoji initial.
- Feed, comment, and notification times use the relative format with the
  full local date and time on hover. They hydrate with Safari's date
  punctuation in UTC and Los Angeles. Feed entries show the release year, or
  only the kind without a release date.
- Title pages show compact entries with the copy link ending the author
  line, and Start a conversation on the "Around this title" heading row at
  phone and desktop widths. The friend line follows the header buttons, names
  up to three friends per group, and hides without a friend's action. Each
  name scrolls to and focuses its entry, including one waiting behind New
  activity. `tests/app/title-page.test.ts` covers the line's grouping, order,
  name limit, and friendship and blocking rules.
- While a held navigation, title, or notification link waits for the next
  screen, the current screen stays in place and busy, and the progress bar
  fades in across the top at phone and desktop widths. The next screen's
  focused heading is not busy. Background refreshes show no bar, and reduced
  motion keeps it still.
- The profile top 10 shows a scrolling row of numbered posters beneath the
  header, and its edit mode moves and removes entries with focus following
  them, at phone and desktop widths. Title pages add titles, replace one
  through the full-list prompt, and confirm, like full feed entries, before a
  top 10 title loses its Recommend. Ranks appear beside friends' names in the
  friend line, suggestions, and Friends recommend.
- Search and Watch together rows clamp descriptions to two lines and end in a
  chevron. Watch together prompts a viewer without saved services to save
  them on Account.
- Friends recommend orders and names recommending friends, filters by Movies
  or TV and by My services across tabs, and saves to Want to watch inline and
  from title pages with the `friends_recommend` surface. Its tab survives
  searches, history, and reloads. It hides a title finished on its title
  page; Show finished keeps its state across tabs and starts off after a
  reload. `tests/app/friends-recommend.test.ts` covers the order, top 10
  weights, the current-friend audience, which actions count, the viewer's own
  status, the response fields, and which titles the Finished filter hides,
  with its empty messages.
- Invitations can be created and revoked.
- In both the light and dark color schemes, every visible text meets 4.5:1
  and only theme colors are painted. This covers sign-in, setup, credits,
  the privacy policy, and member pages with feeds, menus, notifications, and
  confirmations at phone and desktop widths, and the offline page at phone
  width.
  `tests/app/theme.test.ts` checks that stylesheets use only theme values,
  that each light value has a dark one, and the contrast of their pairings.
- A failed feed entry, comment, title header, Friends row, profile,
  confirmation, invitation, or sign-out action shows its error beneath that
  control at phone and desktop widths. The error describes the control, other
  controls stay usable, and no page-level alert appears.
- Pending feed entry, title header, Post, profile, confirmation, Friends row,
  notification, invitation, and Account actions keep keyboard focus, and
  repeated presses send no second request. Focus then stays on the control
  or moves to its replacement or result. Feed, title, Post, and profile
  actions are checked at phone and desktop widths.
- Cookie-free preview requests follow invitation redirects and receive metadata
  in the HTML head for mobile, desktop, and social crawler user agents. The
  public PNG is reachable and has the declared dimensions. Preview requests
  preserve invitation usage and the recipient's signup cookie.
- Google signup shows an existing connection and removes the connect button.
  A wrong email code is rejected; a valid code returns to the same profile.
- An email-created account can recover from a provider request failure,
  canceled consent, and a mismatched Google email. Error messages survive the
  account refresh. Successful linking persists after reload, and subsequent
  Google sign-in returns to the existing profile.
- A limited code request shows the limit message and allows retry.
- Failed sign-out and Google sign-in requests show an error and allow retry.
  A pending member can finish signup through a replacement invitation.
- A signed-out visitor to a title reply link returns to that reply after an
  email code at phone width, after a canceled Google attempt, and after the
  session ends during a refresh. An invited Google signup at desktop width
  returns there after setup. External return paths lead to the friends feed.
- Stalled email code, Google link, and sign-out requests time out after
  fifteen seconds with a retry message and re-enable their controls.
- Reply drafts survive failed refreshes and typing during a pending post.
  Refresh failures hide server content until access is checked again;
  unrelated refreshes do not clear action errors.
- Slow refreshes still deliver new replies and revoke access. A refresh that
  exceeds ten seconds hides server content; later recovery retains the draft.
- Unchanged screen refreshes answer 304 without a body and commit no React
  render, counted through a stub DevTools hook, so reply drafts stay put.
  The page load isn't read again. Changes still arrive, and relative times
  advance each minute. `tests/app/screen-refresh.test.ts` covers every
  screen kind, the page's first version, each visible change, and versions
  sent by other members or for unreadable screens.
- The open notification panel reads once when the page becomes visible and
  not on focus. Its unchanged polls answer 304 without a body and commit no
  render; arrivals still appear, and Mark all as read sends the shown page's
  boundary. `tests/app/notifications.test.ts` covers versions for the latest
  and older pages, arrivals that keep an older page's boundary, and reads.
- Missing titles, people, and pages respond 404 with the member's navigation
  and the reason, through page loads and client navigation. Polling continues
  through 503 refreshes and stops after a permanent error until the reader
  tries again or returns to the page. The catalog fixture has no title
  `movie:987690`.
- Circle and profile feed cards and the title header switch the viewer
  between Want to watch and Recommend. Selecting either clears the other;
  selecting the active action clears it. The inline Recommend action follows
  Want to watch on other people's entries. Both controls show the viewer's
  current state, including after reload. Clearing the last
  activity flag hides an empty card, while visible comments keep its thread
  listed. Restoring either action reuses its original entry and replies.
- The title page's status menu sets, dates, and clears statuses by pointer
  and keyboard, lists Caught up only for TV shows, and stays on screen at
  phone and desktop widths. A friend sees one progress entry, saves its title
  with one tap, and then sees their own status as a link. Clearing keeps an
  entry with replies, marked as removed.
- The title page's review form rates by pointer and keyboard, saves text, and
  fits phone and desktop widths. A failed save keeps the draft. A friend reads
  the review in the friends, profile, and title feeds, replies, and reacts, and
  the comment notification opens the review. Edits update the same entry with
  an Edited label; a spoiler flag hides the text and discussion but not the
  stars. Removal asks first and keeps an entry with replies.

Database tests additionally cover concurrent signup limits, rollback after
username conflicts, expiry, code/account identity, explicit Google and Apple
linking, native Apple and Google ID-token sign-in with Apple token revocation,
one-level reply grouping, host removal, and encrypted email delivery retries.
They verify automatic inviter friendships for email and Google signup, legacy
links, and replacement invitations. Retrying setup does not consume another
use or restore a friendship after unfriending or blocking. Invites refreshes
don't wait for the shared write lock, and writes stop waiting for it with a
retryable error. Watch status tests cover each status and transition, its
interplay with Recommend and Want to watch, the progress entry lifecycle,
date validation, audience and blocking, notifications, and migration 018
with the previous release's writes. Review tests cover validation, edits,
removal and reuse, reactions on removed reviews, audience and blocking,
notifications, the conversation measure, and migration 022 with the previous
release's writes. Discussion post tests cover posts without a title through
the same audience, reply, reaction, removal, notification, link, and usage
rules, label validation and TMDB season lists, and migration 024 with the
previous release's writes.
`tests/app/failure-logs.test.ts` and `tests/app/email.test.ts` capture the
[failure logs](deployment.md#failure-logs) of request, page, worker, and
Resend failures. They compare the logged fields exactly, check that comment
text, search terms, addresses, codes, cookies, keys, and error messages stay
out, and confirm that permanent Resend rejections are not retried.
`tests/app/email.test.ts` also runs `scripts/worker.ts` with fetch disabled. The
worker refuses to start without the Resend settings, deletes expired jobs on its
first pass, and exits cleanly on SIGTERM.
Operational tests check activation rollback after a stalled health request, a
failed signed-out session request, or a web or worker service that crashes on
startup. They also check a production-down report when the restored release
also fails its checks, and rejection of incorrectly named SQL migrations before
schema changes begin. A failed configuration check or migration stops
activation before the release link switches. The restore check fails, and drops
any temporary database, when restic cannot check or read the backup,
`pg_restore` fails, the restore has no profiles, or its access query fails.
Release packaging runs only in Linux CI, so
`tests/app/release-package.test.ts` checks locally that the package includes
every module its maintenance scripts load
([#201](https://github.com/jubishop/screenr/issues/201)). It parses the
scripts production runs from the release (`validate-config`, `migrate`,
`worker`, `bootstrap`, `report-usage`, and `seed-review` in `scripts/`) with TypeScript's
parser and follows their `import`, `export … from`, and literal `import()`
specifiers, including extensionless and index paths. It skips `import type`,
`export type`, comments, and strings. It fails when a reached local module is
outside the paths in `scripts/release-paths.ts`, which `scripts/package.ts`
copies. It also fails on an unresolved import, a computed `import()`, a
package outside the production dependencies, or a script that `ops/` runs
but the test does not list.
An authentication test confirms that a Better Auth schema mismatch fails that
session request.
The proxy test runs the production Caddy routes on loopback with a temporary
certificate and a fixture upstream that sends the app's security headers from
`next.config.ts` and `src/proxy.ts`. It verifies the `screenr.club` site,
client IP forwarding, that each security header reaches the client exactly
once, and old invitation/title redirects with their paths and queries intact.
Run it alone with `node --import tsx --test tests/app/proxy.test.ts`. It does not verify public DNS,
Cloudflare certificates, or real provider configuration. Locally it uses any
installed Caddy. In CI it also requires `caddy version` to report the release
pinned to match production; see [CI Caddy](development-workflow.md#ci-caddy).
The browser test writes mobile and desktop screenshots to `.cache/` and
keeps failure traces in `test-results/`.

### Line and branch coverage

Measure how much of `src/` the application tests exercise:

```sh
npm run test:coverage
npm run test:coverage -- tests/app/catalog.test.ts
```

The command prepares the test database like `npm test`, honors
`TEST_DATABASE_URL`, and runs every application test serially, or only the
named files. Node's built-in test coverage then prints line, branch, and
function percentages and uncovered line numbers for each `src/` file those
tests load. A failing test fails the command. It sets no thresholds and is
opt-in: `bin/check --full` and CI do not run it. Use it to find untested paths
before writing tests. `tests/app/test-coverage.test.ts` covers its scope and
exit status; [#156](https://github.com/jubishop/screenr/issues/156) added it.

The report reflects application tests only. Files that no application test
loads, such as pages and most components that the browser suite exercises,
do not appear. Browser runs and `scripts/` are not measured. Source maps
translate tsx's compiled output back to TypeScript lines, so the uncovered
column can also list a few nonexecutable lines, such as leading comments,
imports, or exported function declarations. Check listed lines against the
source.

## Security policy reports

Browser tests run under the production security headers from the
[deployment decision](deployment.md#provisioning). The shared fixture in
`scripts/browser-test.ts` fails a test when any of its browser contexts
reports a `Content-Security-Policy` violation, a feature blocked by the
permissions policy, or a `Permissions-Policy` header error, and lists each
report. A new cross-origin image, frame, or script, or a newly used browser
feature, therefore needs a policy change. `tests/app/browser-script-guard.test.ts`
covers these reports.

`tests/browser/security-headers.spec.ts` checks the exact headers on pages,
redirects, API responses, and static files. The public pages `/login`,
`/credits`, and `/privacy` answer 200 to a signed-out request, with no
sign-in redirect. Every script a page renders
carries that response's new nonce, even when the request supplies its own
policy, and the browser reports unused features as denied.
`tests/app/content-security-policy.test.ts` covers the nonce and the
development-only `'unsafe-eval'`. The trailer test checks that the open
player keeps its delegated features.

## Failed script loads

The shared fixture in `scripts/browser-test.ts` monitors essential local script
loads in default and manually created browser contexts. A failed transport or
HTTP error on a GET for `/_next/static/*.js` closes the test's contexts, with
the browser error and script path as the reason. Browser actions stop promptly
instead of waiting for an unrelated disabled control, and the test fails with
that error even if it catches the interrupted action. Playwright keeps the
failure trace in `test-results/`, which CI uploads as its failure artifact.
Ordinary navigation cancellations and context cleanup are excluded. API and
third-party failures are outside this guard. A test that deliberately fails a
script must list its exact path in `expectedScriptFailures`; there is no
suite-wide retry or blanket failure suppression.
`tests/app/browser-script-guard.test.ts` covers these cases.

**Outcome:** [#69](https://github.com/jubishop/screenr/issues/69) added
permanent reports for intermittent `net::ERR_INVALID_HTTP_RESPONSE` script
failures under development serving. While
[#83](https://github.com/jubishop/screenr/issues/83) was open, PR #85 added this
guard and a proxy capture of each script's original transport. #83 then traced
a captured recurrence to an IPv6 self-connection
([correction evidence](https://github.com/jubishop/screenr/issues/83#issuecomment-5610397464)):
the harness advertised `localhost` while listening only on IPv4, so Chromium
could connect to its own socket and read its own request as an invalid
response. The harness now advertises `127.0.0.1`, and
`tests/app/browser-harness.test.ts` covers that boundary. The correction did
not establish the cause of every earlier report.
[#84](https://github.com/jubishop/screenr/issues/84) later made production
builds the default serving mode; see the archived
[serving-mode evaluation](archive/browser-production.md).
[#157](https://github.com/jubishop/screenr/issues/157) retired the reports and
the transport capture and kept the guard. Local `.cache/browser-failures/`
directories from earlier runs can be deleted.

**Decision — 2026-10-12:** Keep the prompt-failure guard in
`scripts/browser-test.ts`, which fails a test as soon as an essential local
script fails to load. Retire the transport capture: the proxy socket ring,
the original-transport snapshot, comparison probes, `script-diagnostics.json`
reports, the `.cache/browser-failures/` archive, and their tests.
Implemented in [#157](https://github.com/jubishop/screenr/issues/157). This
supersedes the 2026-09-08 decision to keep these diagnostics permanently for
#69, and the 2026-09-09 decision to run the capture in ordinary browser runs
through PR #85 while #83 stayed open.

**Why:** #83 closed after its IPv6 self-connection correction, and browser
tests now default to production serving. The guard still prevents hung tests
and keeps the browser error and trace, while the capture added socket
wrapping to every run for a fault that no longer occurs. Git history retains
the recorder if the failure returns.

**Rejected alternatives:** Keeping the full recorder as insurance, and
removing the guard as well.
