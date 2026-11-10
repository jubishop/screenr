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
rules to threads, cards, and comments. Feed reads apply those rules once per
statement, through the reader's readable owners and each owner's readers,
rather than once per row
([feed implementation](title-feed.md#shared-feed-implementation)). `screenr_friends` lists a person's
friends, each an accepted friendship where neither person has blocked the
other, for profiles, People suggestions, Friends recommend, and Find a title
suggestions; each caller adds its own checks between the viewer and those
friends. `screenr_blocked` also keeps the
[demo circle for Apple review](running-screenr.md#demo-circle-for-apple-review)
and real members apart, and hides a
[suspended member](#member-suspension) from everyone. The title page friend line comes
from the viewer's title feed read, so it names only friends whose entries
that feed shows. Friendship pairs are ordered by
PostgreSQL, including mixed-case auth IDs. No private feed or permission
result is persistently cached; the web process remembers only the version
hash of each feed and profile screen it sent, as the
[refresh behavior](#write-lock-and-refresh-behavior) describes.

## API actions

`/api/screenr/[action]` serves the actions declared in
`src/server/actions.ts`. Each entry names its HTTP method, reads its fields
from the query or JSON body, and calls the services that validate them. Its
result becomes the JSON response; an action without one responds
`{ ok: true }`. The route applies the shared rules in this order:

1. A `Screenr-Client` header must name an iPhone app build at or above the
   minimum (400 or 426); see [client headers](#client-headers).
2. A POST must come from the app's origin (403), unless it carries a
   [bearer token](#native-client-sessions).
3. The request needs a session (401).
4. Every action except profile setup and its
   [details](#invitation-tokens), photo changes, and
   [account deletion](#account-deletion) needs a completed profile (403).
5. An unknown action, or a known one with another method, returns 404.
6. Usage telemetry records the day, with the client that sent the request,
   for member POST actions, photo changes by members, title searches, and
   `screen` reads flagged as the app's visits
   ([active days](usage-telemetry.md#active-days)).
7. A POST body must be a JSON object of at most 16,000 bytes (400 or 413).
   A photo upload's body is the image itself, at most 200 KB.

Add an action as one entry, using `read` for a member GET, `write` for a
member POST, `signup` for a POST that runs before profile setup,
`signupRead` for a GET that runs before it, `photo`
for a photo change, which works before and after setup, or `erasure` for
account deletion, which also works either way and records no usage. Its
`run` receives the user ID, the request's session ID, and the request
headers. Give it an [iPhone API fixture](testing.md#iphone-api-fixtures)
case in the same change.

Each entry keeps its result's type, and `ActionResult<Name>` gives it to the
web ([issue #387](https://github.com/jubishop/screenr/issues/387)). The web
client in `src/components/client.ts` calls actions by name: `api` sends a
write's body, and `read` and `readChanged` send a read's query parameters.
Each returns its action's result type, so `npm run typecheck` fails when a
web reader expects a field that the action no longer returns. Read result
fields by name rather than spreading a result into state, which would hide
a renamed field from the check.

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
  on a post or review covers its whole thread, and a review's flag covers the
  [combined card](title-feed.md#combined-title-actions) it is in. The server
  omits a spoiler's text, so it never reaches the device before the reader
  reveals it.
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

### Shared title links

The iPhone share extension asks `GET /api/screenr/resolve-title?url=…&text=…`
which title a shared link or text names
([issue #252](https://github.com/jubishop/screenr/issues/252)). It is a
member read like `search`: the extension sends the app's bearer token from
the shared Keychain group, so a member without a session gets 401 and one
without a profile 403. It records no usage. The answer is
`{ "title": <title> | null, "query": "…" }`; see
[shared links](title-catalog.md#shared-links) for how each site's links
resolve. The extension then reads the title's `screen` and saves Recommend
and Want to watch with the usual `activity` and `watch-status` actions, with
the `title` save surface.

### Client headers

`src/server/api-route.ts` reads two request headers on every
`/api/screenr` and `/api/photos` request, before the route's own checks
([issue #213](https://github.com/jubishop/screenr/issues/213)):

- **`Screenr-Client: ios/<version>/<build>`:** the iPhone app sends its
  version and its whole-number build, such as `ios/1.4.0/42`. Requests
  without the header, such as the web's, are never gated. A value in another
  form gets 400 with `Invalid client header.` When the server environment
  sets `SCREENR_IOS_MINIMUM_BUILD`, an older build gets HTTP 426 before the
  origin and session checks, with this body:

  ```json
  {"error":"Update Screenr to continue.","minimumBuild":42}
  ```

  The app answers any 426 with its required-update screen. An unset or empty
  minimum serves every build.
- **`Screenr-Request-Id`:** a client may name each request with 1 to 64
  letters, digits, underscores, or hyphens, such as a UUID. Otherwise the
  server generates a UUID. Every response carries the ID in the same header,
  and each [failure log](deployment.md#failure-logs) line written while the
  request runs names it as `requestId`. An app error report and the server
  failure behind it carry the same ID
  ([Sentry decision](ios-app.md#sentry-for-the-app-and-the-server--2026-10-13)).
  The journal has every such line; Sentry may
  [fold](deployment.md#failure-reports-in-sentry) repeated failures into a
  count.

The action route also reads `Screenr-Visit: 1` on `screen` reads. The app
sends it on its first screen read after launch and after each return to the
foreground, and the route records the member's
[active day](usage-telemetry.md#active-days) for it. Other values, and the
header on other actions, are ignored.

### Changes that app builds depend on

Installed iPhone app builds lag the continuously deployed web, so keep
changes to screen payloads and action results additive
([decision](ios-app.md#additive-payloads-and-a-minimum-build--2026-10-13)):

- Add fields or enum values. The app treats new fields as optional and
  decodes an unknown enum value to a fallback.
- Do not remove, rename, or retype a field, change its meaning, or make an
  existing request require a new field.
- Send only the fields that the response's type declares. Select columns by
  name rather than with `*`, so a new column never reaches clients unnoticed.
- Give a new key the casing of the object it joins, and a new object's keys
  camelCase. Responses mix snake_case keys, mostly database column names,
  with camelCase ones, and shipped keys keep their casing
  ([issue #387](https://github.com/jubishop/screenr/issues/387)).

When a breaking change is unavoidable, first ship an app build that reads
the new shape. Then set `SCREENR_IOS_MINIMUM_BUILD` in `/etc/screenr/app.env`
to that build and deploy the change: activation checks the value and
restarts `screenr-web`, so both take effect together.

**Minimum build:** production has required build 5 since 2026-11-09
([issue #554](https://github.com/jubishop/screenr/issues/554)). Build 5 is
the first that shows [combined title-action cards](title-feed.md#combined-title-actions)
and reads a title without `tmdb_id`, so screen payloads and action results
stopped sending it, though the server still stores it
([issue #607](https://github.com/jubishop/screenr/issues/607)). It replaced
build 3, required since 2026-11-05. Build 3 is the first that pages the
friends feed and profiles, so the server stopped sending their whole history
to reads without a window
([paged histories](title-feed.md#paged-histories),
[issue #502](https://github.com/jubishop/screenr/issues/502)). Build 3 also
reads a title's availability without TMDB's raw `providers` lists and
`country`, so title screens stopped sending them
([title availability](title-availability.md#current-implementation),
[issue #510](https://github.com/jubishop/screenr/issues/510)). A later
breaking change raises it to the first build that reads the new shape.

**Raise for combined cards — 2026-11-09, by the owner:** the cards'
payload was additive, so the rule above didn't require this raise. The owner
chose it because older builds put members' reviews at risk. They show only a
card's holding entry, so when another entry holds the card with the viewer's
review, the title header finds no review and offers **Rate or review** with
an empty form. Each member has one review per title, and saving updates it
in place, so rating from that form replaced the review's text. A forced
TestFlight update costs the small invited circle one tap. Rejected: leaving
older builds allowed until TestFlight updates them.

**`tmdb_id` — 2026-11-09:** neither client reads a title's `tmdb_id`, but
builds before 5 require it. The owner chose to drop it at this raise, so
build 5 is the first that reads a title without it
([issue #594](https://github.com/jubishop/screenr/issues/594)). Rejected:
making it optional without holding the raise and dropping it at some later
raise, and keeping it for good. A service's `route_note` needed no raise:
every build decoded it as optional.

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
  bearer header deletes that row and ends only that session. Better Auth
  deletes an expired row only when someone presents it, so the worker's
  periodic cleanup, about once a minute, deletes every expired row with its
  push devices. The privacy policy promises this within a day of expiry.
- **Confirmed sign-out:** Better Auth's sign-out logs a failed session delete
  and still answers 200. Screenr checks for the row afterward: while it
  survives, or when the check itself fails, sign-out answers 500 with "Could
  not sign out. Try again." and sets no cookie. The app keeps its token and
  the browser its cookie, so neither leaves a live session, with its push
  devices, behind a client that looks signed out.

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
    returns 404, and so does Better Auth's OAuth callback for Apple,
    `/api/auth/callback/apple`. Better Auth doesn't tie an OAuth state to its
    provider, so anyone could otherwise bring a web Google sign-in's state
    there and make Screenr send codes to Apple's token endpoint under its
    bundle ID ([issue #457](https://github.com/jubishop/screenr/issues/457)).
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
  not confirm, it throws and keeps the token for a retry, and without the
  Apple settings it throws `AppleSettingsMissing`. In the erase transaction,
  `appleTokenStored` finds any token a sign-in stored meanwhile
  ([account deletion](#account-deletion)). A token sealed
  under an earlier `BETTER_AUTH_SECRET` can never be read or revoked, so it
  logs `apple token unreadable` and skips it. An uninvited
  person's code is never redeemed, so Screenr keeps no token for them.

Rejections answer with a JSON body naming a `code` from Better Auth or a
`message` from Screenr:

| Status | Body                                                                      | Cause                                                                                                        |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 401    | `code` `INVALID_TOKEN`                                                    | The signature, issuer, audience, expiry, age, or nonce check failed.                                         |
| 403    | `message` "A valid invitation is required to join Screenr."               | A new person had no valid invitation.                                                                        |
| 403    | `code` `ACCOUNT_SUSPENDED` and Screenr's `message`                        | The owner [suspended](#member-suspension) the account.                                                       |
| 401    | `code` `OAUTH_LINK_ERROR`                                                 | The address belongs to an account without this provider ID linked.                                           |
| 400    | `message` "Sign in with Apple needs its authorization code."              | No `additionalData.authorizationCode`.                                                                       |
| 401    | `message` "Apple did not confirm this sign-in. Try again."                | Apple rejected the code, which expires after five minutes and works once, or it belongs to another Apple ID. |
| 503    | `message` "Sign in with Apple is unavailable right now. Try again later." | Apple's token endpoint failed or rejected Screenr's key. The failure is logged.                              |
| 404    | `code` `PROVIDER_NOT_FOUND`                                               | The server has no settings for the provider.                                                                 |
| 417    | `code` `LINKING_FAILED`                                                   | A new Apple link whose code was not redeemed.                                                                |

Linking keeps Better Auth's other errors, such as `UNAUTHORIZED` without a
session and `LINKING_DIFFERENT_EMAILS_NOT_ALLOWED`.

The `/account` screen reports `appleEnabled` and `appleConnected` beside
`googleEnabled` and `googleConnected`, so the app's Settings offer Connect
Apple only while Apple can be linked. A rejected link answers 401 like a
rejected sign-in, but the member is still signed in, so the app ends its
session only for the `UNAUTHORIZED` code
([Settings](../ios/README.md#settings)).

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
remaining, must be neither expired nor revoked, and its creator must not be
[suspended](#member-suspension).

- **Code request:** an address without an account gets a code only with a
  valid invitation. Otherwise nothing is sent, and the response is the same
  `200` with `{"success": true}` that a member's address gets, so it never
  reveals which addresses have accounts. A request past the new addresses'
  [daily budgets](running-screenr.md#provider-configuration) gets that same
  answer and no code.
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

Because a code request answers the same either way, the app asks about each
link it opens, as the web's `/join` route checks it
([issue #228](https://github.com/jubishop/screenr/issues/228)).
`GET /api/auth/invitation?token=<token>`, a Better Auth endpoint in
`src/server/auth.ts`, answers `{"available": true}` or `{"available": false}`
with `Cache-Control: private, no-store`. It needs no session, uses nothing
up, and reveals nothing that `/join` does not: the web's join page names no
inviter, so neither does the answer. A malformed token is unavailable. Better
Auth's per-client rate limit allows ten checks a minute. The app keeps the
token in the Keychain until setup succeeds, checks a kept token again at
launch, and forgets one the server reports unavailable
([iPhone setup](../ios/README.md#invitations-and-setup)).

Setup in the app starts from `GET /api/screenr/setup-details`, which works
before the profile exists and answers what the web's setup page reads:
`{"userId", "name", "photo", "google"}`. `name` is the name the sign-in gave
the account, such as Google's or Apple's, or empty; `photo` is the photo
version, such as a Google signup's copy, or `null`; and `google` says
whether a Google account can supply a photo.

### Invitation pickup

On an iPhone without the app, an invitation link goes to install it
([decision](ios-app.md#invitation-links-install-the-app-on-iphone--2026-11-07)),
and an install carries no link into the app. So the app picks up the
invitation that `/join` saved in Safari's `screenr-invite` cookie:

- **The link:** for a valid invitation and no session, `/join/<token>` sets
  the cookie as on any device. When the request's User-Agent names an iPhone
  and production sets `SCREENR_IPHONE_INSTALL_URL` to an https URL, it then
  redirects there instead of to `/login`. An iPad's Safari presents itself as
  a Mac, so it keeps the web's join, as do invalid or used-up invitations and
  signed-in visitors.
- **The pickup:** `GET /api/invitation-pickup`, in
  `src/app/api/invitation-pickup/route.ts`, reads the cookie and redirects to
  `/api/invitation-pickup/done?token=<token>`, or to the bare callback when
  there is no well-formed token. It clears any cookie it found, so an
  invitation is picked up once, and answers with
  `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`. It
  checks nothing in the database; the app checks the token with
  `GET /api/auth/invitation` like a link's.
- **Only Screenr receives it:** the app opens the pickup in a shared
  `ASWebAuthenticationSession`, which sees Safari's persistent cookies, with
  an https callback on screenr.club. iOS hands that callback, without loading
  it, only to an app the domain's `apple-app-site-association` lists under
  `webcredentials`: the Release app. A custom URL scheme would let another
  app claim the callback. A browser that loads the callback itself is sent on
  to `/`.

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
  devices, and an unknown token changes nothing. The app removes its device
  when the member turns Screenr's notifications off in iOS Settings; signing
  out needs no request, since deleting the session deletes its devices.
- **Save settings:** `push-settings` with one or more of `friendRequest`,
  `friendAccepted`, `comment`, and `reply`, each a boolean, responds
  `{"pushSettings": {...}}` with all four. Kinds the body leaves out keep
  their values.

Two helpers read and clean up the records. `removePushDevice(token,
client?)` deletes a token that APNs rejects, and `pushSettings(userId)` reads
the settings. The worker applies the session and setting rules when it
sends; see [push delivery](notifications.md#push-delivery).

## Sign-in return path

A signed-out visit to a member page redirects to `/login?next=` with that
page's path, and a 401 API reply sends the open page there the same way, so
links in activity email and shared discussion links survive sign-in
([issue #134](https://github.com/jubishop/screenr/issues/134)). Email-code
sign-in and the Google callback continue to `/setup?next=`, which sends a
member with a profile on to the path and sends a new member there after
signup. A failed Google attempt returns to the sign-in page with the same
path. The sign-in page drops a one-time result, such as that failure, an
unavailable invitation, or a deleted account, from its address once it shows
it, keeping `next`, so a reload omits it
([issue #362](https://github.com/jubishop/screenr/issues/362)).
`returnPath` in `src/member-routes.ts` accepts only a root-relative path
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
The iPhone app prepares a photo the same way with ImageIO and drops its
metadata ([profile photos](../ios/README.md#profile-photos)).
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
returns 404. A request whose `If-None-Match` names the version gets 304
after the same access check, which reads the photo's row without its image
([issue #375](https://github.com/jubishop/screenr/issues/375)); only a 200
reads the image. URLs are same-origin, so the policy's `img-src 'self'`
covers them.

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
- **One-time backfill:** after the release with photos deployed,
  `screenr-worker` copied the picture for everyone with a Google account and
  no photo row. Production's pass finished on 2026-10-12 and recorded
  `google-photos` in `screenr_backfill`, so the worker no longer runs it. The
  table stays, unused.

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
tab in one query, the top 50 titles that pass the read's
[filters](title-suggestions.md#implementation). It counts active Recommends from the viewer's current
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
response holds no scores, feed item IDs, or account IDs. Without filters, as
iPhone builds from before
[#448](https://github.com/jubishop/screenr/issues/448) read it, the viewer's
statuses do not remove titles, and the app hides titles the viewer marked
Finished from that status for its Show finished switch
([#172](https://github.com/jubishop/screenr/issues/172)). The web and later
iPhone builds read with `finished=hidden` while the switch is off, so
finished titles leave the list before the cap, and the screen adds
`finishedRecommendations`, how many it left out, for the empty message.
Turning the switch on reads again. The iPhone's Friends recommend shortcuts
read the same way. Every read also adds `recommendationCount`, how many
titles pass its filters, including those past the cap, so "What do my
friends recommend?" can say exactly how many titles remain after the ones
it names ([#489](https://github.com/jubishop/screenr/issues/489)).

## Write lock and refresh behavior

All domain writes take one transaction advisory lock. This makes invitation
capacity and permission changes ordered with content writes. It is a deliberate
small-app simplification; measure lock waits before replacing it. A domain
write waits at most two seconds for this lock or any other lock it needs. It
then changes nothing and returns HTTP 503 with "Screenr is busy. Please try
again." Waiting requests therefore release database connections before the
pool's five-second connection timeout, which session lookups share. The email
worker holds the lock only while it chooses an activity email and builds it
from current data, and takes it only when one could be due. It calls Resend
with no lock held, so a slow send never delays a write
([send without the lock](notifications.md#activity-email-sends-without-the-write-lock--2026-11-01)).
Page loads, refreshes, and
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
document's first screen; the page reads it again on load only after a failed
load or on the not-found view. Each later screen, reached by client
navigation, reads at once: Back and Forward restore a copy cached before
later changes, and an unchanged screen answers 304
([issue #362](https://github.com/jubishop/screenr/issues/362)). Successful
API reads send a weak `ETag` of their exact
JSON body, including the reader's own profile. Refreshes send back the
version they hold in `If-None-Match`, and an unchanged screen answers 304
without a body. The page then keeps its data and doesn't render again
([issue #138](https://github.com/jubishop/screenr/issues/138)). Responses
stay `Cache-Control: private, no-store` with `Vary: Cookie, Authorization`,
so a version
never answers for another member and no shared cache keeps a screen. Every
refresh still reads the database and checks access, or for an unchanged feed
or profile, the change mark that every access change moves.

An unchanged poll of the friends feed or a profile answers 304 without
building the screen
([issue #373](https://github.com/jubishop/screenr/issues/373)). Every write
to a table those screens read, access included, advances one database-wide
change mark through a trigger (`db/040-screen-changes.sql`); a catalog
refresh counts only when it changes a title's name, kind, poster, or release
date. For each reader and screen path, the web process
(`src/server/screen-versions.ts`) remembers the version of the body it last
sent, with the mark it read before reading anything that body holds. A poll
that holds that version while the mark stands gets 304 after reading only
the mark; one that lands after a write builds the screen and compares its
body as before. The version stays a hash of the body, so a client sees only
the speed, and nothing about other members' writes. A restart forgets the
remembered versions. Other screens can change without a write, through the
catalog or the date, so they always build. A table that a feed or profile
read starts reading needs the trigger too; `tests/app/screen-refresh.test.ts`
fails until it has one. Each refresh
has a ten-second deadline; failure clears server content until a successful
refresh. A permanent error, any 4xx response except 408 and 429, stops polling
until a read succeeds. Until then, only Try again, returning to the page, a
write, or navigation reads again. Timeouts, network failures, rate limits, and
5xx responses keep polling. A missing title, person, page, conversation,
Watch together, or [Want to watch page](want-to-watch.md) responds 404 from
both the page and the screen API. The page
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
([issue #142](https://github.com/jubishop/screenr/issues/142)). An action
that opens another page, such as sign-in, email verification, joining,
sign-out, or account deletion, stays pending until that page loads, so a
second press can't resend a used code or repeat the action
([issue #362](https://github.com/jubishop/screenr/issues/362)).
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
parser errors. A failed write shows its message beneath the control that
started it, in the same entry, comment, person row, invitation, or settings
card ([issue #141](https://github.com/jubishop/screenr/issues/141)). Refreshes
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
A member who [deletes their account](#account-deletion) leaves the same
placeholder, without an author, for each of their comments that has replies.

## Content reports

Members report another member's post, comment, review, or profile for the
owner to review, on the web and in the iPhone app
([decision](product-brief.md#reports-review-and-suspension--2026-11-09),
[issue #555](https://github.com/jubishop/screenr/issues/555)).
`src/server/reports.ts` holds the rules and `src/server/owner-alerts.ts` the
alerts; `tests/app/reports.test.ts` and `tests/browser/reports.spec.ts` cover
them. A comment is a standalone title comment or a reply, and a profile
report covers the display name and photo.

- **Action:** `POST /api/screenr/report` names an entry as `item`, a reply as
  `item` and `reply`, or a profile as `person`, a user ID, with a `reason`
  and an optional `note` of at most 500 characters. The reasons are
  `reportReasons` in `src/shared.ts`, which migration
  `042-content-reports.sql` also enforces; the iPhone app checks its list
  against `rules/report-reasons.json`
  ([fixture layout](testing.md#fixture-layout)). The reporter must see the
  item as their feeds show it, and can't report their own, a deleted or
  removed item, or another kind of entry, such as a Recommend or a status. A
  review in a [combined card](title-feed.md#combined-title-actions) is
  reported by its own ID. A second open report of the same item changes
  nothing and sends no alert. Each member can send 10 reports a day; the
  next answers 429.
- **What a report keeps:** the reporter, the author, the reason, the note,
  and what the reporter saw: an entry's or reply's text, a review's rating,
  the title it is about, or a profile's display name and photo. The review
  page shows that copy even after the author edits or deletes the item. A
  report goes with either member's [account](#account-deletion), and with its
  item when erasure deletes the item.
- **Hidden from the reporter:** feeds read the reader's reports with their
  blocks, once per statement. They leave out an entry the reader reported,
  with the card it is in, and show a reported reply as unavailable, as they
  do a blocked author's; replies beneath it remain. The bell leaves out
  notifications about the reply or about replies on the entry, and the
  reporter's badge updates. A reported profile stays visible; blocking is how
  a member hides a person.
- **Clients:** on the web, another member's post, standalone comment, or
  review, or a card holding a review, shows a flag button, "Report post",
  "Report comment", or "Report review", at the end of its actions, beside the
  copy link on compact entries. Another member's reply shows Report after
  Reply, and a profile's More actions adds Report after Block. Report opens a
  form beneath the action, with the six reasons, "Add details (optional)",
  and "Screenr’s owner reviews every report within 24 hours." A failure keeps
  it open with the server's message. Once sent, it offers to block the
  author, "Thanks for reporting. Screenr’s owner will review it. Block … too?",
  with Block and Not now; the offer stays after the report hides the item.
  Block from a profile opens Friends as [Block](interface-design.md#profile-actions-menu-with-confirmation--2026-10-12)
  does. The iPhone app offers the same actions, with the form in a sheet and
  the offer in a confirmation ([iPhone app](../ios/README.md)).
- **Owner review:** the website's `/reports` page serves only the account
  that `SCREENR_OWNER_EMAIL` names. Signed-out visitors go to sign-in, as for
  an unknown member path, and every other member gets the member pages'
  "Page not found." with HTTP 404. It lists open reports, newest first, with
  the item's kind, author, reporter, reason, note, what the reporter saw, and
  whether its author has since deleted it. **Remove** asks for an
  [in-page confirmation](interface-design.md#confirm-other-destructive-actions--2026-10-12),
  then hides the item from everyone, its author included, as the author's own
  removal does: a post or comment shows "Post removed" or "Comment removed"
  for any replies, a review loses its rating and text, and a profile loses its
  photo and shows its username as its display name. Removal resolves every
  open report of the item. **Dismiss** resolves only that report.
  **Suspend** [suspends the author](#member-suspension) and leaves the
  report open, marked "… is suspended.", for Remove or Dismiss. Resolved
  reports keep their copy. The page's actions post
  `{"report": id, "action": "remove" | "suspend" | "dismiss"}` to
  `/api/reports`, which takes only the website's origin and the owner's
  session and answers 404 to anyone else; the kept photo comes from
  `/api/reports/photo/<report>`. A new action adds an entry to
  `reviewActions` in `src/server/reports.ts` and to `actionsFor` in
  `src/components/report-review.tsx`.
- **Alerts:** each new report queues one email to `SCREENR_OWNER_EMAIL` and,
  with `PUSHOVER_API_KEY` and `PUSHOVER_USER_KEY`, one Pushover alert, in the
  report's transaction. Both link to the review page and say only that a
  member reported a post, comment, review, or profile, with no names or
  member content. The email is an encrypted `email_job`, which the worker
  sends with Resend before activity email, as it does codes, retrying until
  it expires after a day. The worker's alert loop sends the Pushover job
  through Pushover's [message API](https://pushover.net/api), retrying
  failures with backoff until it expires after 24 hours; a 4xx answer other
  than 429 is final, and each failure logs `pushover delivery failed`.
  Without either Pushover setting the worker prints `pushover delivery off`
  once and the web queues no Pushover jobs; without `SCREENR_OWNER_EMAIL`
  nobody can open the review page and no email is queued. See
  [production settings](deployment.md#provisioning).

## Member suspension

The owner suspends a reported member from the review page and lifts the
suspension there later
([decision](product-brief.md#reports-review-and-suspension--2026-11-09),
[issue #556](https://github.com/jubishop/screenr/issues/556)).
`src/server/suspensions.ts` holds the rules, migration
`043-member-suspension.sql` the table and the access rule, and
`tests/app/suspensions.test.ts` and `tests/browser/reports.spec.ts` cover
them. A suspension is a `member_suspension` row with its start. Apart from
ending the member's sessions, it deletes nothing, so lifting it restores
everything else.

- **Suspend:** Suspend on a report, after an
  [in-page confirmation](interface-design.md#confirm-other-destructive-actions--2026-10-12)
  that says what it does, suspends the report's author. It ends all their
  sessions, on the web and in the iPhone app, with the push devices those
  sessions registered, and queues badge updates for members whose unread
  notifications it hides. The owner can't suspend their own account. The
  report stays open, and every open report of the author shows "… is
  suspended." with Remove and Dismiss, and their name without a link to the
  profile, which the owner can't open either.
- **Sign-in:** every method refuses a suspended member after it confirms
  who they are: the email code, Google, and Sign in with Apple, on the web and
  in the app. Better Auth's session hook in `src/server/auth.ts` answers 403
  with `{"code": "ACCOUNT_SUSPENDED", "message": "Your Screenr account is
  suspended. To ask about it, email screenr@jubishop.com."}`, which both
  clients show as it is. The web's Google sign-in returns to `/login` with
  `?error=ACCOUNT_SUSPENDED`, and the page shows the same message. A code
  request answers as for anyone, so it never reveals a suspension. Suspending
  holds the account's row while it deletes the sessions, and a trigger on
  `session` waits for it and refuses a suspended member's new session, so a
  sign-in already past the hook's check can't keep one.
- **Signing up again:** the address still belongs to the suspended account,
  so an invitation to it, on either client, reaches only that account and is
  refused. A suspended member's own invitation links can't be used by anyone
  while the suspension lasts.
- **Hidden from everyone:** `screenr_blocked` treats a suspended member as
  blocked by everyone, and everyone by them, so every read and write that
  checks blocks hides them: their profile and photo, feed entries of every
  kind, including Recommend, Want to watch, and statuses, their replies and
  reactions, notifications they caused, friend lists and requests,
  suggestions, and their part in Find's counts. The feed's own `hidden` set
  includes every suspended member too, and blocked lists leave them out.
  Nobody can reply to, react to, or befriend them meanwhile. Their
  friendships, blocks, and content stay, and show again once lifted.
- **Lift:** the review page lists suspended members, most recently
  suspended first, with when each began and **Lift**, which posts
  `{"member": userId, "action": "lift"}` to `/api/reports` under the same
  owner-only rules and restores the member and their content for everyone.
  The member then signs in again.
- **Records:** a suspension goes with its member's
  [account](#account-deletion). The member can still email the owner, which
  the refusal says.

## Account deletion

Members delete their own account from Account on the web, and the iPhone
app uses the same action
([decision](product-brief.md#account-deletion--2026-10-13),
[issue #236](https://github.com/jubishop/screenr/issues/236)).
`src/server/account-deletion.ts` holds the rules;
`tests/app/account-deletion.test.ts` and
`tests/browser/account-deletion.spec.ts` cover them.

- **Fresh sign-in:** `POST /api/screenr/delete-account` with `{}` needs a
  session created in the last ten minutes, the same window as Better Auth's
  `freshAge`. An older session gets 403 with "To delete your account,
  confirm it’s you again with a new sign-in." and nothing changes. The
  action works with or without a completed profile, records no usage, and
  responds `{"ok": true}`.
- **Web:** Delete account on Account emails a sign-in code to the address
  the account screen reports as `email`. Entering it signs this browser in
  again, which starts the fresh session; an
  [in-page confirmation](interface-design.md#confirm-other-destructive-actions--2026-10-12)
  then asks before deleting. Code requests count toward the usual
  [login-code limits](running-screenr.md#provider-configuration). A failed
  account read keeps the step in progress with the last known address, and
  its actions wait for the next read, so a confirmed code is never lost. The
  confirmed deletion stops the page's refreshes before it is sent, since a
  read answered after it would open sign-in without the result, and its
  action stays pending until the sign-in page loads with "Your Screenr
  account was deleted." That page then drops the result from its address,
  so a reload omits it.
- **iPhone app:** Delete account in You → Settings signs in again with an
  email code to the account's address or a sign-in method connected to the
  account, without an invitation. The app keeps the new bearer token only
  when the sign-in response's `user.id` is the signed-in member, and sends
  the request with it; a sign-in that reaches another account is signed out
  again, so it can never delete that account. A confirmation then asks
  before deleting. Success ends the session: the app removes its token and
  any kept invitation from the Keychain, empties its caches, and returns to
  sign-in with "Your Screenr account was deleted." A 403 asks for a new
  sign-in, and the 503 keeps the confirmation to try again
  ([Settings](../ios/README.md#account-deletion)).
- **Apple:** deletion first calls `revokeAppleTokens`
  ([Apple tokens](#native-sign-in)). Apple requires revocation, and the
  tokens live in the rows deletion erases, so when Apple does not confirm,
  deletion logs `apple revoke failed`, erases nothing, and responds 503 with
  "Sign in with Apple could not be disconnected, so your account was not
  deleted. Please try again later." A retry revokes the kept token.
- **Missing Apple settings:** without the
  [Sign in with Apple settings](running-screenr.md#iphone-app-accounts-and-keys),
  no token can be revoked, so deleting an account with a readable Apple token
  logs `apple settings missing`, erases nothing, and responds 503 with "Sign
  in with Apple is unavailable right now, so your account was not deleted.
  Please try again later." Accounts without one are deleted as usual.
- **Apple sign-in during deletion:** a sign-in while revocation runs can store
  a newer token. The erase transaction first locks the user row and the Apple
  account rows; if a readable token remains, it erases nothing and deletion
  revokes again. After three rounds deletion logs `apple token replaced` and
  responds with the same 503 as when Apple does not confirm.

One transaction under the [write lock](#write-lock-and-refresh-behavior)
then erases the person with `eraseAccounts`:

- **Entries:** their Recommends, Want to watch, watch statuses, reviews,
  standalone comments, posts, and top 10 go, each with its whole
  conversation, including other members' replies and reactions.
- **Comments elsewhere:** a top-level comment of theirs with someone else's
  nonremoved reply becomes a "Comment removed" placeholder with no author, so
  the replies remain. Their other comments go, along with removed replies
  beneath them. Replies that addressed them no longer name anyone.
- **Connections:** friendships and requests, blocks in both directions, and
  their invitations go. So do the signup records of people who joined through
  those invitations; those members keep their accounts.
- **Sign-in data:** in Better Auth's `verification` table, pending sign-in,
  email verification, and password reset codes, matched by their exact
  identifiers, `<type>-otp-<address>`, so a code for another address that
  contains theirs stays; and sign-in states whose value names their user ID,
  such as a Google link in progress. Also queued code emails, which name the
  address only by a hash.
- **The account:** deleting the `user` row cascades to the profile with its
  settings, push settings, and demo flag, and to the photo, sessions, push
  devices, sign-in accounts, saved services, notifications, reactions, usage
  rows, activity emails, and [reports](#content-reports) they made or that
  name them as the author, with any pending Pushover alerts. Other members whose unread count drops get a
  [badge-only update](notifications.md#badge-only-updates).

Rows that limit code requests hold only a hash of the address and expire
within a day, so they stay and keep limiting requests. Afterward the address
can join again only with a valid invitation, like anyone new. Deleted data
stays in [encrypted backups](deployment.md#account-deletion-and-backups)
until they expire. After the transaction commits, deletion prints one
`screenr-web` journal line, `{"event":"account deleted","userId":"..."}`,
with no other personal data. After a restore,
`scripts/delete-accounts.ts` reads those lines to
[erase the accounts again](restore-and-patching.md#repeat-account-deletions).
Reseeding the
[demo circle](running-screenr.md#demo-circle-for-apple-review) removes the
previous demo accounts with the same erasure.

Migration `030-account-deletion.sql` lets a removed comment have no author.
Feeds show such a placeholder with `author_id`, `username`, `display_name`,
and `photo` null, `removed` true, and `unavailable` false, and the web
labels it "Comment removed". The previous release leaves it out of
conversations, as if it had no replies.

Erasure holds the write lock, and PostgreSQL checks each foreign key once
per deleted row, so every comment and notification key that erasure deletes
or checks by has an index: reply roots, authors, addressed people, and
notifications' comments (migration `035-erasure-indexes.sql`,
[issue #374](https://github.com/jubishop/screenr/issues/374)). Without them,
each deleted comment read the whole comment table. Erasing a member with 870
comments from a synthetic circle of 33,500 took about 2 seconds without them
and under 0.3 seconds with them. The account deletion test erases with
sequential scans disabled and fails if any step still reads comments,
notifications, or a table that refers to them in full. Index any new column
that erasure deletes or updates through, and any new foreign key to a
comment.

`tests/app/account-deletion.test.ts` reads from the schema every column whose
foreign keys lead to a person, and every text column, so its checks cover
new tables. Give its departing member rows in any new table that refers to
members.

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
needs more than 5 minutes per statement. The command then closes its
connection, which drops these limits and releases the migration lock only if
the run held it, so no cleanup can fail and hide the run's own error
([issue #358](https://github.com/jubishop/screenr/issues/358)). Better Auth's
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

Better Auth also checks its tables when an instance starts. The migration
command turns that check off for the instance it plans with, since it would
report the tables and columns the command is about to add, such as every
table of a fresh database. Once every migration has run, the command runs
Better Auth's check itself and prints a mismatch that remains, such as a
required column Better Auth never writes, as Better Auth's
`Database schema mismatch` error line, without failing. Better Auth 1.7.10
also warned on every run that its own `bigint` column `rateLimit.lastRequest`
had a different type, which 1.7.11 fixed
([issue #459](https://github.com/jubishop/screenr/issues/459)).

The same rule applies to Screenr's own schema: drop a column, constraint, or
compatibility trigger only once no retained release depends on it, and use
`IF EXISTS` so databases without it are unchanged. Migration
`020-drop-legacy-conversation-columns.sql` dropped the legacy `conversation`
action flags and activity date this way, and migrations
`023-drop-watch-status-guard.sql` and `026-drop-top-ten-guard.sql` dropped
the watch status and top 10 guard triggers; see
[migration and rollback compatibility](title-feed.md#migration-and-rollback-compatibility).
