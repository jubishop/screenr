-- Per-kind iPhone push settings. Every kind starts on.
ALTER TABLE profile
  ADD COLUMN push_friend_request boolean NOT NULL DEFAULT true,
  ADD COLUMN push_friend_accepted boolean NOT NULL DEFAULT true,
  ADD COLUMN push_comment boolean NOT NULL DEFAULT true,
  ADD COLUMN push_reply boolean NOT NULL DEFAULT true;

-- An APNs device token belongs to one app on one phone, so it identifies the
-- record. Deleting the session that registered it, as signing out does,
-- deletes the device.
CREATE TABLE push_device (
  token text PRIMARY KEY CHECK (token ~ '^([0-9a-f]{2}){32,100}$'),
  user_id text NOT NULL REFERENCES profile(user_id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  -- The app's bundle ID, which APNs requests name as their topic.
  topic text NOT NULL CHECK (topic IN ('com.artisanalsoftware.Screenr','com.artisanalsoftware.Screenr.dev')),
  build integer NOT NULL CHECK (build > 0),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_device_user ON push_device(user_id);
CREATE INDEX push_device_session ON push_device(session_id,topic);
