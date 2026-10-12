---
status: current
---

# Notifications

Screenr notifies members about friend requests, acceptances, and comments
through a bell panel and optional activity email. This page holds the accepted
notification decisions and describes their implementation. The
[email worker](running-screenr.md#email-worker) and
[provider configuration](running-screenr.md#provider-configuration) describe
email delivery setup.

## Notification triggers — 2026-09-04

**Decision:** At launch, notify users about friend requests and acceptances,
comments on their posts or reviews, and replies to their comments. Watch
updates, ratings, and recommendations appear in the feed without generating
alerts. Notification visibility and previews follow the existing access,
blocking, and spoiler rules.

**Why:** The user accepted notifications focused on these interactions,
with routine viewing activity left in the feed.

## Notification delivery — 2026-09-04

**Decision:** Provide an in-app notification inbox and opt-in email alerts
for the agreed notification triggers. Activity email alerts remain off until
the user enables them. Browser push notifications are outside the initial
release.

**Why:** The user accepted email as a way to notice friend requests and
replies before checking Screenr becomes a habit.

## Notification panel — 2026-09-11

**Decision:** Open notifications from a bell near the Screenr logo or a
similar persistent position. The bell opens a dropdown panel over the
current page, following the interaction shown in the user's Facebook
reference. Keep the current page in place beneath the panel; opening
notifications does not navigate to a separate page.

On desktop, anchor the dropdown to the bell. On phones, open a full-screen
Notifications panel with a clear Close button. Closing either panel returns
the reader to the same page and scroll position, preserving unfinished
comments.

**Why:** The user wants to check notifications in place and explicitly
selected an overlay instead of the proposed full Notifications page.

**Tradeoff:** The panel temporarily covers part of the current content.
The phone layout covers the full screen to provide enough room to read
and select notifications.

## Notification read state — 2026-09-11

**Decision:** Mark an individual notification read when the member selects
it. Provide a **Mark all as read** action. Opening the panel alone does not
mark notifications read. The bell shows the unread count.

**Why:** The user accepted explicit read actions so opening the panel does
not clear notifications they have not selected.

**Tradeoff:** Members must select notifications or use the bulk action to
clear the unread count, even if they have skimmed the list.

## Activity email timing — 2026-09-11

**Decision:** For members who enable activity emails, wait 10 minutes and
combine new notifications that are still unread into one email. Omit
notifications read before delivery. Opening the panel does not prevent an
email unless the member reads the notifications or marks them all read.

**Why:** The user accepted a delay to reduce emails from active
conversations and omit notifications already read in Screenr.

**Tradeoff:** Email alerts arrive later than in-app notifications. Activity
email remains off by default under the existing delivery decision.

## Current implementation

The bell beside the logo shows the current unread count. It opens an anchored
dropdown on desktop and a full-screen panel on phones. Close or Escape returns
to the underlying page without losing its scroll position or comment drafts.
The panel has All and Unread filters and controls for earlier notifications.
Opening it does not mark notifications read. Selecting a notification marks
it read and opens its person or exact title reply. A pending friend request
also shows Accept and Decline; Decline asks for the
[in-page confirmation](interface-design.md#confirm-other-destructive-actions--2026-10-12)
first. Either action marks that notification read and answers only that
request while it is still pending, so a stale Decline cannot end a friendship.
The answered row keeps its result in place of the buttons until the panel
closes or changes view, and selecting it still opens the person.
**Mark all as read** applies
through the newest notification in the displayed snapshot, leaving later
arrivals unread. Older pages and their refreshes keep that boundary; returning
to **Latest notifications** displays new arrivals and updates the boundary.

Migration `010-notifications.sql` creates notification records and transaction
triggers for friendship and comment events. It seeds existing pending friend
requests without sending email. It does not backfill old comments or accepted
friendships. Invited signup creates one new-friend notification for the inviter.
Comments notify their content owner and addressed commenter, excluding the
actor and duplicate recipients. Watch status changes notify no one; comments
on a progress entry notify like comments on other entries. Notifications use current names and access;
they contain no comment text. Withdrawn requests and deleted or inaccessible
comments disappear from lists and counts. Restoring comment access preserves
the notification's read state.

### Activity email

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
Activity jobs expire after 24 hours, or at once when Resend rejects them
permanently; their notifications remain in the app.
The current worker and Resend configuration need no new service or credentials.
