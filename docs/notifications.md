---
status: current
---

# Notifications

Screenr notifies members about friend requests, acceptances, and comments
through a bell panel, optional activity email, and iPhone push notifications.
This page holds the accepted notification decisions and describes their
implementation. The [email worker](running-screenr.md#email-worker) and
[provider configuration](running-screenr.md#provider-configuration) describe
email delivery setup, and [push delivery](#push-delivery) describes the
pushes.

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
it read and opens its person or exact title reply. A reply on a
[post without a title](title-feed.md#discussion-posts-without-a-title) opens
on the friends feed instead. A pending friend request
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
The open panel reads its page every three seconds while visible and when the
page becomes visible again. Each poll sends the version of the page it shows,
and an unchanged page answers 304 without a body, so the panel keeps its list,
paging, and boundary without rendering again
([issue #199](https://github.com/jubishop/screenr/issues/199)). Changing the
view or a failed read clears the version, so the next read is whole.

The iPhone app's bell, at the root of every tab, opens the same panel as a
sheet over the current screen
([bell decision](ios-app.md#bell-in-every-tab-and-find-as-the-search-tab--2026-10-13),
[issue #235](https://github.com/jubishop/screenr/issues/235)). It has the
same filters, pages, boundary, polling, and friend request controls, with
the system's confirmation for Decline. Selecting a notification closes the
sheet and opens its item on the current tab, or a feed entry on Circle; a
failed action shows its message in an alert. The
[iPhone guide](../ios/README.md#notifications-sheet) describes the code.

Migration `010-notifications.sql` creates notification records and transaction
triggers for friendship and comment events. It seeds existing pending friend
requests without sending email. It does not backfill old comments or accepted
friendships. Invited signup creates one new-friend notification for the inviter.
Comments notify their content owner and addressed commenter, excluding the
actor and duplicate recipients. Watch status changes and reviews notify no
one; comments on a progress entry, review, or post without a title notify like
comments on other entries. Migration `024-discussion-posts.sql` finds a post's
owner for the trigger and the visible list. Notifications use current names
and access. The bell and activity email contain no comment text; the iPhone
push extension's
[single notification read](data-and-access.md#single-notification-read) adds
a short excerpt, except for spoilers. Withdrawn requests and deleted or
inaccessible comments disappear from lists and counts. Restoring comment
access preserves the notification's read state.

### Activity email

Members enable **Email me about new activity** in Account. The setting is off
by default. Only events created while it is on enter the email queue. After
the first pending event is 10 minutes old, the existing worker groups pending
events into one job. It sends only events still unread and accessible, using
the member's verified email address. Turning the setting off cancels queued
and unqueued activity emails; turning it back on does not send an old backlog.
While a change saves, the checkbox shows the new choice and ignores further
changes; a failed save restores the saved setting and shows the error.

Activity jobs store notification references, with message text generated from
current data immediately before each send. Each job keeps its original event
membership during retries. Identical retries reuse a provider idempotency key;
changes in visible content use a new key. As with any ambiguous network failure,
provider acceptance cannot always be determined locally. The worker serializes
delivery with access, preference, and read changes and prioritizes sign-in codes.
Activity jobs expire after 24 hours, or at once when Resend rejects them
permanently; their notifications remain in the app.
The current worker and Resend configuration need no new service or credentials.

### Push notifications

The server stores each member's iPhone push devices and per-kind push
settings for friend requests, acceptances, comments, and replies. Every kind
is on by default, and the settings are separate from activity email. The
account screen payload includes them, and the `push-settings` action saves
them; see
[push devices and settings](data-and-access.md#push-devices-and-settings).
Signing out deletes that session's devices. The worker sends each new
notification to the member's devices as it is created. The iPhone app asks
for permission after a new member joins or when a member first opens the
bell, registers its device on each launch, and opens a tapped notification's
item and marks it read; see
[iPhone push notifications](../ios/README.md#push-notifications).

### Push delivery

The worker sends pushes directly to APNs
([APNs delivery](ios-app.md#in-house-apns-delivery-from-the-worker--2026-10-13),
[issue #240](https://github.com/jubishop/screenr/issues/240)).
`src/server/apns.ts` holds the APNs client, and `src/server/push.ts` holds
the jobs and their delivery.

- **Jobs:** migration `029-push-jobs.sql` adds `push_job`. A trigger on
  `notification` queues one job per device of the recipient when the bell
  receives a notification, in the same transaction. Deleting the device or
  the notification deletes its jobs.
- **When it sends:** a separate loop in `screenr-worker` claims due jobs about
  once a second and sends up to 50 at a time. It sends a notification's push
  only while the notification is visible to the device's current member under
  the bell's rules and still unread, and while the device's session is live.
  Otherwise it deletes the job without sending. A phone that another member
  has since signed in to therefore never receives the first member's
  notification. The push is an alert when that member allows the
  notification's kind; for a kind they turned off, it is a
  [badge-only update](#badge-only-updates) with the new count.
- **Environments:** each device goes to its own APNs host:
  `api.sandbox.push.apple.com` for `sandbox` devices and `api.push.apple.com`
  for `production` devices. The worker keeps one HTTP/2 connection per host
  and replaces it after GOAWAY, a connection failure, a request that gets no
  answer in 10 seconds, or 15 idle minutes.
- **Signing:** each request carries an ES256 provider token that
  `src/server/apple-jwt.ts` signs with the APNs key from `APNS_PRIVATE_KEY`.
  It names `APNS_KEY_ID` and is issued by `APPLE_TEAM_ID`. The worker reuses
  a token for 50 minutes, inside APNs' limits of one new token per 20 minutes
  and none older than an hour.
- **Stale tokens:** APNs status 410, or 400 with `BadDeviceToken` or
  `DeviceTokenNotForTopic`, deletes the device and its jobs. The app
  registers again on its next launch.
- **Retries:** status 429 or 5xx, a 403 `ExpiredProviderToken`, a connection
  failure, or a timeout retries the job after 2, 4, 8, and up to 60 seconds.
  Any other rejection drops the push. Jobs that are not sent within 24 hours
  expire, and the worker deletes them. Each failure is logged as
  [`push delivery failed`](deployment.md#failure-logs).
- **Without settings:** with none of `APPLE_TEAM_ID`, `APNS_KEY_ID`, and
  `APNS_PRIVATE_KEY`, as in development and CI, the worker prints
  `push delivery off` once and sends nothing; its push loop only deletes
  expired jobs. Incomplete settings or an unreadable key log the same event
  as a failure.

Each alert has this payload. The notification ID is a string, as in the API,
and the app's Notification Service Extension uses it to
[fetch the notification](data-and-access.md#single-notification-read) and
build the visible alert
([push content](ios-app.md#the-extension-fetches-push-content--2026-10-13)):

```json
{
  "aps": {
    "alert": { "body": "New activity on Screenr" },
    "badge": 3,
    "sound": "default",
    "mutable-content": 1,
    "category": "COMMENT",
    "thread-id": "0b6f7a52-6c1e-4f0e-9a51-3d2f4c8e1a77"
  },
  "notificationId": "42"
}
```

- **Badge:** the member's unread count when the push is sent, the same count
  as the bell's.
- **Sound:** every alert plays the phone's default notification sound, the
  user's choice on 2026-10-13. Badge-only updates are silent.
- **Category:** the app registers the categories and their
  [actions](ios-app.md#notification-actions--2026-10-13):

  | Kind | `category` | Actions |
  | --- | --- | --- |
  | `friend_request` | `FRIEND_REQUEST` | Accept and Decline |
  | `comment`, `reply` | `COMMENT` | Reply, with a text field |
  | `friend_accepted` | none | none |

- **Thread:** comments and replies use their entry's ID as the `thread-id`,
  the `thread` of the single-notification read, so the phone groups them by
  conversation. Friendship notifications have no `thread-id`.
- **Headers:** `apns-push-type: alert`, `apns-priority: 10`, the device's
  bundle ID as `apns-topic`, and an `apns-expiration` 24 hours after the job
  was queued. The notification ID is also the `apns-collapse-id`, so a
  retried alert replaces the first rather than showing twice, and it becomes
  the delivered notification's request identifier on the phone.

#### Badge-only updates

Every change to a member's unread count reaches their devices
([unread badge](ios-app.md#unread-badge-kept-in-sync--2026-10-13),
[issue #241](https://github.com/jubishop/screenr/issues/241),
[issue #277](https://github.com/jubishop/screenr/issues/277)). A new
notification's own push carries the new count, as an alert or, for a kind
the member turned off, as a badge-only update. Any other change queues a
badge-only update with `queueBadgePush(userId, client?)`, which queues one
for each of the member's devices. Call it with the transaction client that
makes the change, so the job commits with the change and the worker counts
after it. These actions queue one on every client, the web and the app
alike:

- `read-notification` queues an update only when the notification was
  unread, so selecting one read earlier sends nothing.
- `read-notifications` queues one only when it marks at least one
  notification read.
- `respond-friend-request`, and the `relationship` action's `accept`,
  `remove`, `block`, and `unblock` from the People page or a profile, change
  what two people see from each other: the request, acceptances, and
  comments, which keep their read state when access returns. The friendship
  also decides whether others still see the replies either one sent them on
  the other's entries. Each of these actions queues an update for every
  member whose count it changed, the two people or those reply recipients,
  and none for a count that stayed the same, as when accepting an unread
  request restores one earlier comment.
- `remove-comment` on a reply queues an update for each member who had its
  notification unread: the entry's owner and the person it answered. The
  removal skips the bell's visibility check, so a member whose notification
  a block or lost access had already hidden gets an update with an
  unchanged count. Removing a discussion post or a standalone top-level
  comment keeps its replies and their notifications, so it sends nothing,
  and neither does removing a reply again.
- `delete-account` erases the member's notifications to others and the
  replies on their entries with their notifications
  ([account deletion](data-and-access.md#account-deletion)). It queues an
  update for every other member whose count that lowers. Demo circle
  seeding erases the previous circle the same way.
- A friend `request` sends only its alert, and a failed action rolls back
  and queues nothing.

`trackRelationshipBadges(client, a, b)` finds those members for a
friendship or block change, `trackErasureBadges(client, ids)` for erased
accounts, and `trackBadges(client, members)` serves any other change that
hides or restores notifications. Call either inside the
transaction before the change: it counts the unread notifications of the
members who have a device, and the function it returns, called after the
change, counts again and queues an update for each count that changed. It
leaves out notifications the change creates, such as an acceptance, because
their own pushes carry the count.

The update's payload is only `{"aps": {"badge": 2}}`, sent with
`apns-push-type: alert`, which Apple specifies for badge updates, and
`apns-priority: 5`, which lets the phone defer it to save power. It has no
collapse ID, sends regardless of the per-kind settings, and is skipped for a
device that already has an update waiting for its first attempt. The count
is read when the update is sent.
