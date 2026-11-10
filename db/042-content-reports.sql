-- Members' reports of posts, reviews, comments, and profiles, which the owner
-- reviews on the website (docs/data-and-access.md#content-reports, issue
-- #555). Each report names one item: an entry, a reply, or for a profile only
-- its author. It keeps what the reporter saw when reporting, so the review
-- page shows it even after the author edits or deletes it: the text and
-- rating of an entry or reply, the title it is about, or a profile's display
-- name and photo. A report goes with either member's account, and with its
-- item when erasure deletes the item. The previous release ignores these
-- tables.
CREATE TABLE content_report (
  id uuid PRIMARY KEY,
  reporter_id text NOT NULL REFERENCES profile(user_id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES profile(user_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('post','comment','review','profile')),
  title_comment_id uuid REFERENCES title_comment(id) ON DELETE CASCADE,
  discussion_post_id uuid REFERENCES discussion_post(id) ON DELETE CASCADE,
  review_id uuid REFERENCES review(id) ON DELETE CASCADE,
  comment_id bigint REFERENCES comment(id) ON DELETE CASCADE,
  -- The reported entry, whichever table holds it.
  entry_id uuid GENERATED ALWAYS AS (coalesce(title_comment_id,discussion_post_id,review_id)) STORED,
  reason text NOT NULL CHECK (reason IN ('harassment','hate','sexual','violence','spam','other')),
  note text CHECK (char_length(note) BETWEEN 1 AND 500),
  body text CHECK (char_length(body) BETWEEN 1 AND 2000),
  rating smallint CHECK (rating BETWEEN 1 AND 5),
  title_name text,
  display_name text,
  photo bytea CHECK (octet_length(photo) BETWEEN 1 AND 204800),
  photo_type text CHECK (photo_type IN ('image/jpeg','image/png','image/webp')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution text CHECK (resolution IN ('removed','dismissed')),
  CHECK (reporter_id <> author_id),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL)),
  CHECK ((photo IS NULL) = (photo_type IS NULL)),
  -- A post is a discussion post, a comment a standalone title comment or a
  -- reply, and a profile names no item.
  CHECK (CASE kind
    WHEN 'post' THEN num_nonnulls(title_comment_id,discussion_post_id,review_id,comment_id)=1 AND discussion_post_id IS NOT NULL
    WHEN 'review' THEN num_nonnulls(title_comment_id,discussion_post_id,review_id,comment_id)=1 AND review_id IS NOT NULL
    WHEN 'comment' THEN num_nonnulls(title_comment_id,discussion_post_id,review_id,comment_id)=1
      AND (title_comment_id IS NOT NULL OR comment_id IS NOT NULL)
    ELSE num_nonnulls(title_comment_id,discussion_post_id,review_id,comment_id)=0 END)
);
-- A member has at most one open report of an item. Feeds hide every item a
-- member reported, open or not, from that member, and erasure deletes
-- through each key.
CREATE UNIQUE INDEX content_report_open ON content_report(reporter_id,entry_id,comment_id,author_id)
  NULLS NOT DISTINCT WHERE resolved_at IS NULL;
CREATE INDEX content_report_reporter ON content_report(reporter_id);
CREATE INDEX content_report_author ON content_report(author_id);
CREATE INDEX content_report_title_comment ON content_report(title_comment_id) WHERE title_comment_id IS NOT NULL;
CREATE INDEX content_report_post ON content_report(discussion_post_id) WHERE discussion_post_id IS NOT NULL;
CREATE INDEX content_report_review ON content_report(review_id) WHERE review_id IS NOT NULL;
CREATE INDEX content_report_comment ON content_report(comment_id) WHERE comment_id IS NOT NULL;
CREATE INDEX content_report_pending ON content_report(created_at DESC) WHERE resolved_at IS NULL;

-- Feeds read reports to hide what the reader reported.
CREATE TRIGGER content_report_screen_change AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON content_report
FOR EACH STATEMENT EXECUTE FUNCTION screenr_screen_changed();

-- The owner's Pushover alert for each new report, which the worker sends and
-- then deletes, retrying failures until the job expires. It carries no member
-- content, only the report it announces.
CREATE TABLE pushover_job (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES content_report(id) ON DELETE CASCADE,
  available_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX pushover_job_due ON pushover_job(available_at);
CREATE INDEX pushover_job_report ON pushover_job(report_id);

-- A notification about a reply its recipient reported, or about a reply on an
-- entry they reported, no longer shows for them.
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
    AND screenr_can_read(n.actor_id,coalesce(c.owner_id,dp.owner_id))
    AND NOT EXISTS (SELECT 1 FROM content_report r WHERE r.reporter_id=n.recipient_id
      AND (r.comment_id=cm.id OR r.entry_id IN (cm.title_comment_id,cm.review_id,cm.discussion_post_id))))
);
