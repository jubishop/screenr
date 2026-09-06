CREATE TABLE IF NOT EXISTS profile (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_]{3,24}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  joined_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invitation (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  creator_id text REFERENCES profile(user_id),
  max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 12),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= max_uses),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS invitation_signup (
  invitation_id uuid NOT NULL REFERENCES invitation(id),
  user_id text NOT NULL UNIQUE REFERENCES profile(user_id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invitation_id, user_id)
);

CREATE TABLE IF NOT EXISTS friendship (
  low_id text NOT NULL REFERENCES profile(user_id),
  high_id text NOT NULL REFERENCES profile(user_id),
  requested_by text NOT NULL REFERENCES profile(user_id),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (low_id, high_id),
  CHECK (low_id < high_id),
  CHECK (requested_by IN (low_id, high_id))
);
CREATE TABLE IF NOT EXISTS block (
  blocker_id text NOT NULL REFERENCES profile(user_id),
  blocked_id text NOT NULL REFERENCES profile(user_id),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE TABLE IF NOT EXISTS title (
  id text PRIMARY KEY CHECK (id ~ '^(movie|tv):[1-9][0-9]*$'),
  kind text NOT NULL CHECK (kind IN ('movie', 'tv')),
  tmdb_id bigint NOT NULL CHECK (tmdb_id > 0),
  name text NOT NULL,
  overview text NOT NULL DEFAULT '',
  poster_path text,
  release_date text NOT NULL DEFAULT '',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, tmdb_id)
);
CREATE TABLE IF NOT EXISTS conversation (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES profile(user_id),
  title_id text NOT NULL REFERENCES title(id),
  recommended boolean NOT NULL DEFAULT false,
  want_to_watch boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  activity_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, title_id)
);
CREATE TABLE IF NOT EXISTS comment (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversation(id),
  author_id text NOT NULL REFERENCES profile(user_id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  spoiler boolean NOT NULL DEFAULT false,
  root_id bigint REFERENCES comment(id),
  addressed_id text REFERENCES profile(user_id),
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comment_conversation ON comment(conversation_id, id);
CREATE INDEX IF NOT EXISTS conversation_title ON conversation(title_id);

CREATE TABLE IF NOT EXISTS email_job (
  id uuid PRIMARY KEY,
  payload text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  sent_at timestamptz,
  last_error text
);

-- The same predicates serve feed, title, thread and write authorization.
CREATE OR REPLACE FUNCTION screenr_blocked(a text, b text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM block WHERE
    (blocker_id = a AND blocked_id = b) OR
    (blocker_id = b AND blocked_id = a))
$$;
CREATE OR REPLACE FUNCTION screenr_can_read(viewer text, owner text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT viewer = owner OR (
    NOT screenr_blocked(viewer, owner) AND EXISTS (
      SELECT 1 FROM friendship WHERE low_id = least(viewer, owner)
        AND high_id = greatest(viewer, owner) AND accepted_at IS NOT NULL
    )
  )
$$;
