-- Keep action identities, replies, reactions, and dates. Existing conflicts
-- retain the most recently activated action; equal dates favor Recommend.
LOCK TABLE conversation, feed_item IN SHARE ROW EXCLUSIVE MODE;
WITH ranked AS (
  SELECT id,row_number() OVER (
    PARTITION BY owner_id,title_id
    ORDER BY activity_at DESC,item_type ASC
  ) AS position
  FROM feed_item WHERE active AND item_type IN ('recommended','want_to_watch')
)
UPDATE feed_item SET active=false FROM ranked
WHERE feed_item.id=ranked.id AND ranked.position>1;

-- Feed items are the current read model. Align the legacy flags without
-- changing activity dates or reactivating the losing discussion.
UPDATE conversation c SET
  recommended=EXISTS (SELECT 1 FROM feed_item f WHERE f.conversation_id=c.id AND f.item_type='recommended' AND f.active),
  want_to_watch=EXISTS (SELECT 1 FROM feed_item f WHERE f.conversation_id=c.id AND f.item_type='want_to_watch' AND f.active);

ALTER TABLE conversation ADD CONSTRAINT conversation_exclusive_actions
  CHECK (NOT (recommended AND want_to_watch));
CREATE UNIQUE INDEX feed_item_exclusive_actions ON feed_item(owner_id,title_id)
  WHERE active AND item_type IN ('recommended','want_to_watch');

-- Deactivate first so switching in either direction satisfies the unique
-- index throughout the statement. Upserts retain the original discussion IDs.
CREATE OR REPLACE FUNCTION screenr_sync_actions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE action record;
BEGIN
  FOR action IN SELECT * FROM (VALUES
    ('recommended',NEW.recommended),('want_to_watch',NEW.want_to_watch)
  ) AS actions(kind,enabled) ORDER BY enabled LOOP
    IF action.enabled OR EXISTS (
      SELECT 1 FROM feed_item WHERE conversation_id=NEW.id AND item_type=action.kind
    ) THEN
      INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,active,activity_at)
      VALUES(gen_random_uuid(),NEW.id,NEW.owner_id,NEW.title_id,action.kind,action.enabled,NEW.activity_at)
      ON CONFLICT(owner_id,title_id,item_type) DO UPDATE SET active=excluded.active,
        activity_at=CASE WHEN excluded.active AND NOT feed_item.active
          THEN NEW.activity_at ELSE feed_item.activity_at END;
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
