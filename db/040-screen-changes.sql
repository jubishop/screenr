-- One database-wide change mark that every write to a table the friends
-- feed and profile screens read advances, so the web process can answer an
-- unchanged poll of those screens with 304 without building it
-- (src/server/screen-versions.ts, issue #373). Each mark comes from a
-- sequence, so no two writes share one, even across a rolled-back write; the
-- row holds the latest committed mark. Domain writes already take turns
-- under the domain lock, so updating the one row adds no waits between them.
-- A table that a feed or profile screen starts reading needs this trigger
-- too. The previous release ignores the mark.
CREATE SEQUENCE screen_change_mark;
CREATE TABLE screen_change (
  only_row boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  mark bigint NOT NULL
);
INSERT INTO screen_change(mark) VALUES (nextval('screen_change_mark'));

CREATE FUNCTION screenr_screen_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE screen_change SET mark=nextval('screen_change_mark');
  RETURN NULL;
END
$$;

-- Entries, their discussions and reactions, the people in them, access, the
-- viewer's top 10, and the notifications behind the unread count. A trigger
-- runs once per statement, and a statement that changes no rows still
-- advances the mark, which only costs one rebuild.
CREATE TRIGGER feed_item_screen_change AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON feed_item
FOR EACH STATEMENT EXECUTE FUNCTION screenr_screen_changed();
CREATE TRIGGER title_comment_screen_change AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON title_comment
FOR EACH STATEMENT EXECUTE FUNCTION screenr_screen_changed();
CREATE TRIGGER watch_progress_screen_change AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON watch_progress
FOR EACH STATEMENT EXECUTE FUNCTION screenr_screen_changed();
CREATE TRIGGER review_screen_change AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON review
FOR EACH STATEMENT EXECUTE FUNCTION screenr_screen_changed();
CREATE TRIGGER discussion_post_screen_change AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON discussion_post
FOR EACH STATEMENT EXECUTE FUNCTION screenr_screen_changed();
CREATE TRIGGER conversation_screen_change AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON conversation
FOR EACH STATEMENT EXECUTE FUNCTION screenr_screen_changed();
CREATE TRIGGER comment_screen_change AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON comment
FOR EACH STATEMENT EXECUTE FUNCTION screenr_screen_changed();
CREATE TRIGGER reaction_screen_change AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON reaction
FOR EACH STATEMENT EXECUTE FUNCTION screenr_screen_changed();
CREATE TRIGGER profile_screen_change AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON profile
FOR EACH STATEMENT EXECUTE FUNCTION screenr_screen_changed();
CREATE TRIGGER profile_photo_screen_change AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON profile_photo
FOR EACH STATEMENT EXECUTE FUNCTION screenr_screen_changed();
CREATE TRIGGER friendship_screen_change AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON friendship
FOR EACH STATEMENT EXECUTE FUNCTION screenr_screen_changed();
CREATE TRIGGER block_screen_change AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON block
FOR EACH STATEMENT EXECUTE FUNCTION screenr_screen_changed();
CREATE TRIGGER top_ten_screen_change AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON top_ten
FOR EACH STATEMENT EXECUTE FUNCTION screenr_screen_changed();
-- The email worker's own bookkeeping on notifications leaves read_at alone.
CREATE TRIGGER notification_screen_change AFTER INSERT OR UPDATE OF read_at OR DELETE OR TRUNCATE ON notification
FOR EACH STATEMENT EXECUTE FUNCTION screenr_screen_changed();
-- Catalog refreshes rewrite title rows outside the domain lock; only a change
-- to what entries and top 10s show counts. A new title shows only through a
-- new entry, and the catalog removes only titles that nothing shows.
CREATE TRIGGER title_screen_change AFTER UPDATE ON title FOR EACH ROW
WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.kind IS DISTINCT FROM NEW.kind
  OR OLD.poster_path IS DISTINCT FROM NEW.poster_path
  OR OLD.release_date IS DISTINCT FROM NEW.release_date)
EXECUTE FUNCTION screenr_screen_changed();
