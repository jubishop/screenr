-- Star ratings and written reviews (docs/title-feed.md#reviews). Each person
-- has one review per title: an optional whole-star rating, optional text, or
-- both, with a spoiler flag. Edits update the entry in place. Removal erases
-- the rating and text and keeps the entry for its discussion and a later
-- review. Reviews live outside feed_item, which the previous release reads and
-- labels by item type, so that release ignores reviews and their replies.
CREATE TABLE review (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  owner_id text NOT NULL,
  title_id text NOT NULL,
  rating smallint CHECK (rating BETWEEN 1 AND 5),
  body text CHECK (char_length(body) BETWEEN 1 AND 2000),
  spoiler boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  activity_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id,owner_id,title_id) REFERENCES conversation(id,owner_id,title_id),
  UNIQUE (owner_id,title_id),
  UNIQUE (id,conversation_id),
  -- A current review has a rating, text, or both; a removed one has neither.
  CHECK (CASE WHEN active THEN num_nonnulls(rating,body)>0 ELSE num_nonnulls(rating,body)=0 END)
);
CREATE INDEX review_title ON review(title_id);

-- A reply belongs to exactly one entry, inside the same person/title
-- conversation.
ALTER TABLE comment ADD COLUMN review_id uuid;
ALTER TABLE comment ADD CONSTRAINT comment_review
  FOREIGN KEY (review_id,conversation_id) REFERENCES review(id,conversation_id);
ALTER TABLE comment DROP CONSTRAINT comment_one_entry;
ALTER TABLE comment ADD CONSTRAINT comment_one_entry
  CHECK (num_nonnulls(feed_item_id,title_comment_id,watch_progress_id,review_id)=1);
CREATE INDEX comment_review_activity ON comment(review_id,created_at,id);

ALTER TABLE reaction ADD COLUMN review_id uuid REFERENCES review(id) ON DELETE CASCADE;
ALTER TABLE reaction ADD CONSTRAINT reaction_review_id_user_id_key UNIQUE (review_id,user_id);
ALTER TABLE reaction DROP CONSTRAINT reaction_check;
ALTER TABLE reaction ADD CONSTRAINT reaction_check
  CHECK (num_nonnulls(feed_item_id,title_comment_id,comment_id,watch_progress_id,review_id)=1);

-- Comment notifications on a review link to that review.
CREATE OR REPLACE VIEW visible_notification AS
SELECT n.*,p.username,p.display_name,c.title_id,t.name AS title_name,
  coalesce(cm.feed_item_id,cm.title_comment_id,cm.watch_progress_id,cm.review_id) AS item_id
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
