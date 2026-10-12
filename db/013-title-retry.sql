-- A failed catalog refresh keeps serving the stored title and waits until
-- retry_after before asking TMDB again. NULL means no failed refresh is
-- pending; fetched_at still records the last successful fetch. The previous
-- release ignores this column.
ALTER TABLE title ADD COLUMN retry_after timestamptz;
