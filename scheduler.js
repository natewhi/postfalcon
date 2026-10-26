import cron from 'node-cron';
import path from 'node:path';
import { pool } from './db/pool.js';
import { copyMedia, mediaUrl } from './lib/storage.js';
import { isEntitled, billingConfigured } from './lib/billing.js';
import { reconcileSubscriptions } from './lib/billingSync.js';
import { markSchedulerStarted, markSchedulerTick } from './lib/schedulerHeartbeat.js';
import { runBackup } from './lib/backup.js';
import { checkAlerts } from './lib/alerts.js';
import { pruneServerErrors } from './lib/errorLog.js';
import { ensurePlatformSettingsLoaded } from './lib/platformSettings.js';
import { cleanupOldMedia } from './lib/mediaCleanup.js';
import { cleanupOldActivityLogs, logProductEvent } from './lib/activityLog.js';
import { logger } from './lib/logger.js';
import { getAdapter, PLATFORM_IDS, PLATFORMS, isPlatformPaused } from './lib/platforms.js';
import { deliverWebhooks } from './lib/webhooks.js';
import { looksLikeAuthFailure, markNeedsReconnect, clearNeedsReconnect } from './lib/reconnect.js';

function addInterval(date, interval) {
  const d = new Date(date);
  if (interval === 'daily') d.setDate(d.getDate() + 1);
  else if (interval === 'weekly') d.setDate(d.getDate() + 7);
  else if (interval === 'monthly') d.setMonth(d.getMonth() + 1);
  return d;
}

// Copy a post's media files (so the daily cleanup job can't delete a file a live post still
// references) and attach them to the new post.
async function cloneMedia(fromPostId, toPostId) {
  const { rows } = await pool.query(
    'SELECT url, media_type, alt_text, position FROM post_media WHERE post_id = $1 ORDER BY position',
    [fromPostId]
  );
  for (const m of rows) {
    let newName;
    try {
      newName = await copyMedia(path.basename(m.url));
    } catch {
      continue;
    }
    await pool.query(
      'INSERT INTO post_media (post_id, url, media_type, alt_text, position) VALUES ($1, $2, $3, $4, $5)',
      [toPostId, mediaUrl(newName), m.media_type, m.alt_text, m.position]
    );
  }
}

