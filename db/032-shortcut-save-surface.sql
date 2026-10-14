-- Want to watch saves made through Siri or the Shortcuts app in the iPhone
-- app report the `shortcut` surface (docs/usage-telemetry.md#save-attribution).
-- src/shared.ts lists the same surfaces. The previous release never sends it.
ALTER TABLE want_to_watch_save
  DROP CONSTRAINT want_to_watch_save_surface_check,
  ADD CONSTRAINT want_to_watch_save_surface_check CHECK (surface IN (
    'friend_recommendation', 'friend_entry', 'friends_recommend',
    'suggestion_recommendation', 'suggestion', 'title', 'watch_together',
    'shortcut'));
