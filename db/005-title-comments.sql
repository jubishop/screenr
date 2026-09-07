-- Independent entries leave the existing action identity and upserts intact.
CREATE TABLE title_comment (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  owner_id text NOT NULL,
  title_id text NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  spoiler boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id,owner_id,title_id) REFERENCES conversation(id,owner_id,title_id),
  UNIQUE (id,conversation_id)
);
CREATE INDEX title_comment_title ON title_comment(title_id);
CREATE INDEX title_comment_owner ON title_comment(owner_id);

-- A reply belongs to exactly one action/legacy item or standalone comment.
ALTER TABLE comment ALTER COLUMN feed_item_id DROP NOT NULL;
ALTER TABLE comment ADD COLUMN title_comment_id uuid;
ALTER TABLE comment ADD CONSTRAINT comment_title_comment
  FOREIGN KEY (title_comment_id,conversation_id) REFERENCES title_comment(id,conversation_id);
ALTER TABLE comment ADD CONSTRAINT comment_one_entry
  CHECK (num_nonnulls(feed_item_id,title_comment_id)=1);
CREATE INDEX comment_title_activity ON comment(title_comment_id,created_at,id);

-- Preserve older app writes without treating a standalone reply as legacy.
CREATE OR REPLACE FUNCTION screenr_attach_legacy_comment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.feed_item_id IS NULL AND NEW.title_comment_id IS NULL THEN
    INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,created_at,activity_at)
    SELECT id,id,owner_id,title_id,'earlier',created_at,created_at FROM conversation WHERE id=NEW.conversation_id
    ON CONFLICT DO NOTHING;
    NEW.feed_item_id := NEW.conversation_id;
  END IF;
  RETURN NEW;
END
$$;
