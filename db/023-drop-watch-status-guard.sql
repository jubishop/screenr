-- Migration 018 added this guard so the release before it, which saved Want
-- to watch without knowing about progress entries, kept one current status.
-- Every retained release withdraws the progress entry itself when Want to
-- watch turns on, so drop the trigger and its function (#195). Databases
-- without them are unchanged.
DROP TRIGGER IF EXISTS feed_item_withdraw_progress ON feed_item;
DROP FUNCTION IF EXISTS screenr_withdraw_progress();
