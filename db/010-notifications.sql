ALTER TABLE profile ADD COLUMN activity_email boolean NOT NULL DEFAULT false;
ALTER TABLE email_job ADD COLUMN notification_recipient text REFERENCES profile(user_id) ON DELETE CASCADE;

CREATE TABLE notification (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_id text NOT NULL REFERENCES profile(user_id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES profile(user_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('friend_request','friend_accepted','comment','reply')),
  comment_id bigint REFERENCES comment(id) ON DELETE CASCADE,
  friendship_created_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  email_pending boolean NOT NULL DEFAULT false,
  email_job_id uuid REFERENCES email_job(id) ON DELETE SET NULL,
  CHECK (recipient_id <> actor_id),
  CHECK ((kind IN ('comment','reply') AND comment_id IS NOT NULL AND friendship_created_at IS NULL)
    OR (kind IN ('friend_request','friend_accepted') AND comment_id IS NULL AND friendship_created_at IS NOT NULL)),
  UNIQUE (recipient_id,comment_id),
  UNIQUE (recipient_id,actor_id,kind,friendship_created_at)
);
CREATE INDEX notification_recipient ON notification(recipient_id,id DESC);
CREATE INDEX notification_email_pending ON notification(recipient_id,created_at) WHERE email_pending;
CREATE INDEX notification_email_job ON notification(email_job_id) WHERE email_job_id IS NOT NULL;

-- Current visibility applies to counts, lists, selections, and every email attempt.
-- Store references, not comment text or old names, so access changes take effect.
CREATE VIEW visible_notification AS
SELECT n.*,p.username,p.display_name,c.title_id,t.name AS title_name,
  coalesce(cm.feed_item_id,cm.title_comment_id) AS item_id
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

CREATE FUNCTION screenr_notify_friendship() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor text; recipient text; event_kind text;
BEGIN
  IF TG_OP='INSERT' THEN
    actor := NEW.requested_by;
    recipient := CASE WHEN actor=NEW.low_id THEN NEW.high_id ELSE NEW.low_id END;
    event_kind := CASE WHEN NEW.accepted_at IS NULL THEN 'friend_request' ELSE 'friend_accepted' END;
  ELSIF OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL THEN
    recipient := NEW.requested_by;
    actor := CASE WHEN recipient=NEW.low_id THEN NEW.high_id ELSE NEW.low_id END;
    event_kind := 'friend_accepted';
  ELSE
    RETURN NEW;
  END IF;
  INSERT INTO notification(recipient_id,actor_id,kind,friendship_created_at,email_pending)
  SELECT recipient,actor,event_kind,NEW.created_at,p.activity_email FROM profile p
  WHERE p.user_id=recipient AND NOT screenr_blocked(recipient,actor)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;
CREATE TRIGGER friendship_notify AFTER INSERT OR UPDATE OF accepted_at ON friendship
FOR EACH ROW EXECUTE FUNCTION screenr_notify_friendship();

CREATE FUNCTION screenr_notify_comment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO notification(recipient_id,actor_id,kind,comment_id,email_pending)
  SELECT p.user_id,NEW.author_id,
    CASE WHEN p.user_id=NEW.addressed_id THEN 'reply' ELSE 'comment' END,
    NEW.id,p.activity_email
  FROM conversation c JOIN profile p ON p.user_id IN (c.owner_id,NEW.addressed_id)
  WHERE c.id=NEW.conversation_id AND p.user_id<>NEW.author_id
    AND screenr_can_read(p.user_id,c.owner_id)
    AND NOT screenr_blocked(p.user_id,NEW.author_id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;
CREATE TRIGGER comment_notify AFTER INSERT ON comment
FOR EACH ROW EXECUTE FUNCTION screenr_notify_comment();

-- Existing pending requests still need attention, but never send historical mail.
INSERT INTO notification(recipient_id,actor_id,kind,friendship_created_at,created_at)
SELECT CASE WHEN requested_by=low_id THEN high_id ELSE low_id END,
  requested_by,'friend_request',created_at,created_at
FROM friendship WHERE accepted_at IS NULL AND NOT screenr_blocked(low_id,high_id);
