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
(Recommend and [watch statuses](title-feed.md#watch-progress-entries)),
`reviews.ts` ([ratings and reviews](title-feed.md#reviews)), `comments.ts`,
and `reactions.ts`. PostgreSQL functions
`screenr_can_read` and `screenr_blocked` apply the same current relationship
rules to threads, cards, and comments. The title page friend line comes
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

1. A POST must come from the app's origin (403).
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
for a photo change, which works before and after setup.

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
encodes a JPEG, lowering the quality until it is under 60 KB. That stays
within the decided 200 KB maximum and under the 64 KB request body limit in
`ops/Caddyfile`, so the shared Caddy configuration needs no change. Reading
the file through `createImageBitmap` needs no `blob:` or `data:` image URL,
which the [content security policy](deployment.md#provisioning) would block.
The `photo` action receives the JPEG as the raw request body. The server
reads at most 200 KB (413) and accepts only bytes that start with the JPEG
signature, whatever the request's content type says (415). Photo changes
skip the shared write lock because they change no access rules.

**Serving.** `/api/photos/<user ID>/<version>` returns the photo only to a
signed-in person viewing their own photo, including before setup, or to a
member viewing a member whose profile they can open. Blocking hides it in
both directions. Other requests get 401 or 404 with `no-store`. A photo
response is `Cache-Control: private, max-age=86400` with `Vary: Cookie`, an
`ETag` of its version, and `Cross-Origin-Resource-Policy: same-origin`.
`private` keeps shared caches from storing it, `Vary: Cookie` keeps a
browser from reusing it for another signed-in person, and a changed photo
has a new URL, so the old one returns 404. URLs are same-origin, so the
policy's `img-src 'self'` covers them.

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

The People page includes **People you may know**, based on two accepted
friendships. Each suggestion lists all eligible mutual friends and links to
their profiles. Suggestions exclude the viewer, existing friends, pending
requests in either direction, and blocked people or paths. One query reads
the candidates and mutual friends in one snapshot. Candidates appear once,
ordered by most mutual friends and then username; mutual friends use username
order. The section has an empty state when nobody qualifies. Sending a request
moves the person to Sent requests. Polling, focus changes,
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
the [integer twentieths](profile-top-ten.md#ranking): each Recommend adds 20
until the profile top 10
([#99](https://github.com/jubishop/screenr/issues/99)) replaces a top 10
Recommend's 20 with `40 - rank` and adds ranks beside names. Each title lists
its friends' usernames and display names, most recent Recommend first, with
the viewer's current status and whether the viewer recommends it. The
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
every three seconds while visible,
waiting for any active refresh to finish, and refresh on focus. Each refresh
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

The same rule applies to Screenr's own schema: drop a column or constraint
only once no retained release reads or writes it, and use `IF EXISTS` so
databases without it are unchanged. Migration
`020-drop-legacy-conversation-columns.sql` dropped the legacy `conversation`
action flags and activity date this way; see
[migration and rollback compatibility](title-feed.md#migration-and-rollback-compatibility).
