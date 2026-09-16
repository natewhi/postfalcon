import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

const DAYS_IN_CHART = 7;

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

// Everything the user actually owns is fetched from metric_* columns on `posts` — refreshed
// periodically by scheduler.js's refreshPostMetrics(), not computed here. This endpoint just
// aggregates what's already been fetched.
router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    // Bucketed as a plain UTC calendar-day string (not date_trunc, which truncates in whatever
    // timezone the Postgres session happens to be in) so it lines up exactly with the UTC
    // day keys generated below, regardless of server/session timezone.
    const { rows: dayRows } = await pool.query(
      `SELECT to_char(posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
              COALESCE(SUM(metric_views), 0)::int AS views,
              COALESCE(SUM(metric_likes), 0)::int AS likes,
              COALESCE(SUM(metric_comments), 0)::int AS comments
       FROM posts
       WHERE user_id = $1 AND status = 'posted' AND posted_at >= now() - interval '7 days'
       GROUP BY day`,
      [req.user.id]
    );
    const byDay = new Map(dayRows.map((r) => [r.day, r]));
    const days = [];
    for (let i = DAYS_IN_CHART - 1; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const key = dateKey(d);
      const found = byDay.get(key);
      days.push({ date: key, views: found?.views ?? 0, likes: found?.likes ?? 0, comments: found?.comments ?? 0 });
    }

    const { rows: totalsRows } = await pool.query(
      `SELECT COALESCE(SUM(metric_views), 0)::int AS views,
              COALESCE(SUM(metric_likes), 0)::int AS likes,
              COALESCE(SUM(metric_comments), 0)::int AS comments,
              COALESCE(SUM(metric_shares), 0)::int AS shares,
              COUNT(*) FILTER (WHERE metrics_updated_at IS NOT NULL) AS posts_with_metrics,
              COUNT(*) AS posts_posted
       FROM posts
       WHERE user_id = $1 AND status = 'posted'`,
      [req.user.id]
    );
    const totals = totalsRows[0];

    const { rows: topRows } = await pool.query(
      `SELECT posts.id, posts.content, posts.metric_views, posts.metric_likes, posts.metric_comments,
              posts.posted_at, social_accounts.platform
       FROM posts
       JOIN social_accounts ON social_accounts.id = posts.social_account_id
       WHERE posts.user_id = $1 AND posts.status = 'posted' AND posts.posted_at >= now() - interval '7 days'
         AND (posts.metric_views IS NOT NULL OR posts.metric_likes IS NOT NULL)
       ORDER BY COALESCE(posts.metric_views, posts.metric_likes, 0) DESC
       LIMIT 1`,
      [req.user.id]
    );

    res.json({
      days,
      totals: {
        views: totals.views,
        likes: totals.likes,
        comments: totals.comments,
        shares: totals.shares,
      },
      postsWithMetrics: Number(totals.posts_with_metrics),
      postsPosted: Number(totals.posts_posted),
      topPost: topRows[0] || null,
    });
  })
);

export default router;
