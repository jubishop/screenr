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
OpenSSL, and PostgreSQL 18. Caddy and OpenSSL are used by the local proxy test;
do not start a system Caddy service. On macOS, install them with
`brew install caddy openssl postgresql@18`.
CI tests with production's Caddy release instead; see
[CI Caddy](development-workflow.md#ci-caddy).
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

PostgreSQL runs natively as a Homebrew login service on port 5439, not in
Docker; see the [local PostgreSQL decision](development-workflow.md#local-postgresql).
Set its port and its time zone to UTC, start it, and create the local role and
database once. Tests compare dates in UTC, as CI's server does, and the role
is a superuser, as in CI, so tests can create and reset their databases:

```sh
sed -i '' -e 's/^#port = 5432/port = 5439/' -e "s/^timezone = .*/timezone = 'UTC'/" \
  "$(brew --prefix)/var/postgresql@18/postgresql.conf"
brew services start postgresql@18
psql -h 127.0.0.1 -p 5439 -d postgres -c "CREATE ROLE screenr LOGIN SUPERUSER PASSWORD 'screenr-local-only'"
createdb -h 127.0.0.1 -p 5439 -U screenr screenr
```

Then set up the checkout:

```sh
bin/setup
npm ci
cp .env.example .env
chmod 600 .env
openssl rand -base64 32
```

Put the generated random value in `BETTER_AUTH_SECRET` in `.env`. Keep that
file private. Set `TMDB_READ_TOKEN` to the API Read Access Token from TMDB's
account API settings. `EMAIL_TRANSPORT=file` captures development codes
locally and sends no email. Keep the tracked `.env.example` complete when
adding or renaming configuration: include placeholders for authentication,
Google, TMDB, Resend, Sentry, and backup settings, with no real secrets. Leave
`SENTRY_DSN` empty locally. Backup placeholders are optional for local
development; the VPS backup jobs use the separate file described in
[deployment](deployment.md#encrypted-backups-and-restore-check).
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

Checkouts share the local PostgreSQL server. `npm run db:migrate` does not
create databases, so create one for each additional checkout:

```sh
createdb -h 127.0.0.1 -p 5439 -U screenr screenr_feature
```

In the additional checkout, set `DATABASE_URL` in `.env` to
`postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_feature`.
Test commands do not read `.env`, so export a separate test database in that
checkout's shell. They create the database if needed and reset it; its name
must end in `_test`:

```sh
export TEST_DATABASE_URL=postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_feature_test
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
failed sends, and deletes expired jobs and
[usage telemetry](usage-telemetry.md#retention-and-tests) older than 12
months. Local development does not need it.
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

The worker also sends [iPhone push notifications](notifications.md#push-delivery)
to APNs when `APPLE_TEAM_ID`, `APNS_KEY_ID`, and `APNS_PRIVATE_KEY` are set.
Leave them empty locally: the worker then prints `push delivery off` and
sends no pushes. `tests/app/push-delivery.test.ts` covers delivery against
fake APNs servers on loopback.

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
retry with backoff and the same Resend idempotency key until the job expires.
Resend 4xx replies other than 408, 409, and 429 expire the job at once, since
a retry cannot fix invalid input, a missing or revoked key, or an unverified
sender. The worker [logs](deployment.md#failure-logs) every failed send.
Requesting a new code replaces an older pending retry or rejected code for
that address and verification type, with a new key. Successful sends clear
their payload. Expired jobs are discarded. Unknown addresses without a valid
invite do not queue email.

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

## iPhone app accounts and keys

[Issue #221](https://github.com/jubishop/screenr/issues/221) set up these
records for the [iPhone app](ios-app.md). Key IDs, the team ID, client IDs,
and DSNs identify records and are not secret. Never put a private key or
token in the repository, an issue, a PR, or a log. `.env.example` lists the
server settings with empty values, and [deployment](deployment.md#provisioning)
lists the production settings with the issues that read them.

### Apple Developer

Every record belongs to Apple developer team `34TKMKM889`.

| Record | Purpose | Storage |
| --- | --- | --- |
| App ID `com.artisanalsoftware.Screenr` | The Release app, and the primary App ID for Sign in with Apple | Apple Developer account |
| App ID `com.artisanalsoftware.Screenr.dev` | The Dev variant; its Sign in with Apple is grouped with the primary | Apple Developer account |
| App ID `com.artisanalsoftware.Screenr.Share` | The Release app's [share extension](../ios/README.md#share-extension), with only the App Groups capability | Apple Developer account |
| App group `group.com.artisanalsoftware.Screenr` | Storage and Keychain items shared by the app and its extensions | Apple Developer account |
| APNs key "Screenr APNs", key ID `YP5RTHDXQR` | Signs the worker's push requests ([#240](https://github.com/jubishop/screenr/issues/240)) | [Key files](#apple-key-files) and `APNS_PRIVATE_KEY` |
| Sign in with Apple key "Screenr Sign in with Apple", key ID `738SADC362` | Signs the client secret for Apple's token and revoke endpoints ([#215](https://github.com/jubishop/screenr/issues/215)) | [Key files](#apple-key-files) and `APPLE_PRIVATE_KEY` |
| Private email relay source `screenr@jubishop.com` | Lets Hide My Email addresses receive sign-in codes and activity email | Apple Developer account |

Both app App IDs have the App Groups, Associated Domains, Push Notifications,
Sign in with Apple, and Communication Notifications capabilities. Keychain
sharing is not an App ID capability; the app group doubles as the Keychain
access group. Automatic signing registers an extension's App ID when the
extension is added. On 2026-10-14 the App Store Connect API key's archive
failed with "Authentication failed" while registering the share extension's,
and an archive signed through the Mac's Xcode account registered it, with
the app group; the key's archive has signed it since. Expect the same for the
notification service extension. The APNs key is team
scoped and works with both the sandbox and production APNs.

Apple's relay delivers mail only from registered sources. The registered
`screenr@jubishop.com` passes SPF. Register a new sender before changing
`EMAIL_FROM`, or relay addresses stop receiving Screenr's email.

**Sign in with Apple settings:** the server offers
[native Apple sign-in](data-and-access.md#native-sign-in) when `app.env` sets
all three of these. Without them, as in development and CI, the app starts
and Apple sign-in returns 404; activation does not require them.

| Setting | Value |
| --- | --- |
| `APPLE_TEAM_ID` | `34TKMKM889` |
| `APPLE_KEY_ID` | `738SADC362`, the Sign in with Apple key |
| `APPLE_PRIVATE_KEY` | That key in the [single-line form](#apple-key-files) |

The server accepts ID tokens for both App IDs. For each code exchange and
revocation, it signs a five-minute client secret naming the app's bundle ID,
so no secret needs renewal. Each account's newest refresh token is stored
encrypted for account deletion to revoke. Changing `BETTER_AUTH_SECRET` makes
the stored tokens unreadable, like queued email, until each member's next
Apple sign-in stores a new one; deleting an account meanwhile skips its
unreadable token. Apple sign-in has no web button, return URL,
or domain to register.

### Apple key files

Apple allows each `.p8` key to be downloaded only once. The original files
have the same off-server copies as the
[production secrets](restore-and-patching.md#production-secrets):

- **Mac:** `~/.config/screenr/keys/AuthKey_<key ID>.p8`, which the owner's
  private home repository tracks.
- **1Password:** documents "Screenr APNs key YP5RTHDXQR" and "Screenr Sign
  in with Apple key 738SADC362" in the owner's Private vault, tagged
  `screenr`.

`app.env` stores each key on one line: the base64 body of the `.p8` file,
without its PEM header, footer, or line breaks. That is the key's PKCS#8 DER
in base64.

### App Store Connect

| Record | Purpose | Storage |
| --- | --- | --- |
| App "Screenr", Apple ID `6822501070`, SKU `screenr-ios` | The app record for TestFlight and, later, the App Store | App Store Connect |
| TestFlight internal group "Screenr team" | Internal testing; the owner is a member, and it has access to every build | App Store Connect |
| TestFlight external group "Public testers" | External testing through a public link ([#250](https://github.com/jubishop/screenr/issues/250)) | App Store Connect |
| API key "Agents", key ID `A9CMX47R79`, Admin role | Signing, upload, and TestFlight distribution in the release script ([#246](https://github.com/jubishop/screenr/issues/246)) | The owner's Mac |

Releases reuse the team's existing "Agents" key, which PodHaven also uses.
Its `.p8` file stays on the owner's Mac at the path in `ASC_KEY_PATH`, and
the owner's shell exports `ASC_KEY_ID` and `ASC_ISSUER_ID`.
[TestFlight releases](development-workflow.md#testflight-releases) add each
build to "Public testers" and create the group, without a public link, if it
is missing. [#250](https://github.com/jubishop/screenr/issues/250) enables
the link after the first build passes Beta App Review.

### Google

The iOS OAuth client "Screenr iOS" is in Google Cloud project
`screenr-69420`, beside the [web client](#provider-configuration). An iOS
client has no secret, and its client ID is public:

```text
1083033132977-i7pofqgq76lrnahd4l5q6bht51uhtc3o.apps.googleusercontent.com
```

The app requests Google ID tokens with it, and the server accepts it as their
audience through `GOOGLE_IOS_CLIENT_ID`
([#216](https://github.com/jubishop/screenr/issues/216)). With that setting,
the server accepts ID tokens issued to either the iOS or the
[web client](#provider-configuration), so
[native Google sign-in](data-and-access.md#native-sign-in) needs no Google
SDK or client secret in the app. The app redeems Google's authorization code
itself with PKCE, so the server registers no redirect URI for it. The setting
is optional: without it, tokens issued to the iOS client fail and web sign-in
is unchanged. The app's `ios/Config/Base.xcconfig` holds the same client ID
for both variants, and `ios/Screenr/Info.plist` registers its reversed form,
`com.googleusercontent.apps.<client>`, as the redirect scheme.

**Publishing status:** with the owner's approval, the project's Google Auth
Platform app was published on 2026-10-13. It is "In production" with the
External user type, and its branding links `https://screenr.club` and
`https://screenr.club/privacy`. Any Google account can therefore sign in,
subject to Screenr's invite-only rules. Screenr requests only basic scopes,
so the app needed no Google verification. Uploading a logo would require
verification.

### Sentry

Both projects are in Sentry organization `artisanal-software`, with IP
address scrubbing and data scrubbing enabled.

| Record | Purpose | Storage |
| --- | --- | --- |
| Project `screenr-ios` (Apple iOS) | App crashes, errors, performance, and feedback ([#222](https://github.com/jubishop/screenr/issues/222)) | DSN compiled into Release builds |
| Project `screenr-server` (Node) | Server [failure reports](deployment.md#failure-reports-in-sentry) ([#223](https://github.com/jubishop/screenr/issues/223)) | DSN in production `SENTRY_DSN` |
| The owner's Sentry user token | Uploads dSYMs from archive builds ([#222](https://github.com/jubishop/screenr/issues/222)) | `SENTRY_AUTH_TOKEN` in the owner's shell, or `~/.sentryclirc`, on the Mac. See [symbols](../ios/README.md#symbols) |
| Read-only personal token with `event:read`, `project:read`, and `org:read` | The daily feedback workflow ([#249](https://github.com/jubishop/screenr/issues/249)) | GitHub repository secret `SENTRY_AUTH_TOKEN` |

The `screenr-ios` DSN is public, because the Release app contains it:

```text
https://7835b8d6ce485bae558bdc65d7f373ee@o4508469263663104.ingest.us.sentry.io/4512251383513088
```

## Demo circle for Apple review

Apple's Beta App Review signs in to a closed demo circle, under the
[demo circle decision](ios-app.md#isolated-demo-circle-for-apple-review--2026-10-13)
([issue #247](https://github.com/jubishop/screenr/issues/247)).
`npm run seed:review` runs `scripts/seed-review.ts`, which reads `.env` when
present. Production runs it with the
[one-off command](deployment.md#build-and-activate-a-release) in the
deployment guide. It creates:

- **The reviewer:** `review@screenr.club`, username `demo_reviewer`.
- **Three demo friends:** `demo_maya`, `demo_theo`, and `demo_priya`. Their
  addresses use the reserved `demo.screenr.invalid` domain, which can never
  receive email.
- **Activity:** everyone in the circle is an accepted friend of everyone else
  and of no one outside it. The friends recommend and review real TMDB
  titles, mark watch statuses, keep a top 10, and talk in a conversation. The
  reviewer has one Want to watch with a friend's reply, which shows as a
  notification.

The command first resolves the titles through the catalog, so it needs
`TMDB_READ_TOKEN`; a catalog failure changes nothing. It refuses, also
changing nothing, when a seeded address or username belongs to an account
outside the circle.

**Reset.** Every run replaces the circle. It deletes each demo account,
including anyone who joined through a demo invitation, with everything they
made, their sessions, and their notifications, through the same erasure as
[account deletion](data-and-access.md#account-deletion). It then seeds a
fresh circle in new accounts. A signed-in reviewer is signed out. The
accounts and friendships commit together; the activity follows through the
same services, so if a run fails partway, run it again.

**Sign-in code.** `REVIEW_SIGN_IN_CODE` holds the reviewer's fixed six-digit
code. Set it only in the production environment, and put the code in App
Store Connect's review notes, never in an issue, PR, or log. Screenr never
prints it. One way to generate a code:

```sh
node -e 'console.log(String(require("node:crypto").randomInt(1e6)).padStart(6, "0"))'
```

When the reviewer requests a code, Screenr stores this one, hashed, instead
of a random code. It then works like any other code: only after a request,
for 10 minutes, and for five attempts, under every
[login-code limit](#provider-configuration). Only `review@screenr.club` and
only sign-in codes use it. Without a six-digit value, the reviewer gets an
ordinary random code that is never sent, so nobody can sign in to the circle,
and the command prints a reminder. The web service reads the variable when it
starts, so restart `screenr-web` after setting or changing it.

**No email.** Screenr sends no sign-in code to a seeded address. The reviewer
types the code from the review notes, and the demo friends never sign in.
Skipping the send keeps the code out of mailboxes, spends none of the shared
Resend allowance, and avoids bounces from addresses that cannot receive mail.
These requests still count toward the per-address limits.

**Isolation.** Migration `028-demo-circle.sql` marks demo profiles with
`profile.demo`, and `screenr_blocked` treats a demo profile and a real one as
blocked in both directions. Neither can open the other's profile or send a
friend request, and neither appears in the other's friend lists, People you
may know, feeds, title suggestions, Friends recommend, comments,
notifications, or photos, even across a friendship. Someone who joins through
a demo member's invitation joins the demo circle. The
[usage report](usage-telemetry.md#owner-report) leaves out demo accounts and
everything they post. `tests/app/review-demo.test.ts` covers the command and
reset, the fixed code and its limits, and isolation.
