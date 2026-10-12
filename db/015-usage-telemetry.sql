-- Usage telemetry for the initial success measures (docs/usage-telemetry.md).
-- Rows hold no pages, times, or friend identities, and the worker deletes rows
-- older than 12 months. The previous release ignores both tables.

-- At most one row per member per Pacific day.
CREATE TABLE member_active_day (
  user_id text NOT NULL REFERENCES profile(user_id) ON DELETE CASCADE,
  day date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Los_Angeles')::date,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX member_active_day_day ON member_active_day(day);

-- One row per Want to watch save. friend_recommending records only whether a
-- direct friend was recommending the title, never who. A null surface comes
-- from a client that did not report one. src/shared.ts lists the same surfaces.
CREATE TABLE want_to_watch_save (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES profile(user_id) ON DELETE CASCADE,
  title_id text NOT NULL REFERENCES title(id) ON DELETE CASCADE,
  saved_on date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Los_Angeles')::date,
  surface text CHECK (surface IN ('friend_recommendation', 'friend_entry',
    'friends_recommend', 'suggestion_recommendation', 'suggestion', 'title',
    'watch_together')),
  friend_recommending boolean NOT NULL
);
CREATE INDEX want_to_watch_save_saved_on ON want_to_watch_save(saved_on);
