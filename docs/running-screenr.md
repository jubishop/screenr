---
status: current
---

# Running Screenr

The first milestone implements invited signup, Google or email-code sign-in,
required profiles, accepted friendships, TMDB discovery, recommendations,
Want to watch, standalone title comments, and shared interactive feeds. The
remaining first-release features in the [product brief](product-brief.md) are
outside this milestone.

## Local setup

Use Node.js 24 LTS, npm, Python 3.9+, ShellCheck, Caddy, OpenSSL, and a
Docker-compatible engine. Caddy and OpenSSL are used by the local proxy test;
do not start a system Caddy service. On macOS, install the test tools with
`brew install caddy openssl`; the existing Colima installation can provide Docker.
Each application worktree needs its own database and development port if
several copies run together. QMD setup is described in the
[development workflow](development-workflow.md).

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
server environment. Register the new callback before changing this value.
Leave the old `https://screenr.jubishop.com/api/auth/callback/google` registration
in place. Follow the [domain cutover procedure](deployment.md#domain-cutover)
to coordinate Google, DNS, TLS, and the server. Google's callback must match
the registered URL exactly; see its [redirect URI requirements](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred).

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
`Screenr <screenr@jubishop.com>` on 2026-09-05. Keep that verified sender when
moving the website to `screenr.club`; the website domain does not require an
email sender change. No new sender DNS is needed. Verify actual inbox delivery
before opening signup. No paid-plan upgrade is part of this deployment.

The email worker stores encrypted, expiring jobs in PostgreSQL. Failed sends
retry with the same Resend idempotency key. Requesting a new code replaces an
older pending retry for that address and verification type, with a new key.
Successful sends clear their
payload. Expired jobs are discarded. Unknown addresses without a valid invite
do not queue email. Better Auth also limits requests and code attempts. The
shared Resend free allowance can still be exhausted by other applications;
inspect Resend delivery activity if codes do not arrive.

## Verification

```sh
npx playwright install chromium
bin/check
```

`bin/check` preserves the repository foundation tests and adds formatting,
TypeScript, PostgreSQL tests, a browser scenario, and a production build.
The local default test database is `screenr_test` on port 5439. Override it
with `TEST_DATABASE_URL`. The test role must be able to create databases.
All test databases are disposable and are reset by the harness; never point
these commands at a database with records to keep.

The browser harness derives four loopback ports and a database named
`screenr_browser_<checkout hash>_test` from the checkout's canonical path.
Separate worktrees get separate defaults, Next output, invitation files, and
`.cache/mail` captures. The harness prints its URL and database name at startup.
`TEST_DATABASE_URL` must name a loopback PostgreSQL test database without URL
query parameters. The browser harness uses the same server and credentials,
with its separate database name.

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
Run only one browser suite per checkout at a time.

Run the repeatable concurrent check with:

```sh
npm run test:browser:isolation
```

This copies the current non-ignored Git working files and installed dependencies
into two temporary checkout directories, then runs both complete browser suites
at the same time. It also checks that active database and checkout conflicts
fail before reset. It removes its databases and successful temporary copies.
Failed copies retain browser logs and traces at the printed paths. It does not
create Git branches or alter another worktree. Ordinary `bin/check` includes
configuration and port-conflict regression tests and one complete browser suite;
run the concurrent check after changing browser harness isolation.

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
- Failed sign-out and Google sign-in requests show an error and allow retry.
  A pending member can finish signup through a replacement invitation.
- Reply drafts survive failed refreshes and typing during a pending post.
  Refresh failures hide server content until access is checked again;
  unrelated refreshes do not clear action errors.
- Slow refreshes still deliver new replies and revoke access. A refresh that
  exceeds ten seconds hides server content; later recovery retains the draft.
- Circle, profile, and title feed cards can toggle the viewer's Want to watch
  and Recommend states independently. The inline Recommend action follows
  Want to watch on other people's entries. Both controls show the viewer's
  current state, including after reload. Clearing the last
  activity flag hides an empty card, while visible comments keep its thread
  listed.

Database tests additionally cover concurrent signup limits, rollback after
username conflicts, expiry, code/account identity, explicit Google linking,
one-level reply grouping, host removal, and encrypted email delivery retries.
They verify automatic inviter friendships for email and Google signup, legacy
links, and replacement invitations. Retrying setup does not consume another
use or restore a friendship after unfriending or blocking.
Operational tests check activation rollback after a stalled health request and
rejection of incorrectly named SQL migrations before schema changes begin.
The proxy test runs the production Caddy routes on loopback with a temporary
certificate and a fixture upstream. It verifies the new hostname, client IP
forwarding, security headers, and old invitation/title redirects with their
paths and queries intact. Run it alone with
`node --import tsx --test tests/app/proxy.test.ts`. It does not verify public DNS,
Cloudflare certificates, or real provider configuration.
The browser test writes mobile and desktop screenshots to `.cache/` and
keeps failure traces in `test-results/`.

### Failed development scripts

Failed browser tests also retain `script-diagnostics.json` beside their trace.
The reporter reads failed local `/_next/static/*.js` requests from every traced
context, including contexts created manually. It records the original browser
error, HTTP status and selected response headers, plus Node, Next, Playwright,
platform, and port metadata.
For up to five distinct paths, it makes one later GET through the fixture proxy
and one directly to Next. These probes preserve the status line, selected
headers, byte count, and timeout or connection error. Duplicate framing headers
are retained. Each probe stops after two seconds or 4 KiB. All probes run
concurrently; reporter execution has a ten-second outer limit.

Comparison requests are later observations. They cannot establish the exact
bytes of an earlier intermittent failure. A successful comparison is not proof
that the original request succeeded. Use the original trace and server log
with the report before attributing a failure to the proxy, Next, or Chromium.
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

**Decision — 2026-09-08:** Issue #69 is complete when permanent failure
diagnostics are delivered and another investigation of at most 30 minutes has
a recorded outcome. Reproduction of the original error is not required for
that scope. This permits an honest stopping condition when the original
failure cannot be captured; it does not claim that the intermittent defect is
fixed. The investigation result belongs in the issue and PR.

## Data and access rules

The [shared-feed implementation and migration](title-feed.md#shared-feed-implementation)
describe item identity, old-link redirects, and compatibility with the previous
release. `src/server/social.ts` owns shared reads and writes. PostgreSQL functions
`screenr_can_read` and `screenr_blocked` apply the same current relationship
rules to threads, cards, and comments. Friendship pairs are ordered by
PostgreSQL, including mixed-case auth IDs. No private feed or permission
result is persistently cached.

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

TMDB data is cached for 24 hours. `public/tmdb.svg` is the unmodified approved
short logo from the [TMDB logo page](https://www.themoviedb.org/about/logos-attribution).
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

The responsive player starts only after interaction and always includes a
direct YouTube link for restricted, removed, or otherwise unavailable embeds.
It uses [YouTube's inline playback parameters](https://developers.google.com/youtube/player_parameters)
and a minimum height of 200 pixels. Its iframe explicitly uses
`strict-origin-when-cross-origin` to satisfy
[YouTube's referrer requirement](https://developers.google.com/youtube/terms/required-minimum-functionality#embedded-youtube-player-and-player-api-clients).
This sends the site origin without the title path. The site's default
`no-referrer` policy still applies to other requests.

The catalog tests exercise real HTTP and PostgreSQL boundaries. Browser tests
replace YouTube at the network boundary and check conditional rendering,
desktop and mobile dimensions, the actual outgoing referrer, and persistence
of the iframe during page refresh. Also verify an available real trailer in
a local browser before release: confirm that it is initially paused, click
Play, check advancing playback on desktop and mobile, and check the provider
link. Automated provider fixtures do not establish live YouTube availability.
