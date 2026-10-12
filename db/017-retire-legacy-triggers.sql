-- Retire the triggers that kept feed items in step with pre-feed app writes.
-- The preceding release withdraws the other action itself, and every reply
-- names its entry, so nothing depends on them. The conversation rows and
-- flags stay: rows anchor items and old links, and the preceding release
-- still saves the flags. The flags no longer affect feed items.
DROP TRIGGER IF EXISTS conversation_sync_actions ON conversation;
DROP TRIGGER IF EXISTS comment_attach_item ON comment;
DROP FUNCTION IF EXISTS screenr_sync_actions();
DROP FUNCTION IF EXISTS screenr_attach_legacy_comment();
