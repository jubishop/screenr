-- One row per accepted login-code request, kept for one day. Recipients are
-- hashed. A request is marked sent only when a code email is queued.
CREATE TABLE login_code_request (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_hash text NOT NULL,
  sent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_code_request_recipient ON login_code_request(recipient_hash,created_at);
CREATE INDEX login_code_request_created ON login_code_request(created_at);
