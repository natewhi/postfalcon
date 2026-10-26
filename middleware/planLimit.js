import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  PLANS,
  FREE_PLATFORMS,
  limitsForPlan,
  isEntitled,
  isFreePlatform,
  freeAccountLimit,
  planHasCapability,
} from '../lib/billing.js';

async function countAccounts(userId) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM social_accounts WHERE user_id = $1', [userId]);
  return rows[0].n;
}

// A free account's channels: only the free platforms count (a lapsed subscriber may still have
// paid-platform accounts, which neither count nor publish).
async function countFreeAccounts(userId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM social_accounts WHERE user_id = $1 AND platform = ANY($2)',
    [userId, FREE_PLATFORMS]
  );
  return rows[0].n;
}

// Whether every account a post request targets is on a free platform, for an account with no
// plan. POST names its accounts in the body; PATCH acts on an existing post's account.
async function targetsOnlyFreePlatforms(req) {
  let rows;
  if (req.method === 'PATCH') {
    ({ rows } = await pool.query(
      `SELECT sa.platform FROM posts p JOIN social_accounts sa ON sa.id = p.social_account_id
       WHERE p.id = $1 AND p.user_id = $2`,
      [Number(req.params.id) || 0, req.user.id]
    ));
  } else {
    const ids = [...(req.body.social_account_ids || []), req.body.social_account_id].filter(Boolean).map(Number);
    ({ rows } = await pool.query('SELECT platform FROM social_accounts WHERE id = ANY($1) AND user_id = $2', [
      ids,
      req.user.id,
    ]));
  }
  // No rows = not this user's post/accounts: let the route answer that (404 / validation).
  return rows.every((r) => isFreePlatform(r.platform));
}

async function countScheduledPosts(userId, excludePostId = 0) {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM posts WHERE user_id = $1 AND status = 'scheduled' AND id <> $2",
    [userId, excludePostId]
  );
  return rows[0].n;
}

function limitReached(res, plan, max, noun) {
  return res.status(402).json({
    error: 'plan_limit',
    message: `The ${PLANS[plan]?.name ?? plan} plan is limited to ${max} ${noun}. Upgrade at /pricing to add more.`,
    plan,
    limit: max,
  });
}

function notEntitled(res, user) {
  // 'incomplete' = signed up but never finished Stripe Checkout (migration 023), as opposed
  // to a trial/subscription that ran out.
  const message =
    user?.plan_status === 'incomplete'
      ? 'Mastodon, Bluesky and Telegram are free. To use other platforms, start your free trial at /pricing.'
      : 'Your trial or subscription has ended, so only Mastodon, Bluesky and Telegram still work. Reactivate at /pricing for the rest.';
  return res.status(402).json({ error: 'plan_inactive', message });
}

// Blocks mutating actions once the trial/subscription has lapsed (plan_status not
// active / trialing / past_due).
export function requireActivePlan(req, res, next) {
  if (!isEntitled(req.user)) return notEntitled(res, req.user);
  next();
}

// Gates a route to plans whose `capabilities[cap]` is true.
export function requireCapability(cap) {
  return (req, res, next) => {
    if (!isEntitled(req.user)) return notEntitled(res, req.user);
    if (!planHasCapability(req.user.plan, cap)) {
      return res.status(402).json({
        error: 'plan_capability',
        message: `${cap} is not available on the ${PLANS[req.user.plan]?.name ?? req.user.plan} plan. Upgrade at /pricing.`,
        plan: req.user.plan,
        capability: cap,
      });
    }
    next();
  };
}

// POST /api/v1/social-accounts — blocks once the user is at their plan's channel cap.
export const enforceAccountLimit = asyncHandler(async (req, res, next) => {
  if (!isEntitled(req.user)) {
    if (!isFreePlatform(req.body.platform)) return notEntitled(res, req.user);
    const max = freeAccountLimit();
    if ((await countFreeAccounts(req.user.id)) >= max) return limitReached(res, 'free', max, 'free channels');
    return next();
  }
  const max = limitsForPlan(req.user.plan).accounts;
  if (max !== Infinity && (await countAccounts(req.user.id)) >= max) {
    return limitReached(res, req.user.plan, max, 'connected channels');
  }
  next();
});

// POST /api/v1/posts (with scheduled_for) and PATCH /api/v1/posts/:id (status -> scheduled).
// Every paid plan has an unlimited queue, so this only bites when a plan is capped — but it
// still enforces entitlement. Must run after validate().
export const enforceScheduledPostLimit = asyncHandler(async (req, res, next) => {
  if (!isEntitled(req.user) && !(await targetsOnlyFreePlatforms(req))) return notEntitled(res, req.user);

  const willSchedule =
    (req.method === 'POST' && req.body.scheduled_for) ||
    (req.method === 'PATCH' && req.body.status === 'scheduled');
  if (!willSchedule) return next();

  const max = limitsForPlan(req.user.plan).scheduledPosts;
  if (max === Infinity) return next();

  const excludeId = Number(req.params.id) || 0;
  if ((await countScheduledPosts(req.user.id, excludeId)) >= max) {
    return limitReached(res, req.user.plan, max, 'scheduled posts');
  }
  next();
});

// For the OAuth connect callbacks, which create accounts outside the POST endpoint: returns
// true when a brand-new account would exceed the cap (or the plan is inactive, unless `platform`
// is a free one). Existing accounts can still reconnect (token refresh) regardless.
export async function atAccountLimit(user, platform) {
  if (!isEntitled(user)) {
    return !isFreePlatform(platform) || (await countFreeAccounts(user.id)) >= freeAccountLimit();
  }
  const max = limitsForPlan(user.plan).accounts;
  return max !== Infinity && (await countAccounts(user.id)) >= max;
}
