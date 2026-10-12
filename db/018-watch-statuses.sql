-- Watch statuses (docs/title-feed.md#watch-progress-entries). Want to watch
-- stays a feed_item action. Watching, Caught up, Finished, and Stopped
-- watching share one progress entry per person and title. It lives outside
-- feed_item, which the previous release reads and labels by item type, so
-- that release ignores progress entries and their replies instead of
-- mislabeling them.
CREATE TABLE watch_progress (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  owner_id text NOT NULL,
  title_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('watching','caught_up','finished','stopped')),
  -- The last-finished date outlasts later statuses, such as a rewatch.
  finished_on date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  activity_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id,owner_id,title_id) REFERENCES conversation(id,owner_id,title_id),
  UNIQUE (owner_id,title_id),
  UNIQUE (id,conversation_id),
  -- Title IDs start with their kind, and Caught up is only for TV shows.
  CHECK (status <> 'caught_up' OR starts_with(title_id,'tv:'))
);
CREATE INDEX watch_progress_title ON watch_progress(title_id);

-- A reply belongs to exactly one action/legacy item, standalone comment, or
-- progress entry, inside the same person/title conversation.
ALTER TABLE comment ADD COLUMN watch_progress_id uuid;
ALTER TABLE comment ADD CONSTRAINT comment_watch_progress
  FOREIGN KEY (watch_progress_id,conversation_id) REFERENCES watch_progress(id,conversation_id);
ALTER TABLE comment DROP CONSTRAINT comment_one_entry;
ALTER TABLE comment ADD CONSTRAINT comment_one_entry
  CHECK (num_nonnulls(feed_item_id,title_comment_id,watch_progress_id)=1);
CREATE INDEX comment_progress_activity ON comment(watch_progress_id,created_at,id);

ALTER TABLE reaction ADD COLUMN watch_progress_id uuid REFERENCES watch_progress(id) ON DELETE CASCADE;
ALTER TABLE reaction ADD CONSTRAINT reaction_watch_progress_id_user_id_key UNIQUE (watch_progress_id,user_id);
ALTER TABLE reaction DROP CONSTRAINT reaction_check;
ALTER TABLE reaction ADD CONSTRAINT reaction_check
  CHECK (num_nonnulls(feed_item_id,title_comment_id,comment_id,watch_progress_id)=1);

-- Comment notifications on a progress entry link to that entry.
CREATE OR REPLACE VIEW visible_notification AS
SELECT n.*,p.username,p.display_name,c.title_id,t.name AS title_name,
  coalesce(cm.feed_item_id,cm.title_comment_id,cm.watch_progress_id) AS item_id
FROM notification n JOIN profile p ON p.user_id=n.actor_id
LEFT JOIN comment cm ON cm.id=n.comment_id
LEFT JOIN conversation c ON c.id=cm.conversation_id
LEFT JOIN title t ON t.id=c.title_id
LEFT JOIN friendship f ON f.low_id=least(n.recipient_id,n.actor_id)
  AND f.high_id=greatest(n.recipient_id,n.actor_id)
  AND f.created_at=n.friendship_created_at
WHERE NOT screenr_blocked(n.recipient_id,n.actor_id) AND (
  (n.kind='friend_request' AND f.accepted_at IS NULL AND f.requested_by=n.actor_id)
  OR (n.kind='friend_accepted' AND f.accepted_at IS NOT NULL)
  OR (n.kind IN ('comment','reply') AND cm.removed_at IS NULL
    AND screenr_can_read(n.recipient_id,c.owner_id)
    AND screenr_can_read(n.actor_id,c.owner_id))
);

-- Each person has at most one current status. The previous release saves
-- Want to watch without knowing about progress entries, so turning Want to
-- watch on withdraws the progress status here too, keeping its date and
-- discussion. This release withdraws it itself; a later migration drops the
-- trigger once the previous release does too (#195).
CREATE FUNCTION screenr_withdraw_progress() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE watch_progress SET active=false
  WHERE owner_id=NEW.owner_id AND title_id=NEW.title_id AND active;
  RETURN NULL;
END
$$;
CREATE TRIGGER feed_item_withdraw_progress AFTER INSERT OR UPDATE OF active ON feed_item
FOR EACH ROW WHEN (NEW.item_type='want_to_watch' AND NEW.active)
EXECUTE FUNCTION screenr_withdraw_progress();
