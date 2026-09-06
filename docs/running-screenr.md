---
status: current
---

# Running Screenr

The first milestone implements invited signup, Google or email-code sign-in,
required profiles, accepted friendships, TMDB discovery, recommendations,
Want to watch, and shared conversations. The remaining first-release features
in the [product brief](product-brief.md) are outside this milestone.

## Local setup

Use Node.js 24 LTS, npm, Python 3.9+, ShellCheck, and a Docker-compatible
engine. On macOS, the existing Colima installation can provide Docker.
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

After requesting an email code in the browser, read it with:

```sh
npm run dev:code -- you@example.test
```

Complete the display name and username. Create another invitation from
**Invite friends**, and open it in a separate browser profile for a second
member. Send and accept a friend request from **Friends**. Find a movie or
show, recommend it, and open its conversation from the other member's feed.
Save it as Want to watch and post a reply. The title page and feed both link
to that same conversation.

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
https://screenr.jubishop.com/api/auth/callback/google
```

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
`Screenr <screenr@jubishop.com>` on 2026-09-05. Use that verified sender; no new
sender DNS is needed. Verify actual inbox delivery before opening signup. No
paid-plan upgrade is part of this deployment.

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
Both test databases are disposable and are reset by the harness; never point
these commands at a database with records to keep.

The browser harness owns loopback ports 3055, 3056, 3058, and 3059 and a separate
`screenr_browser_test` database on the same PostgreSQL server. Port 3055 routes
application requests to Next and auth requests to the real auth handlers with
a local identity provider. This keeps OAuth redirects, state cookies, PKCE
verification, account linking, and sessions in the browser flow. The provider
supplies test identities; automated tests do not prove Google's availability
or production credentials. The harness also supplies a fictional TMDB catalog
and captures email locally. It does not use paid services or contact real
recipients. A full run checks:

- Four invited members complete email verification and required profiles.
- Friendship needs acceptance; inviting alone gives no content access.
- A recommendation appears in the friend's feed and title page, with one
  canonical conversation. Saving a title persists.
- Own replies appear immediately. Incoming replies wait behind **New replies**.
  The test checks scroll position after inserting an earlier nested reply.
  Spoilers require a reveal; replies survive a reload.
- A nonfriend cannot read or write through direct API calls or the page.
- Unfriending removes open-page access and hides historical comments for
  remaining readers; refriending restores them.
- A blocked pair cannot see each other in a mutual friend's conversation,
  while the host retains visibility.
- Invitations can be created and revoked.
- Google signup shows an existing connection and removes the connect button.
  A wrong email code is rejected; a valid code returns to the same profile.
- An email-created account can recover from a provider request failure,
  canceled consent, and a mismatched Google email. Error messages survive the
  account refresh. Successful linking persists after reload, and subsequent
  Google sign-in returns to the existing profile.

Database tests additionally cover concurrent signup limits, rollback after
username conflicts, expiry, code/account identity, explicit Google linking,
one-level reply grouping, host removal, and encrypted email delivery retries.
The browser test writes mobile and desktop screenshots to `.cache/` and
keeps failure traces in `test-results/`.

## Data and access rules

`src/server/social.ts` owns shared reads and writes. PostgreSQL functions
`screenr_can_read` and `screenr_blocked` apply the same current relationship
rules to threads, cards, and comments. Friendship pairs are ordered by
PostgreSQL, including mixed-case auth IDs. No private feed or permission
result is persistently cached.

All domain writes take one transaction advisory lock. This makes invitation
capacity and permission changes ordered with content writes. It is a deliberate
small-app simplification; measure lock waits before replacing it. Thread reads
use one database snapshot. Open pages poll every three seconds while visible
and refresh on focus. Access changes clear content on the next refresh without
waiting for the New replies button. Previously delivered content cannot be
retracted from a user's device.

The migration command applies Better Auth's schema and numbered SQL files in
`db/`. It takes a migration lock and records applied files in
`screenr_migration`. Future schema changes must use new numbered files;
changing a previously applied file does not alter an installed database.
Back up before deploying schema changes.

TMDB data is cached for 24 hours. `public/tmdb.svg` is the unmodified approved
short logo from the [TMDB logo page](https://www.themoviedb.org/about/logos-attribution).
The Credits page supplies the required attribution notice.
