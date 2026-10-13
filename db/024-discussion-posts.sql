-- Discussion posts without a title, and season or episode labels on TV
-- discussion posts (docs/title-feed.md#discussion-posts-without-a-title).
-- Posts without a title live outside title_comment, which the previous
-- release reads and joins to a title, so that release ignores them and their
-- replies.
CREATE TABLE discussion_post (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES profile(user_id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  spoiler boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE INDEX discussion_post_owner ON discussion_post(owner_id);

-- A reply belongs to exactly one entry. Replies to a post have no
-- person/title conversation; every other reply keeps one.
ALTER TABLE comment ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE comment ADD COLUMN discussion_post_id uuid REFERENCES discussion_post(id);
ALTER TABLE comment DROP CONSTRAINT comment_one_entry;
ALTER TABLE comment ADD CONSTRAINT comment_one_entry
  CHECK (num_nonnulls(feed_item_id,title_comment_id,watch_progress_id,review_id,discussion_post_id)=1);
ALTER TABLE comment ADD CONSTRAINT comment_post_conversation
  CHECK ((conversation_id IS NULL) = (discussion_post_id IS NOT NULL));
CREATE INDEX comment_post_activity ON comment(discussion_post_id,created_at,id);

ALTER TABLE reaction ADD COLUMN discussion_post_id uuid REFERENCES discussion_post(id) ON DELETE CASCADE;
ALTER TABLE reaction ADD CONSTRAINT reaction_discussion_post_id_user_id_key UNIQUE (discussion_post_id,user_id);
ALTER TABLE reaction DROP CONSTRAINT reaction_check;
ALTER TABLE reaction ADD CONSTRAINT reaction_check
  CHECK (num_nonnulls(feed_item_id,title_comment_id,comment_id,watch_progress_id,review_id,discussion_post_id)=1);

-- A TV discussion post can name a season, or an episode within it. Title IDs
-- start with their kind.
ALTER TABLE title_comment ADD COLUMN season_number integer CHECK (season_number > 0);
ALTER TABLE title_comment ADD COLUMN episode_number integer CHECK (episode_number > 0);
ALTER TABLE title_comment ADD CONSTRAINT title_comment_label CHECK (
  (episode_number IS NULL OR season_number IS NOT NULL)
  AND (season_number IS NULL OR starts_with(title_id,'tv:')));

-- Replies to a post notify its owner and the addressed person under the same
-- access rules as replies on a title.
CREATE OR REPLACE FUNCTION screenr_notify_comment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO notification(recipient_id,actor_id,kind,comment_id,email_pending)
  SELECT p.user_id,NEW.author_id,
    CASE WHEN p.user_id=NEW.addressed_id THEN 'reply' ELSE 'comment' END,
    NEW.id,p.activity_email
  FROM (SELECT owner_id FROM conversation WHERE id=NEW.conversation_id
    UNION ALL SELECT owner_id FROM discussion_post WHERE id=NEW.discussion_post_id) c
  JOIN profile p ON p.user_id IN (c.owner_id,NEW.addressed_id)
  WHERE p.user_id<>NEW.author_id
    AND screenr_can_read(p.user_id,c.owner_id)
    AND NOT screenr_blocked(p.user_id,NEW.author_id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;

-- A notification about a post has no title. The previous release links such
-- a notification to the actor's profile; this release opens the post.
CREATE OR REPLACE VIEW visible_notification AS
SELECT n.*,p.username,p.display_name,c.title_id,t.name AS title_name,
  coalesce(cm.feed_item_id,cm.title_comment_id,cm.watch_progress_id,cm.review_id,cm.discussion_post_id) AS item_id
FROM notification n JOIN profile p ON p.user_id=n.actor_id
LEFT JOIN comment cm ON cm.id=n.comment_id
LEFT JOIN conversation c ON c.id=cm.conversation_id
LEFT JOIN discussion_post dp ON dp.id=cm.discussion_post_id
LEFT JOIN title t ON t.id=c.title_id
LEFT JOIN friendship f ON f.low_id=least(n.recipient_id,n.actor_id)
  AND f.high_id=greatest(n.recipient_id,n.actor_id)
  AND f.created_at=n.friendship_created_at
WHERE NOT screenr_blocked(n.recipient_id,n.actor_id) AND (
  (n.kind='friend_request' AND f.accepted_at IS NULL AND f.requested_by=n.actor_id)
  OR (n.kind='friend_accepted' AND f.accepted_at IS NOT NULL)
  OR (n.kind IN ('comment','reply') AND cm.removed_at IS NULL
    AND screenr_can_read(n.recipient_id,coalesce(c.owner_id,dp.owner_id))
    AND screenr_can_read(n.actor_id,coalesce(c.owner_id,dp.owner_id)))
);
