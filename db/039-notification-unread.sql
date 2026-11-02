-- Unread notifications, newest first, for each member's unread count, which
-- every screen read and badge push takes, and the notification sheet's
-- Unread filter. Notifications are never pruned, so these reads would
-- otherwise check every notification a member ever received
-- (docs/notifications.md#bounded-reads, issue #375). Pages of all
-- notifications use notification_recipient. Migrations run in one
-- transaction, so CONCURRENTLY is unavailable; the table is small enough
-- that the build blocks its writes only briefly. The previous release
-- ignores this index.
CREATE INDEX notification_unread ON notification(recipient_id,id DESC) WHERE read_at IS NULL;
