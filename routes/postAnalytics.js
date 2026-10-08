import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

const RANGES = [7, 30, 90];
const DEFAULT_RANGE = 7;
const POSTS_LISTED = 20;

// Days are bucketed in the viewer's own timezone (?tz=, an IANA name like
// "Australia/Sydney"), so "today" matches their calendar. Postgres is the validator: an
// unknown name makes AT TIME ZONE throw, and we fall back to UTC.
async function resolveTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return 'UTC';
  try {
    await pool.query('SELECT now() AT TIME ZONE $1', [tz]);
    return tz;
  } catch {
    return 'UTC';
  }
}

const toInt = (v) => (v == null ? null : Number(v));

// Everything the user actually owns is fetched from metric_* columns on `posts` — refreshed
// periodically by scheduler.js's refreshPostMetrics(), not computed here. This endpoint just
// aggregates what's already been fetched. A metric comes back null (not 0) when none of the
// posts it covers reports it — e.g. TikTok/Telegram, which have no metrics API — so the UI
// can say "not reported" rather than "zero".
//
// The per-day series, period figures, platform breakdown and posts list all cover posts
// *published* in the selected range (?days=7|30|90), grouped by publish day. `totals`,
// `postsPosted`, `postsWithMetrics` and `topPost` are kept as before (all-time totals; top
// post of the last 7 days) for existing API/MCP callers.
router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const days = RANGES.includes(Number(req.query.days)) ? Number(req.query.days) : DEFAULT_RANGE;
    const tz = await resolveTimeZone(req.query.tz);
    // $2 = timezone, $3 = range length in days. rangeStart is midnight (in tz) of the first day.
    const firstDay = `((now() AT TIME ZONE $2)::date - ($3::int - 1))`;
    const rangeStart = `(${firstDay})::timestamp AT TIME ZONE $2`;
    const params = [req.user.id, tz, days];

    const { rows: dayRows } = await pool.query(
      `WITH day_list AS (
         SELECT generate_series(${firstDay}, (now() AT TIME ZONE $2)::date, interval '1 day')::date AS day
       )
       SELECT to_char(day_list.day, 'YYYY-MM-DD') AS date,
              COUNT(p.id)::int AS published,
              COALESCE(SUM(p.metric_views), 0)::int AS views,
              COALESCE(SUM(p.metric_likes), 0)::int AS likes,
              COALESCE(SUM(p.metric_comments), 0)::int AS comments,
              COALESCE(SUM(p.metric_shares), 0)::int AS shares
       FROM day_list
       LEFT JOIN posts p
         ON p.user_id = $1 AND p.status = 'posted' AND (p.posted_at AT TIME ZONE $2)::date = day_list.day
       GROUP BY day_list.day
       ORDER BY day_list.day`,
      params
    );

    const { rows: periodRows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'posted' AND posted_at >= ${rangeStart})::int AS published,
              COUNT(*) FILTER (WHERE status = 'failed' AND updated_at >= ${rangeStart})::int AS failed,
              COUNT(*) FILTER (WHERE status = 'scheduled')::int AS scheduled,
              SUM(metric_views) FILTER (WHERE status = 'posted' AND posted_at >= ${rangeStart}) AS views,
              SUM(metric_likes) FILTER (WHERE status = 'posted' AND posted_at >= ${rangeStart}) AS likes,
              SUM(metric_comments) FILTER (WHERE status = 'posted' AND posted_at >= ${rangeStart}) AS comments,
              SUM(metric_shares) FILTER (WHERE status = 'posted' AND posted_at >= ${rangeStart}) AS shares,
              -- Engagement rate only over posts that report views, so platforms without view
              -- counts don't inflate it.
              SUM(COALESCE(metric_likes, 0) + COALESCE(metric_comments, 0) + COALESCE(metric_shares, 0))
                FILTER (WHERE status = 'posted' AND posted_at >= ${rangeStart} AND metric_views > 0) AS engaged_on_viewed,
              SUM(metric_views)
                FILTER (WHERE status = 'posted' AND posted_at >= ${rangeStart} AND metric_views > 0) AS viewed
       FROM posts
       WHERE user_id = $1`,
      params
    );
    const p = periodRows[0];
    const period = {
      published: p.published,
      failed: p.failed,
      scheduled: p.scheduled,
      views: toInt(p.views),
      likes: toInt(p.likes),
      comments: toInt(p.comments),
      shares: toInt(p.shares),
      engagementRate: p.viewed > 0 ? Number(p.engaged_on_viewed) / Number(p.viewed) : null,
    };

    const { rows: platformRows } = await pool.query(
      `SELECT sa.platform,
              COUNT(*)::int AS posts,
              SUM(p.metric_views) AS views,
              SUM(p.metric_likes) AS likes,
              SUM(p.metric_comments) AS comments,
              SUM(p.metric_shares) AS shares
       FROM posts p
       JOIN social_accounts sa ON sa.id = p.social_account_id
       WHERE p.user_id = $1 AND p.status = 'posted' AND p.posted_at >= ${rangeStart}
       GROUP BY sa.platform
       ORDER BY posts DESC, sa.platform`,
      params
    );
    const platforms = platformRows.map((r) => ({
      platform: r.platform,
      posts: r.posts,
      views: toInt(r.views),
      likes: toInt(r.likes),
      comments: toInt(r.comments),
      shares: toInt(r.shares),
    }));

    const { rows: postRows } = await pool.query(
      `SELECT p.id, p.content, p.posted_at, p.metric_views, p.metric_likes, p.metric_comments, p.metric_shares,
              sa.platform, sa.display_name AS account_display_name
       FROM posts p
       JOIN social_accounts sa ON sa.id = p.social_account_id
       WHERE p.user_id = $1 AND p.status = 'posted' AND p.posted_at >= ${rangeStart}
       ORDER BY COALESCE(p.metric_views, -1) DESC,
                COALESCE(p.metric_likes, 0) + COALESCE(p.metric_comments, 0) + COALESCE(p.metric_shares, 0) DESC,
                p.posted_at DESC
       LIMIT ${POSTS_LISTED}`,
      params
    );

    const { rows: totalsRows } = await pool.query(
      `SELECT COALESCE(SUM(metric_views), 0)::int AS views,
              COALESCE(SUM(metric_likes), 0)::int AS likes,
              COALESCE(SUM(metric_comments), 0)::int AS comments,
              COALESCE(SUM(metric_shares), 0)::int AS shares,
              COUNT(*) FILTER (WHERE metrics_updated_at IS NOT NULL) AS posts_with_metrics,
              COUNT(*) AS posts_posted,
              MAX(metrics_updated_at) AS metrics_updated_at
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
      range: { days, timeZone: tz },
      days: dayRows,
      period,
      platforms,
      posts: postRows,
      metricsUpdatedAt: totals.metrics_updated_at,
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
