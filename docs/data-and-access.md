---
status: current
---

# Data and access rules

This page describes how the running app stores shared social data, applies
current relationship and access rules, orders domain writes, and migrates its
schema. The [product brief](product-brief.md) holds the accepted access
decisions, and the
[implementation approach](application-stack.md#implementation-approach) sets
the conventions this code follows.

## Shared feeds and access checks

The [shared-feed implementation and migration](title-feed.md#shared-feed-implementation)
describe item identity, old-link redirects, and compatibility with the previous
release. Shared reads and writes live in `src/server/` by area: `profiles.ts`,
`relationships.ts`, `feed.ts` (the shared feed read path), `title-actions.ts`
(Recommend, [watch statuses](title-feed.md#watch-progress-entries), and the
[profile top 10](profile-top-ten.md#implementation) lifecycle), `top-ten.ts`,
`reviews.ts` ([ratings and reviews](title-feed.md#reviews)), `comments.ts`,
and `reactions.ts`. PostgreSQL functions
`screenr_can_read` and `screenr_blocked` apply the same current relationship
rules to threads, cards, and comments. `screenr_blocked` also keeps the
[demo circle for Apple review](running-screenr.md#demo-circle-for-apple-review)
and real members apart. The title page friend line comes
from the viewer's title feed read, so it names only friends whose entries
that feed shows. Friendship pairs are ordered by
PostgreSQL, including mixed-case auth IDs. No private feed or permission
result is persistently cached.

## API actions

`/api/screenr/[action]` serves the actions declared in
`src/server/actions.ts`. Each entry names its HTTP method, reads its fields
from the query or JSON body, and calls the services that validate them. Its
result becomes the JSON response; an action without one responds
`{ ok: true }`. The route applies the shared rules in this order:

1. A POST must come from the app's origin (403), unless it carries a
   [bearer token](#native-client-sessions).
2. The request needs a session (401).
3. Every action except profile setup and photo changes needs a completed
   profile (403).
4. An unknown action, or a known one with another method, returns 404.
5. Usage telemetry records the day for member POST actions, photo changes by
   members, and title searches
   ([active days](usage-telemetry.md#active-days)).
6. A POST body must be a JSON object of at most 16,000 bytes (400 or 413).
   A photo upload's body is the image itself, at most 200 KB.

Add an action as one entry, using `read` for a member GET, `write` for a
member POST, `signup` for a POST that runs before profile setup, or `photo`
for a photo change, which works before and after setup. Its `run` receives
the user ID, the request's session ID, and the request headers. Give it an
[iPhone API fixture](testing.md#iphone-api-fixtures) case in the same change.

### Single notification read

The iPhone Notification Service Extension reads one notification to build
its alert ([decision](ios-app.md#the-extension-fetches-push-content--2026-10-13),
[issue #242](https://github.com/jubishop/screenr/issues/242)):
`GET /api/screenr/notification?id=<notification ID>` with the app's bearer
token. It applies the bell's rules from the `visible_notification` view when
it is read, so blocking, unfriending, and removed comments take effect at
once. It records no usage and marks nothing read.

A visible notification answers
`{ "visible": true, "notification": { … } }`. The object holds the bell's
fields (`id`, `kind`, `actor`, `actorId`, `actorPhoto`, `message`, `href`,
`createdAt`, and `read`) and these:

- `title`: the movie or show's name, or `null`.
- `excerpt`: the comment's text on one line, at most 160 characters, ending
  at a word with "…" when cut. It is `null` for friendships and spoilers.
- `spoiler`: whether the comment or its entry is marked as a spoiler. A flag
  on a post or review covers its whole thread. The server omits a spoiler's
  text, so it never reaches the device before the reader reveals it.
- `thread`: the entry's ID, or `null` for friendships. It groups an entry's
  notifications and is the `conversation` of a reply.
- `comment`: the comment's ID, or `null`; a reply's `replyTo`.

`kind` is `friend_request`, `friend_accepted`, `comment` (on the
recipient's entry), or `reply` (addressed to the recipient). `actorPhoto` is
the photo version for `/api/photos/<actorId>/<version>`, or `null`.

Every notification the viewer cannot see answers `200` with
`{ "visible": false }`, whether it belongs to someone else, does not exist,
or is hidden by access rules. The single answer reveals nothing about which
applies, and the extension shows its generic alert. An ID that is not a
positive 64-bit integer answers `400`.

## Native client sessions

The iPhone app signs in with Better Auth's bearer plugin instead of the
session cookie ([decision](ios-app.md#bearer-sessions-in-the-keychain--2026-10-13),
[issue #212](https://github.com/jubishop/screenr/issues/212)).

- **Receiving the token:** a sign-in response that sets the session cookie
  also returns its signed value in the `set-auth-token` header when the
  request has no `Origin`. That covers the email code
  (`POST /api/auth/sign-in/email-otp`) and ID-token sign-in through
  `POST /api/auth/sign-in/social`. Browsers send an `Origin`, so their
  responses omit the header and page scripts never see a usable token.
- **Sending it:** the app keeps the token in the Keychain and sends
  `Authorization: Bearer <token>` on every request, including photo fetches.
  It sends no cookies, because Better Auth checks the `Origin` of any POST
  that carries one.
- **Signature required:** like the cookie, a token counts only with its
  signature. The bare `token` field in sign-in response bodies, or a value
  read from the `session` table, signs no one in.
- **Origin exemption:** `/api/screenr` skips its POST `Origin` check for a
  request whose `Authorization` scheme is `Bearer`. A browser never adds that
  header on its own, and a cross-site page cannot add it without a CORS
  preflight that Screenr never approves, so cross-site forgery does not
  apply. Every other request keeps the check, including a cookie request
  with another scheme.
- **Token only:** a bearer request signs in only with its token.
  `requestSession` in `src/server/auth.ts` ignores the request's cookies, so
  a missing, invalid, or revoked token gets 401 even beside a valid cookie.
  The API and photo routes use it.
- **Session rows:** a token names the same Postgres `session` row as a
  cookie, with the same 30-day lifetime. `POST /api/auth/sign-out` with the
  bearer header deletes that row and ends only that session.

## Native sign-in

Besides the email code, the iPhone app signs in with Apple or Google
([decision](ios-app.md#email-code-sign-in-with-apple-and-google--2026-10-13),
issues [#215](https://github.com/jubishop/screenr/issues/215) and
[#216](https://github.com/jubishop/screenr/issues/216)). It posts the
provider's ID token to `POST /api/auth/sign-in/social` without an `Origin` or
cookies, and the response returns the
[bearer token](#native-client-sessions) in `set-auth-token`.

- **Same rules as the web:** a new person needs an invitation, sent in the
  [`Screenr-Invitation` header](#invitation-tokens), which the user-creation
  hook that every signup shares checks. A matching email
  address never links an existing account. A signed-in member links a
  provider explicitly by posting the same body to `POST /api/auth/link-social`
  with their bearer token; the provider's address must be verified and match
  the account's.
- **Token checks:** Better Auth verifies the ID token's signature against the
  provider's published keys, and its issuer, audience, and expiry. It also
  requires an issue time within the last hour.
- **Sign in with Apple:** the app posts
  `{"provider": "apple", "idToken": {"token", "nonce", "user"}, "additionalData": {"authorizationCode"}}`
  with the credential's identity token and authorization code as strings.
  - The audience must be `com.artisanalsoftware.Screenr` or
    `com.artisanalsoftware.Screenr.dev`.
  - The app sets the authorization request's nonce to the SHA-256 hex digest
    of a random value and posts that raw value as `nonce`. The server checks a
    posted nonce, so the app always sends one.
  - Apple gives the person's name only on the first authorization. The app
    posts it then as `user: {"name": {"firstName", "lastName"}}`; it becomes
    the account's name, separate from the display name chosen in setup.
  - Every Apple sign-in and link needs the authorization code from the same
    authorization. After the ID token passes and a new person's invitation
    is accepted, the server redeems the code at Apple's token endpoint with a
    client secret it signs for the token's bundle ID, and requires Apple's
    reply to name the same person.
  - A Hide My Email relay address is stored like any other address.
  - The web offers no Apple sign-in. A request for Apple without an ID token
    returns 404.
- **Google:** the app posts `{"provider": "google", "idToken": {"token",
  "nonce"}}`. It gets the ID token through `ASWebAuthenticationSession` by
  running Google's authorization code flow with PKCE for the iOS client and
  redeeming the code at Google's token endpoint itself, so the server never
  sees the code or verifier. The audience may be the iOS client
  (`GOOGLE_IOS_CLIENT_ID`) or the web client. A nonce the app put in the
  authorization request is posted as `nonce` and must match exactly.
- **Apple tokens:** the Apple `account` row's `refreshToken` column holds the
  newest refresh token and the bundle ID it was issued to, encrypted with
  AES-256-GCM under a key derived from `BETTER_AUTH_SECRET`. Account deletion
  calls `revokeAppleTokens(userId)` in `src/server/apple.ts` before deleting
  the user. It revokes each token with Apple and clears it; when Apple does
  not confirm, it throws and keeps the token for a retry. An uninvited
  person's code is never redeemed, so Screenr keeps no token for them.

Rejections answer with a JSON body naming a `code` from Better Auth or a
`message` from Screenr:

| Status | Body                                                                      | Cause                                                                                                        |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 401    | `code` `INVALID_TOKEN`                                                    | The signature, issuer, audience, expiry, age, or nonce check failed.                                         |
| 403    | `message` "A valid invitation is required to join Screenr."               | A new person had no valid invitation.                                                                        |
| 401    | `code` `OAUTH_LINK_ERROR`                                                 | The address belongs to an account without this provider ID linked.                                           |
| 400    | `message` "Sign in with Apple needs its authorization code."              | No `additionalData.authorizationCode`.                                                                       |
| 401    | `message` "Apple did not confirm this sign-in. Try again."                | Apple rejected the code, which expires after five minutes and works once, or it belongs to another Apple ID. |
| 503    | `message` "Sign in with Apple is unavailable right now. Try again later." | Apple's token endpoint failed or rejected Screenr's key. The failure is logged.                              |
| 404    | `code` `PROVIDER_NOT_FOUND`                                               | The server has no settings for the provider.                                                                 |
| 417    | `code` `LINKING_FAILED`                                                   | A new Apple link whose code was not redeemed.                                                                |

Linking keeps Better Auth's other errors, such as `UNAUTHORIZED` without a
session and `LINKING_DIFFERENT_EMAILS_NOT_ALLOWED`.

## Invitation tokens

The iPhone app joins without the web's `screenr-invite` cookie
([decision](ios-app.md#full-parity-including-signup--2026-10-13),
[issue #214](https://github.com/jubishop/screenr/issues/214)). It sends the
token from the `/join/<token>` link as `Screenr-Invitation: <token>` on each
request that signup checks, until setup succeeds:

- `POST /api/auth/email-otp/send-verification-otp`, requesting a code.
- `POST /api/auth/sign-in/email-otp`, the code sign-in that creates the
  account.
- `POST /api/auth/sign-in/social` with an ID token, for Google and Sign in
  with Apple.
- `POST /api/screenr/setup`.

`invitationToken` in `src/server/auth.ts` supplies the invitation to every
invite-only check. The header counts only on a native request: one with a
bearer token or without an `Origin`. There it takes precedence over the
cookie, and whatever it holds is the invitation. Browser requests carry an
`Origin`, so the web keeps using only the cookie. A native request without
the header falls back to the cookie, because Google's web sign-in callback
also arrives without an `Origin`.

The header follows the cookie's rules: the invitation must have uses
remaining and must be neither expired nor revoked.

- **Code request:** an address without an account gets a code only with a
  valid invitation. Otherwise nothing is sent, and the response is the same
  `200` with `{"success": true}` that a member's address gets, so it never
  reveals which addresses have accounts.
- **New account:** with any sign-in method, creating an account without a
  valid invitation fails with 403 and
  `{"message": "A valid invitation is required to join Screenr."}`. Existing
  accounts sign in without one. Sign-in records the invitation on the new
  account without using it up.
- **Setup:** uses the header's invitation, or else the one the account joined
  with. An unavailable invitation gets 403 and
  `{"error": "This invitation is no longer available. Ask for a new link."}`.
  Setup uses up the invitation and makes the new member its creator's
  friend in one transaction ([write lock](#write-lock-and-refresh-behavior)).

## Push devices and settings

The iPhone app registers its APNs device token and saves the member's
per-kind push settings
([push scope](ios-app.md#push-every-notification-immediately--2026-10-13),
[APNs delivery](ios-app.md#in-house-apns-delivery-from-the-worker--2026-10-13),
[issue #239](https://github.com/jubishop/screenr/issues/239)). Migration
`027-push-devices.sql` adds the storage, and `src/server/push.ts` holds the
reads and writes.

- **Device records:** `push_device` holds one row per token, stored as
  lowercase hex of 32 to 100 bytes. It records the member, the session that
  registered it, the APNs environment (`sandbox` or `production`), and the
  app's bundle ID, which APNs requests name as their `topic`. The bundle ID
  is `com.artisanalsoftware.Screenr` for Release builds or
  `com.artisanalsoftware.Screenr.dev` for Dev builds. The row also records
  the app build and the last time the app registered.
- **One owner per token:** a token belongs to one app on one phone, so it is
  the primary key. Registering a token that another session or member holds
  moves it to the current member and session. Registering a new token from
  the same session and bundle ID deletes the earlier token, which APNs
  replaced.
- **Signing out:** the row references its `session` row with
  `ON DELETE CASCADE`. Signing out, or anything else that deletes the
  session, deletes the device even when the app cannot reach the API. A
  device whose session expired but remains stored receives nothing.
- **Settings:** the `profile` columns `push_friend_request`,
  `push_friend_accepted`, `push_comment`, and `push_reply` hold the per-kind
  settings, all on by default. The account screen reports them as
  `pushSettings`, an object with the `friendRequest`, `friendAccepted`,
  `comment`, and `reply` booleans.

Both actions are member writes, so they need a completed profile and accept
the bearer token or the cookie. Invalid values return 400 with the usual error
body.

- **Register:** `push-device` with `{"action": "register", "token": "<hex>",
  "environment": "sandbox", "topic": "com.artisanalsoftware.Screenr.dev",
  "build": 42}` responds `{"ok": true}`. The build is a positive integer.
  The app registers on each launch, which refreshes the build and last-seen
  time.
- **Remove:** `push-device` with `{"action": "remove", "token": "<hex>"}`
  responds `{"ok": true}`. It deletes the token only from the member's own
  devices, and an unknown token changes nothing.
- **Save settings:** `push-settings` with one or more of `friendRequest`,
  `friendAccepted`, `comment`, and `reply`, each a boolean, responds
  `{"pushSettings": {...}}` with all four. Kinds the body leaves out keep
  their values.

Three helpers read and clean up the records. `pushDevices(userId, kind?,
client?)` lists the member's devices on live sessions as `{token,
environment, topic, build}`; with a notification kind, it returns none when
the member turned that kind off. `removePushDevice(token, client?)` deletes a
token that APNs rejects. `pushSettings(userId)` reads the settings. The
worker applies the same session and setting rules when it sends; see
[push delivery](notifications.md#push-delivery).

## Sign-in return path

A signed-out visit to a member page redirects to `/login?next=` with that
page's path, and a 401 API reply sends the open page there the same way, so
links in activity email and shared discussion links survive sign-in
([issue #134](https://github.com/jubishop/screenr/issues/134)). Email-code
sign-in and the Google callback continue to `/setup?next=`, which sends a
member with a profile on to the path and sends a new member there after
signup. A failed Google attempt returns to the sign-in page with the same
path. `returnPath` in `src/member-routes.ts` accepts only a root-relative path
that names a member screen, and rewrites it in canonical form. Absolute,
protocol-relative, backslash, control-character, and other paths, including
`/login` and `/setup`, fall back to the friends feed. Invitation links and
sign-out go to `/login` without a return path. Unsent drafts are not kept.

Services find a record by comparing its ID with the column's own type, `uuid`
or `bigint`, so PostgreSQL reads it through an `id` index instead of scanning
the table, including while a write holds the shared lock. Only the text
PostgreSQL prints for that type is an ID: a lowercase, hyphenated UUID, or a
positive integer in the `bigint` range without leading zeros. Any other value
returns the same not-found error as a missing record
([issue #129](https://github.com/jubishop/screenr/issues/129)).

## Display names

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

## Profile photos

Members add, replace, or remove an optional photo during setup and on
Account, following the
[profile photos decision](product-brief.md#profile-photos--2026-10-12)
([issue #104](https://github.com/jubishop/screenr/issues/104)). The shared
[avatar](interface-design.md#avatars-wherever-a-person-appears--2026-10-12)
shows the photo over the member's initial, which remains while the photo
loads or if it cannot load. `src/server/photos.ts` holds the rules below, and
`tests/app/profile-photos.test.ts` and `tests/browser/profile-photos.spec.ts`
cover them.

**Storage.** Migration `019-profile-photos.sql` adds `profile_photo`, which
stores each photo as `bytea` in Screenr's PostgreSQL database under
`/var/lib/screenr/postgres`, Screenr's data directory. The existing encrypted
backups and the weekly restore check therefore cover photos with no change to
the backup, restore, or service units. A photo is at most 200 KB, and members
are few, so the database stays small. Rows reference the auth user rather
than the profile, so a Google signup's copy exists during setup. A row
without an image records that the member removed their photo. The
`screenr_photo(user_id)` function returns the photo's version, the first 16
hex digits of its SHA-256, which every query that returns a person includes
as `photo`. Blocked people are listed with no photo.

**Uploads.** The browser crops the center square, resizes it to 512×512, and
encodes a JPEG, lowering the quality from 0.86 to 0.06 until it is under
60 KB. That stays within the decided 200 KB maximum and under the 64 KB
request body limit in `ops/Caddyfile`, so the shared Caddy configuration needs
no change. Safari's JPEGs are about twice the size of Chromium's at each
quality and stop shrinking below about 0.1, so a detailed camera photo can
need a low quality. When no 512-pixel JPEG fits, the browser tries 384 and
then 256 pixels. A failure names its step: opening the file, getting a canvas,
or encoding the JPEG. A details line beneath the message gives the file's
reported type and size, its decoded dimensions, the limit, and each attempt's
JPEG size or missing image, but never the file name. Reading
the file through `createImageBitmap` needs no `blob:` or `data:` image URL,
which the [content security policy](deployment.md#provisioning) would block.
The `photo` action receives the JPEG as the raw request body. The server
reads at most 200 KB (413) and accepts only bytes that start with the JPEG
signature, whatever the request's content type says (415). Photo changes
skip the shared write lock because they change no access rules.

**Serving.** `/api/photos/<user ID>/<version>` returns the photo only to a
signed-in person viewing their own photo, including before setup, or to a
member viewing a member whose profile they can open. A
[bearer token](#native-client-sessions) signs in like the cookie. Blocking
hides it in both directions. Other requests get 401 or 404 with `no-store`.
A photo response is `Cache-Control: private, max-age=86400` with
`Vary: Cookie, Authorization`, an `ETag` of its version, and
`Cross-Origin-Resource-Policy: same-origin`. `private` keeps shared caches
from storing it, `Vary` keeps a browser or the app from reusing it for
another signed-in person, and a changed photo has a new URL, so the old one
returns 404. URLs are same-origin, so the policy's `img-src 'self'` covers
them.

**Google pictures.** Screenr fetches a Google picture only from
`lh3.googleusercontent.com` through `lh6`, over HTTPS, requests the
`=s512-c` size, follows at most three redirects within those hosts, and
reads at most 200 KB of JPEG, PNG, or WebP. It never links to Google. It
reads the picture from `user.image`, set by a Google signup, or else from the
`picture` claim of the Google account's stored ID token, for an account
linked after an email-code signup. A `user.image` outside Google's hosts is
ignored, so the URL cannot direct a request elsewhere.

- **Automatic copies:** Better Auth's `account.create.after` hook runs after
  a Google signup or link commits. It copies the picture unless the person
  already has a photo row, including a recorded removal, and the insert never
  replaces one. A failure keeps the initial and logs
  `google photo copy failed` without failing the sign-in.
- **Use my Google photo:** shown with a Google sign-in. It replaces the
  current photo or a removal, and reports a failed copy beside the button.
- **One-time backfill:** after the release with photos deploys,
  `screenr-worker` copies the picture for everyone with a Google account and
  no photo row, one at a time, beside email delivery. It logs each failure
  and then one `google photo backfill finished` line with counts, and records
  `google-photos` in `screenr_backfill` so later starts skip it. A stopped
  pass runs again on the next start. To retry failures, delete that row and
  restart the worker, as in [deployment](deployment.md#failure-logs); a
  retry fetches only for people who still have no photo or removal.

A rollback to a release without photos keeps the table and ignores it;
avatars show initials until the photo release returns.

## Profile friends and suggestions

Profiles include an expandable Friends list for signed-in members, including
when the viewer is not a friend of the profile owner. Each entry links to its
profile. The list contains accepted friends only, filters blocks in either
direction, and counts only the visible people. Profile visibility and the
friend list use one database snapshot. The list refreshes with the profile;
viewing it does not grant access to private activity or pending requests.

A profile's [top 10](profile-top-ten.md#reads-and-ranking) loads for every
signed-in member who can see the profile, including nonfriends, with only
title details and ranks. The Recommend entries behind it and their
discussions keep the friends-only audience, and a blocked profile shows
neither.

The People page includes **People you may know**, based on two accepted
friendships. Each suggestion lists all eligible mutual friends and links to
their profiles. Suggestions exclude the viewer, existing friends, pending
requests in either direction, and blocked people or paths. One query reads
the candidates and mutual friends in one snapshot. Candidates appear once,
ordered by most mutual friends and then username; mutual friends use username
order. The section has an empty state when nobody qualifies. Sending a request
moves the person to Sent requests. Polling, returning to the page,
and relationship actions refresh the section. This discovery route does not
grant access to private activity or change anonymous title suggestions.

## Friends recommend

`src/server/friends-recommend.ts` reads the
[Friends recommend](interface-design.md#friends-recommend-as-a-find-a-title-tab--2026-10-12)
tab in one query. It counts active Recommends from the viewer's current
direct friends: an accepted friendship with no block in either direction,
which also excludes a block left beside a retained friendship. Pending
requests, friends of friends, withdrawn Recommends, Want to watch, watch
statuses, comments, and the viewer's own Recommend count for nothing.

Titles sort by the sum of each recommending friend's contribution, then the
most recent active Recommend, then the title name and ID. Contributions use
the [integer twentieths](profile-top-ten.md#ranking): a Recommend adds 20, or
`40 - rank` when it is in the friend's
[profile top 10](profile-top-ten.md#reads-and-ranking). Each title lists its
friends' usernames, display names, and top 10 ranks, top 10 recommenders
first by rank and then the most recent Recommend first, with the viewer's
current status and whether the viewer recommends it. The
response holds no scores, feed item IDs, or account IDs. The viewer's
statuses do not remove titles from the response. The view hides titles the
viewer marked Finished from that status, so its Show finished switch
([#172](https://github.com/jubishop/screenr/issues/172)) needs no second
read.

## Write lock and refresh behavior

All domain writes take one transaction advisory lock. This makes invitation
capacity and permission changes ordered with content writes. It is a deliberate
small-app simplification; measure lock waits before replacing it. A domain
write waits at most two seconds for this lock or any other lock it needs. It
then changes nothing and returns HTTP 503 with "Screenr is busy. Please try
again." Waiting requests therefore release database connections before the
pool's five-second connection timeout, which session lookups share. The email
worker holds the lock during each activity email send, so a write during a slow
send may need a retry. Page loads, refreshes, and
[usage telemetry](usage-telemetry.md#active-days) don't take the lock. Listing
invitations takes it only to store a missing share link, for an old invitation
or after a secret rotation
([issue #130](https://github.com/jubishop/screenr/issues/130)). Signup
commits the profile, invitation use, signup record, and accepted inviter
friendship in one transaction. A replacement link connects the new member to
the creator of the invitation actually used to finish signup. Existing accounts
are not backfilled. Thread reads use one database snapshot. Open pages poll
every three seconds while visible, waiting for any active refresh to finish,
and refresh when the page becomes visible again. The page load brings the
first screen; the page reads it again on load only after a failed load or on
the not-found view. Successful API reads send a weak `ETag` of their exact
JSON body, including the reader's own profile. Refreshes send back the
version they hold in `If-None-Match`, and an unchanged screen answers 304
without a body. The page then keeps its data and doesn't render again
([issue #138](https://github.com/jubishop/screenr/issues/138)). Responses
stay `Cache-Control: private, no-store` with `Vary: Cookie, Authorization`,
so a version
never answers for another member and no shared cache keeps a screen. Every
refresh still reads the database and checks access. Each refresh
has a ten-second deadline; failure clears server content until a successful
refresh. A permanent error, any 4xx response except 408 and 429, stops polling
until a read succeeds. Until then, only Try again, returning to the page, a
write, or navigation reads again. Timeouts, network failures, rate limits, and
5xx responses keep polling. A missing title, person, page, conversation, or
Watch together responds 404 from both the page and the screen API. The page
keeps the member's navigation, and its first read shows the reason, such as
"Person not found."
([issue #139](https://github.com/jubishop/screenr/issues/139)). Writes and
other requests stop waiting after fifteen seconds, which re-enables their
controls. Better Auth requests, such as email codes, Google sign-in and
linking, and sign-out, share this deadline and its retry messages
([issue #183](https://github.com/jubishop/screenr/issues/183)). While a write
is pending, its button and the others it blocks stay focusable with
`aria-disabled` and ignore presses, and text fields become read-only, so
keyboard focus stays on the pressed control
([issue #142](https://github.com/jubishop/screenr/issues/142)).
`src/components/action-button.tsx` is the shared button; `disabled` remains
only before hydration. Focus stays there after the write, or moves to the
control that replaced it: Watch together after accepting on a profile, the
notification's result, More actions after a profile confirmation closes, or
the Friends page notice after Block. Cancel in a confirmation returns focus to
the action that opened it. Where a successful write removes its button, such
as Delete, focus moves to what takes its place, such as the next item in the
list ([issue #191](https://github.com/jubishop/screenr/issues/191)); see
[removed controls](interface-design.md#confirm-other-destructive-actions--2026-10-12).
Proxy error pages, empty bodies, and other
unreadable replies show a message asking the member to try again instead of
parser errors. A failed write shows its message as an alert beneath the
control that started it, in the same entry, comment, person row, invitation,
or settings card, and the message describes that control
([issue #141](https://github.com/jubishop/screenr/issues/141)). Refreshes
keep it, and the next action in that place replaces it. A failed confirmed
action keeps its confirmation open with the message until Cancel. Only refresh
failures appear at the top of the page. Access changes clear content on the
next refresh without waiting for the New activity button. Previously
delivered content cannot be retracted from a user's device.

## Comment removal

Members can **Delete** their own comments in any feed where the conversation
is accessible. Conversation hosts can also **Remove** other participants'
comments. Both actions ask for an
[in-page confirmation](interface-design.md#confirm-other-destructive-actions--2026-10-12),
then erase the stored text and show a **Comment removed**
placeholder, preserving replies and their addressed-person context. The server
checks ownership and current conversation access on every removal request.
Standalone comment authors can also **Delete** the top-level entry. Its text
becomes **Comment removed** while eligible replies remain open for discussion.
Deleting a [post without a title](title-feed.md#discussion-posts-without-a-title)
works the same way and shows **Post removed**.
Entries without visible, nonremoved replies disappear. The original spoiler
flag still protects the remaining discussion. This behavior is shared across
title, friends, and author-profile feeds, including open-page refreshes.

## Schema migrations

The migration command applies Better Auth's schema and numbered SQL files in
`db/`, in filename order. It takes a migration lock and records each applied
file with a SHA-256 checksum in `screenr_migration`. Future schema changes must
use new numbered files. SQL filenames must match `NNN-name.sql`, with
lowercase letters and hyphens in the name. Each number must be unique, except
for the existing `004` and `006` pairs, which databases applied in different
orders. Before changing anything, the command fails the release when:

- An SQL filename is invalid.
- Two SQL files share a number.
- A pending file sorts before the latest file the database already applied.
- An applied file no longer matches its recorded checksum.

When another branch lands a migration first, rebase and renumber yours after
the latest one on `main`. Otherwise a shared number fails every migration run,
and production rejects a pending file numbered below one it already applied.
Restore an edited applied file and put the change in a new migration. A
disposable development or test database that ran an outdated migration can be
dropped instead; `npm test` and the browser harness create missing databases.
Files applied before checksums existed receive checksums from their current
contents on the next run, without running again. The checksum column stays
nullable so an older release's migration command can still record files; the
next run fills in their checksums. Back up before deploying schema changes.

Activation runs migrations while it holds the deploy lock, so each run bounds
its waits ([issue #119](https://github.com/jubishop/screenr/issues/119)). It
waits at most 30 seconds for any lock, including the migration lock that
another run holds, and cancels any statement that runs longer than 5 minutes.
Either limit rolls back the migration transaction, so no SQL migration is
applied, and the command fails with an error that names the limit. Retry once
the other migration or long transaction finishes; split a data migration that
needs more than 5 minutes per statement. The command restores the
connection's default limits before returning it to the pool. Better Auth's
schema changes run first, on other pool connections, without these limits.

Better Auth's migrations add tables, columns, and indexes but never relax or
remove them. Its 1.7.3 and later releases validate the schema on every
request and reject a required column they never write. Tests start from a
fresh database, so check each Better Auth upgrade guide for steps that
existing databases need. Migration `014-nullable-account-issuer.sql` makes
the `account.issuer` column that Better Auth 1.7.0 through 1.7.2 required
nullable; 1.7.3 and later neither read nor write it. It kept the column and
its `account_issuer_accountId_uidx` index while rollback to 1.7.2 was
possible, because 1.7.2 finds accounts by issuer. Once no retained release
shipped 1.7.2, migration `016-drop-account-issuer.sql` dropped the index and
then the column, following Better Auth's 1.7 upgrade guide. Databases first
created by 1.7.3 or later have neither, so it changes nothing there. A
release that ships 1.7.2 can no longer run against a migrated database.

The same rule applies to Screenr's own schema: drop a column, constraint, or
compatibility trigger only once no retained release depends on it, and use
`IF EXISTS` so databases without it are unchanged. Migration
`020-drop-legacy-conversation-columns.sql` dropped the legacy `conversation`
action flags and activity date this way, and migrations
`023-drop-watch-status-guard.sql` and `026-drop-top-ten-guard.sql` dropped
the watch status and top 10 guard triggers; see
[migration and rollback compatibility](title-feed.md#migration-and-rollback-compatibility).