// After a recurring post publishes, queue the next occurrence (unless it's past repeat_until,
// or a one-year safety cap).
async function scheduleNextOccurrence(post) {
  if (!post.repeat_interval || !post.scheduled_for) return;
  const next = addInterval(post.scheduled_for, post.repeat_interval);
  const hardCap = new Date(Date.now() + 366 * 24 * 60 * 60 * 1000);
  const until = post.repeat_until ? new Date(post.repeat_until) : hardCap;
  if (next > until || next > hardCap) return;

  const { rows } = await pool.query(
    `INSERT INTO posts
       (user_id, social_account_id, content, status, scheduled_for, repeat_interval, repeat_until, repeat_parent_id,
        crosspost_group_id, platform_options)
     VALUES ($1, $2, $3, 'scheduled', $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      post.user_id,
      post.social_account_id,
      post.content,
      next,
      post.repeat_interval,
      post.repeat_until,
      post.repeat_parent_id || post.id,
      post.crosspost_group_id,
      post.platform_options ?? {},
    ]
  );
  await cloneMedia(post.id, rows[0].id);
}

// Per-platform publishing lives in lib/platforms/<id>.js, keyed by the registry in
// lib/platforms.js. `sendPost` below just dispatches to the right adapter (or no-ops for a
// stub / unsupported platform).
async function sendPost(post) {
  const adapter = getAdapter(post.platform);
  if (adapter) {
    return adapter.publish(post);
  }
  logger.info(
    { socialAccountId: post.social_account_id, platform: post.platform },
    '[stub] posting to account'
  );
  return null;
}

// A due post that isn't attempted at all (lapsed plan, platform switched off): marked failed
// with the reason, and reported to the user's post.failed webhooks like any other failure.
async function failWithoutSending(post, message) {
  await pool.query(`UPDATE posts SET status = 'failed', error_message = $2 WHERE id = $1`, [post.id, message]);
  deliverWebhooks(post.user_id, 'post.failed', { post_id: post.id, platform: post.platform, error: message }).catch(() => {});
}

export async function processDuePosts() {
  // The admin platform switches (paused platforms) must be known before deciding what to send.
  await ensurePlatformSettingsLoaded();
  const { rows: due } = await pool.query(`
    SELECT posts.*, social_accounts.platform, social_accounts.access_token, social_accounts.refresh_token,
           social_accounts.token_expires_at, social_accounts.metadata, social_accounts.external_account_id,
           users.plan_status AS user_plan_status, users.suspended_at AS user_suspended_at
    FROM posts
    JOIN social_accounts ON social_accounts.id = posts.social_account_id
    JOIN users ON users.id = posts.user_id
    WHERE posts.status = 'scheduled' AND posts.scheduled_for <= now()
    ORDER BY posts.scheduled_for
  `);

  if (due.length > 0) {
    const mediaResult = await pool.query('SELECT * FROM post_media WHERE post_id = ANY($1) ORDER BY position', [
      due.map((p) => p.id),
    ]);
    const mediaByPost = new Map();
    for (const row of mediaResult.rows) {
      if (!mediaByPost.has(row.post_id)) mediaByPost.set(row.post_id, []);
      mediaByPost.get(row.post_id).push(row);
    }
    for (const post of due) {
      post.media = mediaByPost.get(post.id) || [];
    }
  }

  for (const post of due) {
    // An admin suspended the account (Admin -> Customers): nothing of theirs goes out.
    if (post.user_suspended_at) {
      await failWithoutSending(post, 'Not published: this account is suspended. Contact the site admin.');
      continue;
    }
    // Publishing is what a plan pays for. Posts queued (or recurring) before a trial or
    // subscription lapsed fail here instead of going out for free, and a recurring one stops
    // cloning itself. The user can retry them once they've reactivated.
    if (!isEntitled({ plan_status: post.user_plan_status })) {
      await failWithoutSending(
        post,
        'Not published: your Postfalcon trial or subscription has ended. Reactivate at /pricing, then retry this post.'
      );
      continue;
    }
    // A platform switched off on the admin Platforms page doesn't publish either.
    if (isPlatformPaused(post.platform)) {
      await failWithoutSending(
        post,
        `Not published: ${PLATFORMS[post.platform]?.label ?? post.platform} is temporarily unavailable on Postfalcon. Retry this post once it's back.`
      );
      continue;
    }
    await pool.query(`UPDATE posts SET status = 'posting' WHERE id = $1`, [post.id]);
    try {
      const platformPostId = await sendPost(post);
      await clearNeedsReconnect(post.social_account_id).catch((err) =>
        logger.error({ err, socialAccountId: post.social_account_id }, 'failed to clear reconnect flag')
      );
      await pool.query(`UPDATE posts SET status = 'posted', posted_at = now(), platform_post_id = $2 WHERE id = $1`, [
        post.id,
        platformPostId,
      ]);
      await logProductEvent(post.user_id, 'post_published', {
        postId: post.id,
        socialAccountId: post.social_account_id,
        platform: post.platform,
      }).catch((err) => logger.error({ err }, 'failed to record product event'));
      await scheduleNextOccurrence(post).catch((err) =>
        logger.error({ err, postId: post.id }, 'failed to schedule the next recurring occurrence')
      );
      // First metrics read right away, so Analytics shows the new post's (zero) counts instead
      // of "—" until the next 3-hourly refreshPostMetrics() run. Best effort.
      if (platformPostId) {
        await storePostMetrics({ ...post, platform_post_id: platformPostId }).catch((err) =>
          logger.warn({ err, postId: post.id, platform: post.platform }, 'initial metrics fetch failed')
        );
      }
      deliverWebhooks(post.user_id, 'post.published', {
        post_id: post.id,
        platform: post.platform,
        platform_post_id: platformPostId,
        scheduled_for: post.scheduled_for,
      }).catch(() => {});
    } catch (err) {
      await pool.query(`UPDATE posts SET status = 'failed', error_message = $2 WHERE id = $1`, [
        post.id,
        err.message,
      ]);
      if (looksLikeAuthFailure(err)) {
        await markNeedsReconnect(post.social_account_id, err.message).catch((markErr) =>
          logger.error({ err: markErr, socialAccountId: post.social_account_id }, 'failed to flag account for reconnect')
        );
      }
      await logProductEvent(post.user_id, 'post_failed', {
        postId: post.id,
        socialAccountId: post.social_account_id,
        platform: post.platform,
      }).catch((logErr) => logger.error({ err: logErr }, 'failed to record product event'));
      deliverWebhooks(post.user_id, 'post.failed', {
        post_id: post.id,
        platform: post.platform,
        error: err.message,
      }).catch(() => {});
    }
  }
}

