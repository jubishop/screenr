-- Feed items replaced the conversation row's Recommend and Want to watch
-- flags and their shared activity date. Since migration 017 nothing reads
-- them, and no retained release writes them, so drop the exclusive-action
-- check and the columns. Conversation rows, their identities, and the keys
-- that entries and replies reference stay. Databases without the columns
-- are unchanged.
ALTER TABLE conversation
  DROP CONSTRAINT IF EXISTS conversation_exclusive_actions,
  DROP COLUMN IF EXISTS recommended,
  DROP COLUMN IF EXISTS want_to_watch,
  DROP COLUMN IF EXISTS activity_at;
