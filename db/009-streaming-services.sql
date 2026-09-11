CREATE TABLE member_streaming_service (
  user_id text NOT NULL REFERENCES profile(user_id) ON DELETE CASCADE,
  service_id text NOT NULL CHECK (service_id ~ '^service:[a-z0-9-]+$'),
  PRIMARY KEY (user_id, service_id)
);
