-- Login-code emails draw on two daily budgets
-- (docs/running-screenr.md#provider-configuration, issue #575). A code sent
-- to an address that has not finished joining Screenr stores the hashed
-- client IP it was requested from, which also counts toward that IP's own
-- budget; a code sent to a member stores none. Rows are still kept for one
-- day. The previous release ignores this column.
ALTER TABLE login_code_request ADD COLUMN ip_hash text;
