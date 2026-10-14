-- Each active day records which clients the member used that day: the
-- website, the iPhone app, or both (docs/usage-telemetry.md#active-days).
-- Days recorded before this migration count as website days. The defaults
-- also serve the previous release, which inserts only the member, so a
-- rollback records every day as a website day.
ALTER TABLE member_active_day
  ADD COLUMN web boolean NOT NULL DEFAULT true,
  ADD COLUMN ios boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT member_active_day_client CHECK (web OR ios);
