---
status: current
---

# Running Screenr

This guide covers local setup and provider configuration. The
[README](../README.md#what-screenr-does-today) summarizes what Screenr does
today and links the features that are not built yet. Related guides cover
[testing](testing.md), [notifications](notifications.md),
[data and access rules](data-and-access.md), the
[title catalog](title-catalog.md), and
[installation and the offline page](installation.md).

## Local setup

Use the latest Node.js LTS release, npm, Python 3.9+, ShellCheck, Caddy,
OpenSSL, and a Docker-compatible engine. Caddy and OpenSSL are used by the local proxy test;
do not start a system Caddy service. On macOS, install the test tools with
`brew install caddy openssl`; the existing Colima installation can provide Docker.
To run several checkouts at once, give each its own database and development
port as described in [several checkouts at once](#several-checkouts-at-once).
QMD search is described in [knowledge search](foundation/knowledge-search.md).

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
**Invite friends** on the Friends page, and open it in a separate browser
profile for a second member. Completing signup automatically makes the new
member and inviter accepted friends. Find a movie or show, recommend it, and
open its conversation from the other member's feed.
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
[the browser harness](testing.md#browser-harness).

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

Locally, the activity email setting and [notifications](notifications.md)
work, but no activity email is sent. `tests/app/email.test.ts` and
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
