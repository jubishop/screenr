-- When Screenr first stored each title, so the worker's cleanup
-- (docs/title-catalog.md#catalog-retention) keeps a search result whose
-- details have not loaded yet. Titles stored before this migration count
-- from now. The previous release ignores this column.
ALTER TABLE title ADD COLUMN stored_at timestamptz NOT NULL DEFAULT now();
