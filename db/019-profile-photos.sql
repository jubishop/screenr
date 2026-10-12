-- Profile photos (#104). PostgreSQL keeps each photo, so the encrypted
-- database backups cover them. A row without an image records that the
-- member removed their photo; automatic Google copies never add one back.
-- Rows reference the auth user so a Google signup's copy exists before setup.
CREATE TABLE IF NOT EXISTS profile_photo (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  image bytea CHECK (octet_length(image) BETWEEN 1 AND 204800),
  content_type text CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  version text CHECK (version ~ '^[0-9a-f]{16}$'),
  source text CHECK (source IN ('upload', 'google')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nulls(image, content_type, version, source) IN (0, 4))
);

-- The current photo version for avatar URLs, or NULL without a photo.
CREATE OR REPLACE FUNCTION screenr_photo(member text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT version FROM profile_photo WHERE user_id = member
$$;

-- One-time data tasks that run outside migrations, such as the Google photo
-- backfill that the worker runs after this release deploys.
CREATE TABLE IF NOT EXISTS screenr_backfill (
  name text PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now()
);
