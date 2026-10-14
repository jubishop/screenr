-- The demo circle for Apple's beta review
-- (docs/ios-app.md#isolated-demo-circle-for-apple-review--2026-10-13).
-- `npm run seed:review` creates the demo profiles, and anyone who joins
-- through a demo member's invitation becomes one too.
ALTER TABLE profile ADD COLUMN demo boolean NOT NULL DEFAULT false;

-- A demo profile and a real one are hidden from each other as if blocked, in
-- every read and write that checks blocks: profiles, friend requests,
-- suggestions, feeds, comments, notifications, and photos. Two real members
-- see exactly what they saw before.
CREATE OR REPLACE FUNCTION screenr_blocked(a text, b text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM block WHERE
    (blocker_id = a AND blocked_id = b) OR
    (blocker_id = b AND blocked_id = a))
  OR (EXISTS (SELECT 1 FROM profile WHERE user_id = a AND demo)
    <> EXISTS (SELECT 1 FROM profile WHERE user_id = b AND demo))
$$;
