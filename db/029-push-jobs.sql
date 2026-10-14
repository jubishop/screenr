-- Pending iPhone pushes, one per device: an alert about a notification, or a
-- badge-only update when notification_id is NULL. The worker checks
-- visibility, settings, and the device's session when it sends, deletes the
-- job once APNs answers, and retries failures until the job expires.
CREATE TABLE push_job (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token text NOT NULL REFERENCES push_device(token) ON DELETE CASCADE,
  notification_id bigint REFERENCES notification(id) ON DELETE CASCADE,
  available_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX push_job_due ON push_job(available_at);
CREATE INDEX push_job_token ON push_job(token);
CREATE INDEX push_job_notification ON push_job(notification_id) WHERE notification_id IS NOT NULL;

-- Every new bell notification, including any a later migration inserts,
-- queues a push to each of its recipient's devices.
CREATE FUNCTION screenr_queue_push() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO push_job(token,notification_id)
  SELECT token,NEW.id FROM push_device WHERE user_id=NEW.recipient_id;
  RETURN NEW;
END
$$;
CREATE TRIGGER notification_push AFTER INSERT ON notification
FOR EACH ROW EXECUTE FUNCTION screenr_queue_push();
