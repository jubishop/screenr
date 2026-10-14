-- Account deletion (docs/data-and-access.md#account-deletion) keeps a deleted
-- member's comment that has replies as a "Comment removed" placeholder with
-- no author, so the replies remain and nothing refers to the member. Only a
-- removed comment can lose its author. The previous release leaves such a
-- placeholder out of conversations, as if it had no replies.
ALTER TABLE comment ALTER COLUMN author_id DROP NOT NULL;
ALTER TABLE comment ADD CONSTRAINT comment_author_or_removed
  CHECK (author_id IS NOT NULL OR removed_at IS NOT NULL);
