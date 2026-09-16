-- Per-post engagement counts, refreshed periodically from each platform's API (see
-- scheduler.js refreshPostMetrics). One snapshot per post, not a time series: enough for a
-- "views this week" chart (bucketed by the post's own posted_at) without a separate table.
-- All nullable — a platform with no metrics adapter (Telegram, TikTok) or a post metrics
-- haven't been fetched for yet simply leaves these null, not zero.
ALTER TABLE posts
  ADD COLUMN metric_views INT,
  ADD COLUMN metric_likes INT,
  ADD COLUMN metric_comments INT,
  ADD COLUMN metric_shares INT,
  ADD COLUMN metrics_updated_at TIMESTAMPTZ;

-- Used by the metrics-refresh job's WHERE clause (posted posts from roughly the last month).
CREATE INDEX idx_posts_posted_recent ON posts (posted_at) WHERE status = 'posted';
