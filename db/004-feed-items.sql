-- Additive migration: the preceding release can still read and write its
-- person/title conversations during activation or rollback.
ALTER TABLE conversation ADD CONSTRAINT conversation_identity UNIQUE(id,owner_id,title_id);
CREATE TABLE feed_item (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  owner_id text NOT NULL,
  title_id text NOT NULL,
  item_type text NOT NULL CHECK (item_type IN ('recommended','want_to_watch','earlier')),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  activity_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id,owner_id,title_id) REFERENCES conversation(id,owner_id,title_id),
  UNIQUE (owner_id,title_id,item_type),
  UNIQUE (id,conversation_id)
);
CREATE INDEX feed_item_title ON feed_item(title_id);

-- The old flags and shared date are the only known action history.
INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,active,created_at,activity_at)
SELECT gen_random_uuid(),id,owner_id,title_id,'recommended',true,created_at,activity_at
FROM conversation WHERE recommended;
INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,active,created_at,activity_at)
SELECT gen_random_uuid(),id,owner_id,title_id,'want_to_watch',true,created_at,activity_at
FROM conversation WHERE want_to_watch;

-- Preserve the original discussion ID only where comments actually exist.
INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,created_at,activity_at)
SELECT id,id,owner_id,title_id,'earlier',created_at,created_at FROM conversation c
WHERE EXISTS (SELECT 1 FROM comment WHERE conversation_id=c.id);
ALTER TABLE comment ADD COLUMN feed_item_id uuid;
UPDATE comment SET feed_item_id=conversation_id;
ALTER TABLE comment ADD CONSTRAINT comment_feed_item
  FOREIGN KEY (feed_item_id,conversation_id) REFERENCES feed_item(id,conversation_id);
CREATE INDEX comment_feed_activity ON comment(feed_item_id,created_at,id);

-- Older application writes continue to update the correct action items.
CREATE FUNCTION screenr_sync_actions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE action record;
BEGIN
  FOR action IN SELECT * FROM (VALUES
    ('recommended',NEW.recommended),('want_to_watch',NEW.want_to_watch)
  ) AS actions(kind,enabled) LOOP
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
CREATE TRIGGER conversation_sync_actions AFTER INSERT OR UPDATE OF recommended,want_to_watch
ON conversation FOR EACH ROW EXECUTE FUNCTION screenr_sync_actions();

-- A comment from the previous app has no action attribution. Keep it in the
-- preserved discussion; new writes supply an explicit item ID.
CREATE FUNCTION screenr_attach_legacy_comment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.feed_item_id IS NULL THEN
    INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,created_at,activity_at)
    SELECT id,id,owner_id,title_id,'earlier',created_at,created_at FROM conversation WHERE id=NEW.conversation_id
    ON CONFLICT DO NOTHING;
    NEW.feed_item_id := NEW.conversation_id;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER comment_attach_item BEFORE INSERT ON comment
FOR EACH ROW EXECUTE FUNCTION screenr_attach_legacy_comment();
ALTER TABLE comment ALTER COLUMN feed_item_id SET NOT NULL;
