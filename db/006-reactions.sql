-- One reaction per person and target. Existing entries and replies are unchanged.
CREATE TABLE reaction (
  user_id text NOT NULL REFERENCES profile(user_id) ON DELETE CASCADE,
  feed_item_id uuid REFERENCES feed_item(id) ON DELETE CASCADE,
  title_comment_id uuid REFERENCES title_comment(id) ON DELETE CASCADE,
  comment_id bigint REFERENCES comment(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('like','love','care','haha','wow','sad','angry')),
  CHECK (num_nonnulls(feed_item_id,title_comment_id,comment_id)=1),
  UNIQUE (feed_item_id,user_id),
  UNIQUE (title_comment_id,user_id),
  UNIQUE (comment_id,user_id)
);
