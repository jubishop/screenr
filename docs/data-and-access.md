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
release. `src/server/social.ts` owns shared reads and writes. PostgreSQL functions
`screenr_can_read` and `screenr_blocked` apply the same current relationship
rules to threads, cards, and comments. Friendship pairs are ordered by
PostgreSQL, including mixed-case auth IDs. No private feed or permission
result is persistently cached.

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
moves the person to the existing pending-request list. Polling, focus changes,
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
send may need a retry. Page loads and refreshes don't take the lock. Listing
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
parser errors. Access changes clear content on the next refresh without
waiting for the New activity button. Previously delivered content cannot be
retracted from a user's device.

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

Better Auth's migrations add tables, columns, and indexes but never relax or
remove them. Its 1.7.3 and later releases validate the schema on every
request and reject a required column they never write. Tests start from a
fresh database, so check each Better Auth upgrade guide for steps that
existing databases need. Migration `014-nullable-account-issuer.sql` makes
the `account.issuer` column that Better Auth 1.7.0 through 1.7.2 required
nullable; 1.7.3 and later neither read nor write it. The column and its
`account_issuer_accountId_uidx` index remain while rollback to 1.7.2 is
possible, because 1.7.2 finds accounts by issuer. Accounts that 1.7.3 or later
creates or links have no issuer, so 1.7.2 would not recognize them. A later
migration can drop the index and then the column.
