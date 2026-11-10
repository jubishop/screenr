-- The owner's suspension of a member (docs/data-and-access.md#member-suspension,
-- issue #556). A suspended member can't sign in, and everything they wrote,
-- their profile included, is hidden from everyone as if blocked, while their
-- data and friendships stay. Lifting the suspension deletes its row and
-- restores all of it. A suspension goes with the member's account. The
-- previous release ignores this table, but it shares the access rule and the
-- session check below.
CREATE TABLE member_suspension (
  user_id text PRIMARY KEY REFERENCES profile(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Every read and write that checks blocks also hides a suspended member from
-- everyone, and everyone from them: profiles, friend lists and requests,
-- suggestions, Find's counts, feeds, comments, reactions, notifications, and
-- photos.
CREATE OR REPLACE FUNCTION screenr_blocked(a text, b text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM block WHERE
    (blocker_id = a AND blocked_id = b) OR
    (blocker_id = b AND blocked_id = a))
  OR (EXISTS (SELECT 1 FROM profile WHERE user_id = a AND demo)
    <> EXISTS (SELECT 1 FROM profile WHERE user_id = b AND demo))
  OR EXISTS (SELECT 1 FROM member_suspension WHERE user_id IN (a, b))
$$;

-- Feeds and profiles read suspensions through the access rule.
CREATE TRIGGER member_suspension_screen_change AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON member_suspension
FOR EACH STATEMENT EXECUTE FUNCTION screenr_screen_changed();

-- Sign-in refuses a suspended member with a message before it creates a
-- session (src/server/auth.ts). This backs it for a sign-in that checked
-- just before a suspension committed: suspending holds the account's row
-- while it deletes the member's sessions, so a new session waits for it and
-- then sees the suspension, or commits first and is deleted with the rest.
CREATE FUNCTION screenr_session_allowed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "user" WHERE id = NEW."userId" FOR KEY SHARE;
  IF EXISTS (SELECT 1 FROM member_suspension WHERE user_id = NEW."userId") THEN
    RAISE EXCEPTION 'suspended accounts cannot sign in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER session_allowed BEFORE INSERT ON session
FOR EACH ROW EXECUTE FUNCTION screenr_session_allowed();
