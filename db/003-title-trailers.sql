CREATE TABLE title_trailer (
  title_id text PRIMARY KEY REFERENCES title(id) ON DELETE CASCADE,
  trailer jsonb,
  expires_at timestamptz NOT NULL
);
