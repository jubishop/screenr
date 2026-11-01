-- Account erasure (docs/data-and-access.md#account-deletion) holds the domain
-- lock, and PostgreSQL checks each foreign key once per deleted row. Without
-- these indexes, every deleted comment scanned the whole comment table for
-- replies, so erasure grew with comments deleted × comments stored. They also
-- serve erasure's own lookups by author, reply root, and addressed person,
-- and the profile's foreign-key checks. The unique (recipient_id,comment_id)
-- index served the notification cascade only by skipping through recipients.
-- Migrations run in one transaction, so CONCURRENTLY is unavailable; these
-- tables are small enough that each build blocks their writes only briefly.
-- The previous release ignores these indexes.
CREATE INDEX comment_root ON comment(root_id) WHERE root_id IS NOT NULL;
CREATE INDEX comment_author ON comment(author_id);
CREATE INDEX comment_addressed ON comment(addressed_id) WHERE addressed_id IS NOT NULL;
CREATE INDEX notification_comment ON notification(comment_id) WHERE comment_id IS NOT NULL;
