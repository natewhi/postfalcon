import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { PLANS, limitsForPlan, isEntitled, planHasCapability } from '../lib/billing.js';

async function countAccounts(userId) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM social_accounts WHERE user_id = $1', [userId]);
  return rows[0].n;
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

function notEntitled(res) {
  return res.status(402).json({
    error: 'plan_inactive',
    message: 'Your trial or subscription has ended. Reactivate at /pricing to keep publishing.',
  });
}

// Blocks mutating actions once the trial/subscription has lapsed (plan_status not
// active / trialing / past_due).
export function requireActivePlan(req, res, next) {
  if (!isEntitled(req.user)) return notEntitled(res);
  next();
}

// Gates a route to plans whose `capabilities[cap]` is true.
export function requireCapability(cap) {
  return (req, res, next) => {
    if (!isEntitled(req.user)) return notEntitled(res);
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
  if (!isEntitled(req.user)) return notEntitled(res);
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
  if (!isEntitled(req.user)) return notEntitled(res);

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
// true when a brand-new account would exceed the cap (or the plan is inactive). Existing
// accounts can still reconnect (token refresh) regardless.
export async function atAccountLimit(user) {
  if (!isEntitled(user)) return true;
  const max = limitsForPlan(user.plan).accounts;
  return max !== Infinity && (await countAccounts(user.id)) >= max;
}
