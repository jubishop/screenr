-- Migration 025 added this guard so the release before it, which withdrew
-- Recommend without knowing about the profile top 10, kept every entry a
-- current Recommend. Every retained release removes the entry itself when
-- Recommend is withdrawn or switched to Want to watch, so drop the trigger
-- and its function (#198). Databases without them are unchanged.
DROP TRIGGER IF EXISTS feed_item_leave_top_ten ON feed_item;
DROP FUNCTION IF EXISTS screenr_leave_top_ten();
