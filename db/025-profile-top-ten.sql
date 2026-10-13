-- Profile top 10 (#99, docs/profile-top-ten.md). Each member ranks up to 10
-- of their current Recommends from #1. Writes keep the ranks contiguous in
-- one transaction. The rank key is checked at the end of each statement, so
-- one statement can move several entries.
CREATE TABLE top_ten (
  owner_id text NOT NULL REFERENCES profile(user_id),
  title_id text NOT NULL REFERENCES title(id),
  rank smallint NOT NULL CHECK (rank BETWEEN 1 AND 10),
  PRIMARY KEY (owner_id, title_id),
  UNIQUE (owner_id, rank) DEFERRABLE
);
CREATE INDEX top_ten_title ON top_ten(title_id);

-- Every entry is a current Recommend. This release removes the entry itself
-- when the Recommend is withdrawn or switched to Want to watch. The
-- preceding release does not know about the list, so this trigger removes
-- the entry and closes the gap after its writes too. A later migration drops
-- the trigger once no retained release predates this one (#198).
CREATE FUNCTION screenr_leave_top_ten() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE removed smallint;
BEGIN
  DELETE FROM top_ten WHERE owner_id=NEW.owner_id AND title_id=NEW.title_id
  RETURNING rank INTO removed;
  IF removed IS NOT NULL THEN
    UPDATE top_ten SET rank=rank-1 WHERE owner_id=NEW.owner_id AND rank>removed;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER feed_item_leave_top_ten AFTER UPDATE OF active ON feed_item
FOR EACH ROW WHEN (NEW.item_type='recommended' AND OLD.active AND NOT NEW.active)
EXECUTE FUNCTION screenr_leave_top_ten();
