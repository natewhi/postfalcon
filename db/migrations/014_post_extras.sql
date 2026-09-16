-- Recurring posts + cross-posting grouping.
ALTER TABLE posts ADD COLUMN repeat_interval TEXT
  CHECK (repeat_interval IN ('daily', 'weekly', 'monthly'));
ALTER TABLE posts ADD COLUMN repeat_until TIMESTAMPTZ;
-- The first post of a recurring series; every generated occurrence points back to it.
ALTER TABLE posts ADD COLUMN repeat_parent_id BIGINT REFERENCES posts(id) ON DELETE SET NULL;
-- Shared id for a batch of posts created together from one composer (cross-posting).
ALTER TABLE posts ADD COLUMN crosspost_group_id UUID;

CREATE INDEX idx_posts_repeat_parent ON posts (repeat_parent_id) WHERE repeat_parent_id IS NOT NULL;
CREATE INDEX idx_posts_crosspost_group ON posts (crosspost_group_id) WHERE crosspost_group_id IS NOT NULL;
