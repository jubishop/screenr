---
status: current
---

# Running Screenr

This guide covers local setup, provider configuration, verification, and the
running app's data and access rules. The
[README](../README.md#what-screenr-does-today) summarizes what Screenr does
today and links the features that are not built yet.

## Local setup

Use the latest Node.js LTS release, npm, Python 3.9+, ShellCheck, Caddy,
OpenSSL, and a Docker-compatible engine. Caddy and OpenSSL are used by the local proxy test;
do not start a system Caddy service. On macOS, install the test tools with
`brew install caddy openssl`; the existing Colima installation can provide Docker.
To run several checkouts at once, give each its own database and development
port as described in [several checkouts at once](#several-checkouts-at-once).
QMD setup is described in the [development workflow](development-workflow.md).

Select the latest Node LTS release in your shell before running `npm ci` or
application commands. Use its bundled npm or a newer compatible npm that
supports [`devEngines`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#devengines).
The package policy rejects Node versions below 24 before installation or script
execution. `bin/check --full` also checks Node before running behavior tests.
Fast and document-only checks do not need Node. See the
[runtime decision](development-workflow.md#node-runtime) for upgrade policy.

```sh
bin/setup
npm ci
docker compose up -d --wait
cp .env.example .env
chmod 600 .env
openssl rand -base64 32
```

Put the generated random value in `BETTER_AUTH_SECRET` in `.env`. Keep that
file private. Set `TMDB_READ_TOKEN` to the API Read Access Token from TMDB's
account API settings. `EMAIL_TRANSPORT=file` captures development codes
locally and sends no email. Keep the tracked `.env.example` complete when
adding or renaming configuration: include placeholders for authentication,
Google, TMDB, Resend, and backup settings, with no real secrets. Backup
placeholders are optional for local development; the VPS backup jobs use the
separate file described in [deployment](deployment.md#encrypted-backups-and-restore-check).
Then run:

```sh
npm run db:migrate
npm run bootstrap
npm run dev
```

Open the invitation URL printed by `bootstrap`. It permits one completed
signup and expires after 30 days. It has no inviter and does not create a
friendship. Keep the link private. Repeat bootstrap only when another
administrative invitation is needed; members can create ordinary invitations
in the app.

The invitation page shows active links with copy and share controls. Links
remain available after reload; revoked, expired, and fully used invitations
disappear on the next refresh. Their database records remain intact.

Shared invitation URLs redirect to the login page, which provides a generic
Screenr title, description, and public PNG through Open Graph and Twitter card
metadata. Preview clients can read these tags in the initial HTML without
JavaScript or cookies. In production, the image URL uses `BETTER_AUTH_URL`.
The preview does not include invitation tokens or member details. Fetching a
preview does not consume an invitation. This follows Apple's
[Messages preview guidance](https://developer.apple.com/documentation/technotes/tn3156-create-rich-previews-for-messages),
including support for server redirects. After deployment, share a fresh invite
in Messages to check its presentation; an existing message may retain an older
preview.

Migration `004-invitation-links.sql` adds an optional second token hash. Old
invitations stored only a one-way hash, so their original URLs cannot be
recovered. When the creator views an active old invitation, Screenr adds a
stable share URL for that same invitation. Both URLs use the same signup limit,
expiry, and revocation state; previously shared URLs and pending signups keep
working. New invitations use their original URL in the list.

Share tokens use HMAC-SHA-256 with `BETTER_AUTH_SECRET` and an
invitation-specific input. The database stores hashes, not reusable tokens.
Keep this secret stable across releases. Rotating it changes the displayed
URLs on the next invitation-page refresh and replaces any previous secondary
URL; the original creation URLs retain their normal lifetime. No additional
secret or manual backfill is required.

After requesting an email code in the browser, read it with:

```sh
npm run dev:code -- you@example.test
```

Complete the display name and username. Create another invitation from
**Invite friends**, and open it in a separate browser profile for a second
member. Completing signup automatically makes the new member and inviter
accepted friends. Find a movie or show, recommend it, and open its conversation
from the other member's feed.
Save it as Want to watch and post a reply inline. The title page, friends
feed, and profile show the same item and its replies. Recommend and Want to
watch each have a separate discussion.

The code capture files are private, ignored files under `.cache/mail`.
Production explicitly rejects this transport. Restart Next after changing
provider credentials. The local catalog needs a real TMDB token; automated
tests use a fictional catalog served only on loopback.

### Several checkouts at once

Checkouts that run the app at the same time each need their own development
database, test database, and development port. The browser harness already
derives its own ports and database from the checkout path; see
[Verification](#verification).

The simplest setup shares one PostgreSQL server. Start it from one checkout
only: Compose names its project after the checkout directory, so
`docker compose up` in another worktree tries to start a second container on
the same host port and fails. `npm run db:migrate` does not create databases,
so create one for each additional checkout from the checkout that started
PostgreSQL:

```sh
docker compose exec postgres createdb -U screenr screenr_feature
```

In the additional checkout, set `DATABASE_URL` in `.env` to
`postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_feature`.
Test commands do not read `.env`, so export a separate test database in that
checkout's shell. They create the database if needed and reset it; its name
must end in `_test`:

```sh
export TEST_DATABASE_URL=postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_feature_test
```

To give a checkout its own server instead, set `SCREENR_DB_PORT` to a free
port in that checkout's `.env`. Docker Compose reads it from that file, and a
shell variable of the same name takes precedence. Use the same port in
`DATABASE_URL` and `TEST_DATABASE_URL`. `docker compose up -d --wait` then
starts a separate container, with its own data volume, on that port. Without
the setting, Compose uses 5439, which `.env.example` also uses.

```sh
SCREENR_DB_PORT=5440
DATABASE_URL=postgresql://screenr:screenr-local-only@127.0.0.1:5440/screenr
```

The development server uses port 3000 unless you pass another one. Match it
in that checkout's `BETTER_AUTH_URL`, such as `http://localhost:3001`, and
open that URL:

```sh
npm run dev -- --port 3001
```

Sign-in and member actions reject requests from any other origin, and
bootstrap and invitation links use `BETTER_AUTH_URL`. The registered local
Google callback uses port 3000, so use email codes on other ports, or leave
the Google credentials empty to hide Google sign-in. Each checkout captures
codes in its own `.cache/mail`; run `npm run dev:code` in that checkout.

### Email worker

Production runs `scripts/worker.ts` as `screenr-worker.service`. It sends
queued sign-in codes and grouped activity emails through Resend, retries
failed sends, and deletes expired jobs. Local development does not need it.
With `EMAIL_TRANSPORT=file`, Next writes sign-in codes directly to
`.cache/mail` without queueing them, and `npm run worker` refuses to start
unless `EMAIL_TRANSPORT=resend`, `RESEND_API_KEY`, and `EMAIL_FROM` are set.

Locally, the activity email setting and notifications work, but no activity
email is sent. `tests/app/email.test.ts` and
`tests/app/notification-email.test.ts` cover worker delivery with the Resend
request replaced. A local worker with the real Resend key would send real
email and use the shared Resend free allowance. Switching Next to the
`resend` transport also queues codes for the worker, so `npm run dev:code`
no longer finds them.

### Production build

There is no `npm start` script. `next start` does not support the
`standalone` output set in `next.config.ts`: Next warns and points to the
generated `server.js` instead. Production, release packaging, and
`npm run test:browser` all run that server. To run it locally, use the port in
`BETTER_AUTH_URL`:

```sh
npm run build
cp -R public .next/standalone/
cp -R .next/static .next/standalone/.next/
PORT=3000 HOSTNAME=127.0.0.1 node .next/standalone/server.js
```

The standalone output omits `public/` and `.next/static/`, so copy them after
each build. Without `HOSTNAME`, the server listens on every interface. It runs
in production mode from `.next/standalone` and reads the copy of `.env` that
the build placed there; rebuild after changing `.env`, or set variables in the
shell, which take precedence. Production mode rejects the file transport, so
email-code sign-in reports success but writes no code. Use this server to
inspect the production artifact. `npm run test:browser` exercises sign-in and
the complete app against the same artifact with local fixtures. Do not build
in a checkout while its browser suite owns `.next/`.

## Provider configuration

Use Google Cloud project `screenr-69420` for Screenr's Google sign-in
credentials. The user created this dedicated project on 2026-09-06 to keep
Screenr's sign-in configuration separate from other projects. Hosting remains
on the existing Hetzner VPS.

Google's OAuth client must be a **Web application**. Configure these exact
authorized redirect URIs for the environments used:

```text
http://localhost:3000/api/auth/callback/google
https://screenr.club/api/auth/callback/google
```

For production, set `BETTER_AUTH_URL=https://screenr.club` in the private
server environment. The old `https://screenr.jubishop.com/api/auth/callback/google`
registration stays in place but is unused: the old host
[redirects](deployment.md#old-hostname-redirect) before requests reach Screenr.
Google's callback must match the registered URL exactly; see its
[redirect URI requirements](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred).

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the server. Google sign-in
appears when configured. An account created through Google can later use an
email code. An account created through email must sign in first and select
**Connect Google** in Account. Linking requires a verified matching email and
an existing Screenr session; a matching provider email alone cannot attach
an identity. Verify Google's consent flow with the actual OAuth client in each
deployed environment. Automated tests replace Google's external identity
response while retaining the real auth library, hooks, sessions and database.
Account shows **Google connected** after signup or linking. A connected account
can also sign in with an email code. Connection failures and canceled consent
show a message that remains visible while the account page refreshes.

For production email, use `EMAIL_TRANSPORT=resend`, the existing sending-only
`RESEND_API_KEY`, and an `EMAIL_FROM` address under a verified Resend domain.
The sending-only key can send mail but cannot list or configure domains.
Do not replace a working key because a management endpoint rejects its scope.
The existing account accepted a provider test message from
`Screenr <screenr@jubishop.com>` on 2026-09-05. Screenr keeps that verified
sender on `screenr.club`; the website domain does not require a matching sender
domain or new sender DNS. Verify actual inbox delivery before opening signup.
No paid-plan upgrade is part of this deployment.

The email worker stores encrypted, expiring jobs in PostgreSQL. Failed sends
retry with the same Resend idempotency key. Requesting a new code replaces an
older pending retry for that address and verification type, with a new key.
Successful sends clear their
payload. Expired jobs are discarded. Unknown addresses without a valid invite
do not queue email.

Screenr applies the
[login-code limits](product-brief.md#sign-in-methods--2026-09-05) over rolling
windows: 3 requests per address in 15 minutes, 10 per address in a day, and 40
code emails across Screenr in a day. The per-address limits count every
request, including those that send nothing, so a limited response does not
reveal membership. Requests that send nothing do not use the Screenr-wide
allowance. Better Auth separately allows 3 code requests per IP each minute
and five attempts per code. A limited request leaves the last delivered code
usable, and the sign-in page shows "Too many codes requested. Try again later,
or continue with Google." Migration `011-login-code-limits.sql` stores hashed
recipients for a day. Because Screenr has no passwords, it sends no
password-reset codes, and Better Auth's password routes, such as
`/api/auth/email-otp/reset-password`, return 404. The shared Resend free
allowance can still be exhausted by other applications; inspect Resend
delivery activity if codes do not arrive.

### Notifications and activity email

The bell beside the logo shows the current unread count. It opens an anchored
dropdown on desktop and a full-screen panel on phones. Close or Escape returns
to the underlying page without losing its scroll position or comment drafts.
The panel has All and Unread filters and controls for earlier notifications.
Opening it does not mark notifications read. Selecting a notification marks
it read and opens its person or exact title reply. **Mark all as read** applies
through the newest notification in the displayed snapshot, leaving later
arrivals unread. Older pages and their refreshes keep that boundary; returning
to **Latest notifications** displays new arrivals and updates the boundary.

Migration `010-notifications.sql` creates notification records and transaction
triggers for friendship and comment events. It seeds existing pending friend
requests without sending email. It does not backfill old comments or accepted
friendships. Invited signup creates one new-friend notification for the inviter.
Comments notify their content owner and addressed commenter, excluding the
actor and duplicate recipients. Notifications use current names and access;
they contain no comment text. Withdrawn requests and deleted or inaccessible
comments disappear from lists and counts. Restoring comment access preserves
the notification's read state.

Members enable **Email me about new activity** in Account. The setting is off
by default. Only events created while it is on enter the email queue. After
the first pending event is 10 minutes old, the existing worker groups pending
events into one job. It sends only events still unread and accessible, using
the member's verified email address. Turning the setting off cancels queued
and unqueued activity emails; turning it back on does not send an old backlog.

Activity jobs store notification references, with message text generated from
current data immediately before each send. Each job keeps its original event
membership during retries. Identical retries reuse a provider idempotency key;
changes in visible content use a new key. As with any ambiguous network failure,
provider acceptance cannot always be determined locally. The worker serializes
delivery with access, preference, and read changes and prioritizes sign-in codes.
Activity jobs expire after 24 hours; their notifications remain in the app.
The current worker and Resend configuration need no new service or credentials.

## Verification

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

Feature tests use `tests/browser/member-fixture.ts` to prepare members without
repeating the signup interface. The fixture creates an invited user, runs the
real profile setup, and obtains a signed session from the real auth handler.
Only email delivery is replaced with an in-memory code capture. The browser
and application still use normal sessions and access checks. `member` creates
a mobile browser context; `signIn` prepares the test's existing page.
`prepareFriendship` sends and accepts requests through the authenticated API.

Give each test distinct usernames and relationship data. Invitations are
created per test, including for the complete signup and preview journeys;
there are no shared invitation-capacity files. The harness resets its locked
database once before the suite. Tests must not reset it or change another
test's users. Rows remain for that run, contexts close after each test, and
database pools close when their worker finishes. Run repeated measurements as
separate commands so each starts with a reset database.

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
production pages and API handlers read the same real signed sessions.

`SCREENR_BROWSER_TEST=1` permits the catalog fixture in production mode only
with a loopback browser database, a loopback auth origin, and a loopback catalog
URL. The database must be named `screenr_browser_<name>_test` with no connection
query parameters. This opt-in is set only on harness child processes, not in
Next's compiled configuration or deployment settings. File email capture remains
disabled in the production application; the separate auth fixture owns it.

The default browser command runs independent scenarios with two workers.
Use `npm run test:browser -- --workers=1` for serial execution. The
[runtime measurement report](research/browser-runtime.md) records the speed
comparison, retained coverage, and shared-resource audit.

Every browser run, including CI and local full checks, rejects `test.only`
and `test.describe.only` through Playwright's `forbidOnly` setting. A focused
test therefore fails the gate instead of passing after running only part of
the suite. Focus a local run with a spec path, `path:line`, or `--grep`, for
example `npm run test:browser -- tests/browser/feeds.spec.ts`.
`tests/app/browser-harness.test.ts` covers the rejection. Application tests
need no equivalent setting: `node:test` ignores `only` unless `--test-only`
is passed, and `npm test` does not pass it.

Complete signup, Google sign-in, friendship, invitation, and access-restoration
journeys retain browser interaction. Request-only reaction and title-comment
validation is covered through the real HTTP handler in
`tests/app/discussion-api.test.ts`. Focus, drafts, navigation, rendering,
spoilers, and visible access changes remain browser assertions.

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
- Invitations can be created and revoked.
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
use or restore a friendship after unfriending or blocking.
Operational tests check activation rollback after a stalled health request and
rejection of incorrectly named SQL migrations before schema changes begin.
The proxy test runs the production Caddy routes on loopback with a temporary
certificate and a fixture upstream. It verifies the `screenr.club` site, client IP
forwarding, security headers, and old invitation/title redirects with their
paths and queries intact. Run it alone with
`node --import tsx --test tests/app/proxy.test.ts`. It does not verify public DNS,
Cloudflare certificates, or real provider configuration.
The browser test writes mobile and desktop screenshots to `.cache/` and
keeps failure traces in `test-results/`.

### Failed development scripts

The shared fixture in `scripts/browser-test.ts` monitors essential local script
loads in default and manually created browser contexts. A failed transport or
HTTP error on a GET for `/_next/static/*.js` records the original error and
request timestamp, saves `script-failure.json`, then closes the test's contexts
with that error as the reason. Browser actions stop promptly instead of waiting
for an unrelated disabled control. The fixture also fails if the test catches
the interrupted action. Ordinary navigation cancellations and context cleanup
are excluded. API and third-party failures are outside this guard. A test that
deliberately fails a script must list its exact path in `expectedScriptFailures`;
there is no suite-wide retry or blanket failure suppression.

The fixture proxy continuously observes the original upstream socket reads and
downstream socket writes for these scripts. It retains a ring of 128 exchanges,
with a 4 KiB prefix on each side. At most 128 exchanges can be captured in flight;
additional requests are counted as omitted. Serialized reports contain status
lines, selected headers (including duplicate framing headers), byte counts,
parser error codes and offsets, connection ports, timestamps, and completion
events. Response bodies and request headers are excluded. The downstream finish
event means Node completed its writes; it does not prove Chromium received or
accepted them. The browser error and trace provide that separate observation.

The guard snapshots this ring at the first definitive failure. Match the
browser's path and request start time to the proxy exchange ID, timestamps, and
connection ports. The snapshot's `omitted` count, ring limit, and prefix limit
make capture gaps explicit. Records can be evicted before a delayed failure;
the capture is not a packet trace and cannot diagnose bytes beyond the prefix
or prove kernel-level delivery. A missing response or missing record must not
be treated as proof that Next or the proxy succeeded.

Failed browser tests also retain `script-diagnostics.json` beside their trace.
The reporter reads failed local `/_next/static/*.js` requests from every traced
context, including contexts created manually. It records the original browser
error, HTTP status and selected response headers, plus Node, Next, Playwright,
platform, and port metadata.
It includes the guard's original transport snapshot. When the guard has no
snapshot, the reporter reads the current proxy ring and marks unavailable
capture explicitly. The reporter waits for pending collection before exiting.
For up to five distinct paths, it makes one later GET through the fixture proxy
and one directly to Next. These probes preserve the status line, selected
headers, byte count, and timeout or connection error. Duplicate framing headers
are retained. Each probe stops after two seconds or 4 KiB. All probes run
concurrently; the comparison subprocess has a ten-second outer limit. Reading
the original proxy ring has a separate two-second, 2 MiB limit and does not
follow redirects. Waiting for the archive lock is limited to two seconds.

Comparison requests are later observations. They cannot replace the original
transport snapshot or establish bytes missing from it. A successful comparison
is not proof that the original request succeeded. Use the original trace and
transport snapshot before attributing a failure to the proxy, Next, or Chromium.
No probe follows redirects, retries a request, or sends a mutation. Query
strings, credentials, cookies, and unrelated application requests are omitted
from the new report and probes. Ordinary cancelled requests are ignored unless
they also have an HTTP error status. The existing trace remains unchanged.

The report records unavailable or oversized network traces explicitly. Trace
scanning is limited to 32 MiB and 20 failed script records. Diagnostics failures
are logged and, when possible, written to the report; the original test still
fails. Successful tests create no diagnostic report or comparison traffic.
Reports are included in the existing GitHub failure-artifact upload. To use the
reporter, run the normal `npm run test:browser` or `bin/check`; overriding
Playwright's `--reporter` option replaces this reporter too.

Each failed report is also copied into `.cache/browser-failures/failure-<UUID>.json`
with private file permissions. The isolation command sends both copies' reports
to this directory in the source checkout, outside the disposable directories.
Keep the printed retained path when removing a failed isolation checkout.
The archive holds at most 100 reports and 50 MiB in total, with a 2 MiB limit
per report. Every reporter startup or archive write removes owned reports older
than seven days and prunes the oldest reports to stay within those limits.
Successful runs write no diagnostic reports. Concurrent writers use an exclusive
lock. Cleanup leaves unrelated files and symlinks alone. If a killed process
leaves `.lock`, verify no browser runner is writing before removing that lock.
Archive errors are reported without replacing the original test failure or its
local report. Files can also be removed manually when no runner is active.

This capture and prompt-failure behavior supports the continuing correction in
[#83](https://github.com/jubishop/screenr/issues/83). Passing reruns and additional
logging do not establish a root cause or complete that issue. The separate
serving-mode evaluation is tracked in
[#84](https://github.com/jubishop/screenr/issues/84).

**Decision — 2026-09-09:** Deliver this capture and prompt-failure behavior
through [PR #85](https://github.com/jubishop/screenr/pull/85) after normal review,
while keeping #83 open for the root-cause correction. Remove the PR's closing
keyword for #83. This puts the recorder into ordinary browser runs so it can
capture the next occurrence. The tradeoff is that the intermittent fault remains
unresolved after this delivery; evidence and a verified correction are still
required before closing #83.

**Decision — 2026-10-12:** Keep the prompt-failure guard in
`scripts/browser-test.ts`, which fails a test as soon as an essential local
script fails to load. Retire the transport capture: the proxy socket ring,
the original-transport snapshot, comparison probes, `script-diagnostics.json`
reports, the `.cache/browser-failures/` archive, and their tests.
[Issue #157](https://github.com/jubishop/screenr/issues/157) tracks the
removal and replaces this section with a short outcome summary. This
supersedes the 2026-09-08 decision to keep these diagnostics permanently.

**Why:** #83 closed after its IPv6 self-connection correction, and browser
tests now default to production serving. The guard still prevents hung tests
and keeps the browser error and trace, while the capture added socket
wrapping to every run for a fault that no longer occurs. Git history retains
the recorder if the failure returns.

**Rejected alternatives:** Keeping the full recorder as insurance, and
removing the guard as well.

**Decision — 2026-09-08:** Issue #69 is complete when permanent failure
diagnostics are delivered and another investigation of at most 30 minutes has
a recorded outcome. Reproduction of the original error is not required for
that scope. This permits an honest stopping condition when the original
failure cannot be captured; it does not claim that the intermittent defect is
fixed. The investigation result belongs in the issue and PR.

## Data and access rules

Account includes optional **Your streaming services** settings. Members can
search the grouped service list, select services, save, cancel, or clear their
choices. Signup does not require selections. These preferences belong to the
signed-in member and are not exposed on public profiles.

**Find a title** shows all catalog results and circle suggestions by default,
with service notes and indicators for saved services. **My services** includes
saved subscription services and any reported free option. **Watch together**
puts shared choices available through either person's services or a free option
first, followed by known unmatched choices and unknown availability separately.
Both views use US availability, broad service names, and the existing cache.
They preserve their original title order within each displayed group. See
[title availability](title-availability.md#current-implementation) for cache,
request limits, and the additive service-preferences migration.

The [shared-feed implementation and migration](title-feed.md#shared-feed-implementation)
describe item identity, old-link redirects, and compatibility with the previous
release. `src/server/social.ts` owns shared reads and writes. PostgreSQL functions
`screenr_can_read` and `screenr_blocked` apply the same current relationship
rules to threads, cards, and comments. Friendship pairs are ordered by
PostgreSQL, including mixed-case auth IDs. No private feed or permission
result is persistently cached.

Display names contain 1–60 characters after trimming. Signup and both name
editors reject control characters (Unicode `Cc`), the line and paragraph
separators U+2028 and U+2029, and the bidirectional controls U+202A–U+202E and
U+2066–U+2069. The form shows "Remove line breaks and hidden control characters
from your display name." This keeps a name from adding lines to plain-text
activity emails or reversing text to imitate another member. Zero-width joiners
remain allowed for emoji sequences, as do accents and every script. Migration
`012-display-name-characters.sql` adds the same database check; production had
no such names when it was added
([issue #108](https://github.com/jubishop/screenr/issues/108)). After a
rollback, the previous release also cannot store these names, but shows a
server error instead of that message.

Profiles include an expandable Friends list for signed-in members, including
when the viewer is not a friend of the profile owner. Each entry links to its
profile. The list contains accepted friends only, filters blocks in either
direction, and counts only the visible people. Profile visibility and the
friend list use one database snapshot. The list refreshes with the profile;
viewing it does not grant access to private activity or pending requests.

The People page includes **People you may know**, based on two accepted
friendships. Each suggestion lists all eligible mutual friends and links to
their profiles. Suggestions exclude the viewer, existing friends, pending
requests in either direction, and blocked people or paths. One query reads
the candidates and mutual friends in one snapshot. Candidates appear once,
ordered by most mutual friends and then username; mutual friends use username
order. The section has an empty state when nobody qualifies. Sending a request
moves the person to the existing pending-request list. Polling, focus changes,
and relationship actions refresh the section. This discovery route does not
grant access to private activity or change anonymous title suggestions.

All domain writes take one transaction advisory lock. This makes invitation
capacity and permission changes ordered with content writes. It is a deliberate
small-app simplification; measure lock waits before replacing it. Signup commits
the profile, invitation use, signup record, and accepted inviter friendship in
one transaction. A replacement link connects the new member to the creator of
the invitation actually used to finish signup. Existing accounts are not
backfilled. Thread reads use one database snapshot. Open pages poll every three
seconds while visible,
waiting for any active refresh to finish, and refresh on focus. Each refresh
has a ten-second deadline; failure clears server content until a successful
refresh. Access changes clear content on the next refresh without
waiting for the New activity button. Previously delivered content cannot be
retracted from a user's device.

Members can **Delete** their own comments in any feed where the conversation
is accessible. Conversation hosts can also **Remove** other participants'
comments. Both actions erase the stored text and show a **Comment removed**
placeholder, preserving replies and their addressed-person context. The server
checks ownership and current conversation access on every removal request.
Standalone comment authors can also **Delete** the top-level entry. Its text
becomes **Comment removed** while eligible replies remain open for discussion.
Entries without visible, nonremoved replies disappear. The original spoiler
flag still protects the remaining discussion. This behavior is shared across
title, friends, and author-profile feeds, including open-page refreshes.

The migration command applies Better Auth's schema and numbered SQL files in
`db/`. It takes a migration lock and records applied files in
`screenr_migration`. Future schema changes must use new numbered files;
changing a previously applied file does not alter an installed database.
SQL filenames must match `NNN-name.sql`, with lowercase letters and hyphens in
the name. Invalid SQL filenames fail the release instead of being ignored.
Back up before deploying schema changes.

TMDB data is cached for 24 hours. A title page refreshes stored title details
after that, with a two-second timeout. If TMDB fails, times out, returns an
invalid title, or no longer has the title, the page shows the stored details
and waits five minutes before retrying. Migration `013-title-retry.sql` adds
the nullable `title.retry_after` column for this delay, which the previous
release ignores; `fetched_at` still records the last successful fetch. Only a
title that was never stored depends on TMDB, with an eight-second timeout.
Title details, trailer, and availability load in parallel, and the optional
caches are written once the title is stored. Actions and comments use the
stored title without contacting TMDB, so members can still remove actions on
a title TMDB dropped.

`public/tmdb.svg` is the unmodified approved short logo from the
[TMDB logo page](https://www.themoviedb.org/about/logos-attribution).
The Credits page supplies the required attribution notice.

### Title availability

Movie and TV title pages show [US viewing options](title-availability.md)
from TMDB's JustWatch-backed watch-provider endpoints. They use the existing
server-side `TMDB_READ_TOKEN`; no additional provider account is needed.
Migration `007-title-availability.sql` adds the separate availability cache.
Results refresh on demand after 24 hours, with a two-second request timeout
and five-minute retry delay. Failed refreshes preserve the last successful
data and its timestamp. The title-page section supplies JustWatch attribution.
Subs lists subscriptions; Free combines free and ad-supported offers. Plans
and reseller channels share one entry per service in each section, ordered
alphabetically. Rental and purchase offers stay in the cache but are omitted
from the display. Existing cache rows use these rules without a refresh.
See [provider registry maintenance](title-availability.md#provider-registry-and-maintenance)
for snapshot coverage, source identity decisions, and update checks.

### Title trailers

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
