-- Per-post, per-platform publish settings the user picks in the composer, keyed by platform
-- id — currently only { "tiktok": { privacy_level, allow_comment, ... } }, which TikTok's
-- Content Sharing Guidelines require the user to choose explicitly before each post.
-- Not named `metadata`: scheduler.js's due-posts query joins social_accounts.metadata into
-- the same row, which would shadow a posts.metadata column.
ALTER TABLE posts ADD COLUMN platform_options JSONB NOT NULL DEFAULT '{}'::jsonb;
