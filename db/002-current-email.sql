ALTER TABLE email_job ADD COLUMN recipient_hash text;
-- Old development-schema jobs have no recipient key. They are expiring codes;
-- discard them rather than retrying a code superseded during the upgrade.
DELETE FROM email_job WHERE sent_at IS NULL;
CREATE UNIQUE INDEX email_job_pending_recipient ON email_job(recipient_hash) WHERE sent_at IS NULL;
