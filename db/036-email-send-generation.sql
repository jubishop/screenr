-- The worker sends email with no lock held
-- (docs/notifications.md#activity-email-sends-without-the-write-lock--2026-11-01).
-- Blocks and activity email opt-outs bump the generation of pending activity
-- jobs. A send that fails after its job's generation changed is stale and is
-- never retried. The previous release ignores this column.
ALTER TABLE email_job ADD COLUMN generation integer NOT NULL DEFAULT 0;
