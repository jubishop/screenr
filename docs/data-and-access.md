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
`relationships.ts`, `feed.ts` (the shared feed read path), `title-actions.ts`,
`comments.ts`, and `reactions.ts`. PostgreSQL functions
`screenr_can_read` and `screenr_blocked` apply the same current relationship
rules to threads, cards, and comments. Friendship pairs are ordered by
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
3. Every action except profile setup needs a completed profile (403).
4. An unknown action, or a known one with another method, returns 404.
5. Usage telemetry records the day for member POST actions and title searches
   ([active days](usage-telemetry.md#active-days)).
6. A POST body must be a JSON object of at most 16,000 bytes (400 or 413).

Add an action as one entry, using `read` for a member GET, `write` for a
member POST, or `signup` for a POST that runs before profile setup.

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
refresh. Writes and other requests stop waiting after fifteen seconds, which
re-enables their controls. Proxy error pages, empty bodies, and other
unreadable replies show a message asking the member to try again instead of
parser errors. A failed write shows its message as an alert beneath the
control that started it, in the same entry, comment, person row, invitation,
or settings card, and the message describes that control
([issue #141](https://github.com/jubishop/screenr/issues/141)). Refreshes
keep it, and the next action in that place replaces it. A failed Unfriend or
Block keeps its confirmation open with the message until Cancel. Only refresh
failures appear at the top of the page. Access changes clear content on the
next refresh without waiting for the New activity button. Previously
delivered content cannot be retracted from a user's device.

## Comment removal

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