// Refreshes metric_views/likes/comments/shares on recently-posted posts (last 30 days — older
// posts rarely gain much more, and this bounds how many API calls the job makes each run), one
// platform API call per post. Only platforms whose adapter exports fetchMetrics are touched
// (Telegram and TikTok don't currently have one) — everything else silently skips. A failure
// fetching one post's metrics (rate limit, revoked token, deleted post) is logged and skipped,
// not fatal to the run, same isolation as processDuePosts below.
// Fetches one posted post's metrics through its adapter and stores them. Returns false if the
// adapter has no fetchMetrics or the platform returned nothing.
async function storePostMetrics(post) {
  const adapter = getAdapter(post.platform);
  if (!adapter?.fetchMetrics) return false;
  const metrics = await adapter.fetchMetrics(post);
  if (!metrics) return false;
  await pool.query(
    `UPDATE posts
     SET metric_views = $2, metric_likes = $3, metric_comments = $4, metric_shares = $5, metrics_updated_at = now()
     WHERE id = $1`,
    [post.id, metrics.views, metrics.likes, metrics.comments, metrics.shares]
  );
  return true;
}

export async function refreshPostMetrics() {
  await ensurePlatformSettingsLoaded();
  const { rows: posts } = await pool.query(`
    SELECT posts.id, posts.platform_post_id, posts.social_account_id,
           social_accounts.platform, social_accounts.access_token, social_accounts.refresh_token,
           social_accounts.token_expires_at, social_accounts.metadata, social_accounts.external_account_id
    FROM posts
    JOIN social_accounts ON social_accounts.id = posts.social_account_id
    WHERE posts.status = 'posted'
      AND posts.platform_post_id IS NOT NULL
      AND posts.posted_at >= now() - interval '30 days'
  `);

  let refreshed = 0;
  for (const post of posts) {
    // Paused platforms skip this too: no API calls (which X, for one, charges for).
    if (!getAdapter(post.platform)?.fetchMetrics || isPlatformPaused(post.platform)) continue;
    try {
      if (await storePostMetrics(post)) refreshed++;
    } catch (err) {
      logger.error({ err, postId: post.id, platform: post.platform }, 'failed to refresh post metrics');
      if (looksLikeAuthFailure(err)) {
        await markNeedsReconnect(post.social_account_id, err.message).catch(() => {});
      }
    }
  }
  return { checked: posts.length, refreshed };
}

