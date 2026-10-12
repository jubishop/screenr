-- Usage telemetry follows each Want to watch save to a later Watching, Caught
-- up, or Finished status by the same member (docs/usage-telemetry.md). The
-- flag records only that this happened, not which status or when, and leaves
-- with its save row after 12 months. The previous release ignores the column,
-- so its saves stay unfollowed. Rerunning this file changes nothing more.
ALTER TABLE want_to_watch_save
  ADD COLUMN IF NOT EXISTS followed_through boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS want_to_watch_save_member_title
  ON want_to_watch_save(user_id, title_id);

-- Saves made before this release. A save withdraws any progress status, so a
-- current Watching, Caught up, or Finished status came after every save of
-- that title. A status since cleared or changed to Stopped is not recoverable.
UPDATE want_to_watch_save w SET followed_through = true
FROM watch_progress p
WHERE p.owner_id = w.user_id AND p.title_id = w.title_id AND p.active
  AND p.status IN ('watching', 'caught_up', 'finished')
  AND NOT w.followed_through;
