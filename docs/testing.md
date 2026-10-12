---
status: current
---

# Testing Screenr

This guide covers the test commands, the browser harness, shared fixtures,
resource ownership rules, coverage, and browser failure diagnostics. Complete
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
and email service credentials. No production service or private dotenv file is
needed. Keep credentials out of `NEXT_PUBLIC_*` and Next's `env` configuration;
those values are included in browser bundles. Normal server configuration stays
runtime configuration. The auth fixture remains a separate process running the
real auth handlers with a local Google provider and file email capture. Next's
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

- Every application suite that uses the test database or server modules
  imports [social-fixture.ts](../tests/app/social-fixture.ts) first. Before
  server modules load, the module validates the test database, exported as
  `testDatabaseURL`, and sets authentication configuration. It also clears
  provider settings inherited from the shell: the TMDB token and catalog URL,
  the email transport, Resend key and sender, and the Google client. Tests
  therefore never call TMDB, Resend, or Google, even when a developer shell
  exports real credentials. A suite that exercises a provider sets fake values
  after the import and answers with a loopback server or a replaced `fetch`.
  `tests/app/social-fixture.test.ts` covers the clearing.
- Suites call `useDatabase()` once at file scope to register the migration,
  per-test user/verification reset, and final pool shutdown. A suite that
  resets other tables imports `db` and registers its own hooks instead. Node
  isolates files in separate processes; keep `--test-concurrency=1` when
  running them together against one database.
- The same helper contains pending/completed members, accepted friendship,
  a signed session cookie for route tests (`cookieFor`), and a small
  discussion fixture. Feature-specific setup and assertions stay in their
  feature files. No suite imports another test file.
- Authorization tests assert the exact error: status and message for
  Screenr's errors, or status and code for Better Auth's. The helper's
  `denied` lists each access denial, and `assertRouteError` checks a route's
  status and JSON error. A bare rejection, a status alone, or a loose pattern
  such as `/not found/` would also accept a SQL error, another denial, or a
  different 4xx.
- Browser suites that import `test` from
  [monitored-test.ts](../tests/browser/monitored-test.ts) get its automatic
  per-test fixture, which resets and checks page and hydration errors in every
  spec. Extra tabs and complete signup pages are monitored explicitly.
- That fixture extends the
  [member fixture](../tests/browser/member-fixture.ts), which owns real signed
  sessions, independent member contexts, cleanup, and member-page error
  checks. The [database fixture](../tests/browser/database-fixture.ts) closes
  the shared pool only at worker shutdown.
- [Journey helpers](../tests/browser/journey-helpers.ts) retain complete
  email signup and browser friendship setup for scenarios that test those
  journeys. [Refresh helpers](../tests/browser/refresh-helpers.ts) wait for
  screen responses.
- Scenarios that test polling intervals or request deadlines don't sleep.
  They install and pause Playwright's clock in the member's context, advance
  it explicitly, and hold the timed request in a route until the test
  continues it. The slow and timed-out refresh scenario in `feeds.spec.ts`
  follows this pattern.
- Page loads pass through the offline service worker. A test that intercepts
  page loads needs the context setting described in
  [installation tests](installation.md#tests).

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
actions, and origin and session checks before a body is read. Focus, drafts,
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
- A nonfriend cannot read or write through direct API calls or the page.
- Unfriending removes open-page access and hides historical comments for
  remaining readers; refriending restores them.
- A blocked pair cannot see each other in a mutual friend's conversation,
  while the host retains visibility.
- The profile's More actions menu opens and moves by keyboard, closes on
  Escape, focus loss, or an outside click, and Unfriend and Block need the
  in-page confirmation. Pending friend-request notifications accept, or
  decline after confirmation, by keyboard.
- The Friends page orders its relationship sections and keeps row actions on
  the person's line at phone and desktop widths. Avatars keep their color
  after a rename and show a whole emoji initial.
- Feed, comment, and notification times use the relative format with the
  full local date and time on hover. They hydrate with Safari's date
  punctuation in UTC and Los Angeles. Feed entries show the release year, or
  only the kind without a release date.
- Search and Watch together rows clamp descriptions to two lines and end in a
  chevron. Watch together prompts a viewer without saved services to save
  them on Account.
- Invitations can be created and revoked.
- A failed feed entry, comment, title header, Friends row, profile,
  confirmation, invitation, or sign-out action shows its error beneath that
  control at phone and desktop widths. The error describes the control, other
  controls stay usable, and no page-level alert appears.
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
- Reply drafts survive failed refreshes and typing during a pending post.
  Refresh failures hide server content until access is checked again;
  unrelated refreshes do not clear action errors.
- Slow refreshes still deliver new replies and revoke access. A refresh that
  exceeds ten seconds hides server content; later recovery retains the draft.
- Circle, profile, and title feed cards switch the viewer between Want to watch
  and Recommend. Selecting either clears the other; selecting the active
  action clears it. The inline Recommend action follows
  Want to watch on other people's entries. Both controls show the viewer's
  current state, including after reload. Clearing the last
  activity flag hides an empty card, while visible comments keep its thread
  listed. Restoring either action reuses its original entry and replies.

Database tests additionally cover concurrent signup limits, rollback after
username conflicts, expiry, code/account identity, explicit Google linking,
one-level reply grouping, host removal, and encrypted email delivery retries.
They verify automatic inviter friendships for email and Google signup, legacy
links, and replacement invitations. Retrying setup does not consume another
use or restore a friendship after unfriending or blocking. Invites refreshes
don't wait for the shared write lock, and writes stop waiting for it with a
retryable error.
Operational tests check activation rollback after a stalled health request, a
failed signed-out session request, or a web or worker service that crashes on
startup. They also check a production-down report when the restored release
also fails its checks, and rejection of incorrectly named SQL migrations before
schema changes begin. An authentication test confirms that a Better Auth schema
mismatch fails that session request.
The proxy test runs the production Caddy routes on loopback with a temporary
certificate and a fixture upstream. It verifies the `screenr.club` site, client IP
forwarding, security headers, and old invitation/title redirects with their
paths and queries intact. Run it alone with
`node --import tsx --test tests/app/proxy.test.ts`. It does not verify public DNS,
Cloudflare certificates, or real provider configuration.
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