// Daily: lets an adapter refresh (or, if access was revoked, delete) whatever API data it
// keeps beyond what refreshPostMetrics() covers — for platforms whose terms require stored
// data to stay fresh (currently only YouTube exports refreshStoredData). Same per-item
// isolation as refreshPostMetrics: one account failing doesn't stop the rest.
export async function refreshStoredPlatformData() {
  const platforms = PLATFORM_IDS.filter((id) => getAdapter(id)?.refreshStoredData);
  if (platforms.length === 0) return { checked: 0, revoked: 0 };
  const { rows: accounts } = await pool.query(
    `SELECT id, platform, access_token, refresh_token, token_expires_at FROM social_accounts
     WHERE platform = ANY($1)`,
    [platforms]
  );

  let revoked = 0;
  for (const account of accounts) {
    try {
      const result = await getAdapter(account.platform).refreshStoredData(account);
      if (result?.revoked) {
        revoked++;
        await markNeedsReconnect(account.id, 'Access was revoked or expired on the platform side.');
      }
    } catch (err) {
      logger.error({ err, socialAccountId: account.id, platform: account.platform }, 'failed to refresh stored platform data');
    }
  }
  return { checked: accounts.length, revoked };
}

export function startScheduler() {
  markSchedulerStarted();
  cron.schedule('* * * * *', () => {
    processDuePosts()
      .then(() => markSchedulerTick())
      .catch((err) => {
        markSchedulerTick(err);
        logger.error({ err }, 'scheduler error');
      });
  });

  cron.schedule('0 3 * * *', () => {
    cleanupOldMedia()
      .then(({ postsCleaned, filesRemoved }) => {
        if (postsCleaned > 0) {
          logger.info({ postsCleaned, filesRemoved }, 'media cleanup');
        }
      })
      .catch((err) => logger.error({ err }, 'media cleanup error'));
  });

  cron.schedule('0 3 * * *', () => {
    cleanupOldActivityLogs()
      .then(({ visitsRemoved, eventsRemoved }) => {
        if (visitsRemoved > 0 || eventsRemoved > 0) {
          logger.info({ visitsRemoved, eventsRemoved }, 'activity log cleanup');
        }
      })
      .catch((err) => logger.error({ err }, 'activity log cleanup error'));
  });

  cron.schedule('0 */3 * * *', () => {
    refreshPostMetrics()
      .then(({ checked, refreshed }) => {
        if (checked > 0) {
          logger.info({ checked, refreshed }, 'post metrics refresh');
        }
      })
      .catch((err) => logger.error({ err }, 'post metrics refresh error'));
  });

  cron.schedule('30 4 * * *', () => {
    refreshStoredPlatformData()
      .then(({ checked, revoked }) => {
        if (checked > 0) {
          logger.info({ checked, revoked }, 'stored platform data refresh');
        }
      })
      .catch((err) => logger.error({ err }, 'stored platform data refresh error'));
  });

  // Admin alert emails (lib/alerts.js): problems that need a person, announced when they start,
  // reminded daily, reported when they clear.
  cron.schedule('*/10 * * * *', () => {
    checkAlerts()
      .then((result) => {
        if (result.raised.length || result.resolved.length) logger.info(result, 'admin alerts');
      })
      .catch((err) => logger.error({ err }, 'admin alerts check failed'));
  });

  // Server errors kept for Admin -> Activity (lib/errorLog.js) are pruned after 30 days.
  cron.schedule('15 3 * * *', () => {
    pruneServerErrors().catch((err) => logger.warn({ err }, 'server error log prune failed'));
  });

  // Nightly database backup (lib/backup.js): to the server disk, and the bucket if configured.
  cron.schedule('30 3 * * *', () => {
    runBackup()
      .then((result) => logger.info(result, 'database backup'))
      .catch((err) => logger.error({ err }, 'database backup failed'));
  });

  // Nightly billing safety net: corrects any account whose plan drifted from Stripe because a
  // webhook was missed (lib/billingSync.js). Skipped entirely when billing isn't configured.
  cron.schedule('45 4 * * *', () => {
    if (!billingConfigured()) return;
    reconcileSubscriptions()
      .then(({ checked, corrected, failed }) => {
        logger.info({ checked, corrected, failed }, 'billing reconciliation');
      })
      .catch((err) => logger.error({ err }, 'billing reconciliation error'));
  });

  logger.info(
    'Scheduler started (runs every minute); media cleanup, activity log cleanup, post metrics refresh, stored platform data refresh, admin alerts, backups and billing reconciliation run on their own schedules.'
  );
}
