-- US release dates stored with the title details they arrive with
-- (docs/title-availability.md#release-status-implementation). NULL means
-- Screenr has no release data for the title yet. Titles stored before this
-- migration have none, so they count as due for a refresh and pick up their
-- dates the next time a title page or list shows them. The previous release
-- ignores this column.
ALTER TABLE title ADD COLUMN release jsonb;
UPDATE title SET fetched_at = least(fetched_at, now() - interval '1 day');
