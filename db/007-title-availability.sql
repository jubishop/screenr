CREATE TABLE title_availability (
  title_id text NOT NULL REFERENCES title(id) ON DELETE CASCADE,
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  availability jsonb,
  fetched_at timestamptz,
  refresh_after timestamptz NOT NULL,
  PRIMARY KEY (title_id, country),
  CHECK ((availability IS NULL) = (fetched_at IS NULL))
);
