import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { billingConfigured, PAID_PLAN_IDS, subscriptionsFor, hasRunningSubscription } from '../lib/billing.js';
import { reconcileSubscriptions } from '../lib/billingSync.js';
import { setupChecks, schedulerStatus, publishingHealth, businessMetrics, storageStatus } from '../lib/adminStatus.js';
import { logProductEvent } from '../lib/activityLog.js';

const router = Router();

// POST /users/:id/access: grant (or take away) free access for a review or test login.
const accessSchema = z.object({
  grant: z.boolean(),
  plan: z.enum(PAID_PLAN_IDS).default('pro'),
});

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function parsePaging(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.pageSize, 10) || DEFAULT_PAGE_SIZE));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// Builds a "$1 AND $2 AND ..." WHERE clause plus its param list from a list of
// [condition, value] pairs, skipping any pair whose value is empty.
function buildWhere(conditions) {
  const clauses = [];
  const params = [];
  for (const [sql, value] of conditions) {
    if (value === undefined || value === null || value === '') continue;
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// Shared shape across the three endpoints below: a handful of optional equality/range
// filters over a paginated, most-recent-first list, with a count for the pager.
async function paginatedQuery(req, res, { select, from, conditions, orderBy }) {
  const { page, pageSize, offset } = parsePaging(req);
  const { where, params } = buildWhere(conditions);

  const countResult = await pool.query(`SELECT COUNT(*) FROM ${from} ${where}`, params);
  const rowsResult = await pool.query(
    `SELECT ${select} FROM ${from} ${where} ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );

  res.json({ rows: rowsResult.rows, total: Number(countResult.rows[0].count), page, pageSize });
}

router.get(
  '/auth-events',
  asyncHandler(async (req, res) => {
    const { email, eventType, from, to } = req.query;
    await paginatedQuery(req, res, {
      select: '*',
      from: 'auth_events',
      conditions: [
        ['email ILIKE ?', email ? `%${email}%` : undefined],
        ['event_type = ?', eventType],
        ['created_at >= ?', from],
        ['created_at <= ?', to],
      ],
      orderBy: 'created_at DESC',
    });
  })
);

router.get(
  '/page-visits',
  asyncHandler(async (req, res) => {
    const { email, path, from, to } = req.query;
    await paginatedQuery(req, res, {
      select: 'pv.*, u.email',
      from: 'page_visits pv LEFT JOIN users u ON u.id = pv.user_id',
      conditions: [
        ['u.email ILIKE ?', email ? `%${email}%` : undefined],
        ['pv.path ILIKE ?', path ? `%${path}%` : undefined],
        ['pv.created_at >= ?', from],
        ['pv.created_at <= ?', to],
      ],
      orderBy: 'pv.created_at DESC',
    });
  })
);

router.get(
  '/product-events',
  asyncHandler(async (req, res) => {
    const { email, eventName, from, to } = req.query;
    await paginatedQuery(req, res, {
      select: 'pe.*, u.email',
      from: 'product_events pe LEFT JOIN users u ON u.id = pe.user_id',
      conditions: [
        ['u.email ILIKE ?', email ? `%${email}%` : undefined],
        ['pe.event_name = ?', eventName],
        ['pe.created_at >= ?', from],
        ['pe.created_at <= ?', to],
      ],
      orderBy: 'pe.created_at DESC',
    });
  })
);

// Every account's billing state as Postfalcon holds it (the webhook-maintained copy of Stripe).
router.get(
  '/billing',
  asyncHandler(async (req, res) => {
    const { email, status } = req.query;
    await paginatedQuery(req, res, {
      select: `id, email, plan, plan_status, plan_renews_at, plan_cancels_at, stripe_customer_id, is_admin, created_at`,
      from: 'users',
      conditions: [
        ['email ILIKE ?', email ? `%${email}%` : undefined],
        ['plan_status = ?', status],
      ],
      orderBy: 'created_at DESC',
    });
  })
);

// Runs the nightly billing reconciliation now: re-reads every subscriber from Stripe and
// corrects any account that has drifted. Returns how many were checked/corrected.
router.post(
  '/billing/reconcile',
  asyncHandler(async (req, res) => {
    if (!billingConfigured()) {
      return res.status(503).json({ error: 'billing_unavailable', message: 'Billing is not configured on this server.' });
    }
    res.json(await reconcileSubscriptions());
  })
);

// Everything on the Overview page in one call. Each part is independent: one failing (Stripe
// or the bucket unreachable) comes back as { error } instead of failing the whole page.
router.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const parts = { setup: setupChecks, scheduler: schedulerStatus, publishing: publishingHealth, business: businessMetrics, storage: storageStatus };
    const entries = await Promise.all(
      Object.entries(parts).map(async ([key, load]) => {
        try {
          return [key, await load()];
        } catch (err) {
          req.log.error({ err, part: key }, 'admin overview part failed');
          return [key, { error: err.message }];
        }
      })
    );
    res.json(Object.fromEntries(entries));
  })
);

// Customer lookup: search by email (newest first).
router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const { rows } = await pool.query(
      `SELECT id, email, plan, plan_status, is_admin, created_at FROM users
       WHERE ($1 = '' OR email ILIKE '%' || $1 || '%')
       ORDER BY created_at DESC LIMIT 25`,
      [q]
    );
    res.json(rows);
  })
);

function stripeDashboardUrl(customerId) {
  if (!customerId) return null;
  const test = (process.env.STRIPE_SECRET_KEY || '').includes('_test_');
  return `https://dashboard.stripe.com/${test ? 'test/' : ''}customers/${customerId}`;
}

// One customer, for support: account, billing, connected channels, recent posts.
router.get(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await pool.query(
      `SELECT id, email, created_at, email_verified_at, google_id IS NOT NULL AS google_login, is_admin,
              plan, plan_status, plan_interval, plan_renews_at, plan_cancels_at, stripe_customer_id
       FROM users WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    const user = rows[0];
    const [accounts, posts, counts] = await Promise.all([
      pool.query(
        `SELECT id, platform, display_name, needs_reconnect_at, reconnect_reason, created_at
         FROM social_accounts WHERE user_id = $1 ORDER BY created_at`,
        [id]
      ),
      pool.query(
        `SELECT p.id, p.status, p.content, p.scheduled_for, p.posted_at, p.updated_at, p.error_message, sa.platform
         FROM posts p JOIN social_accounts sa ON sa.id = p.social_account_id
         WHERE p.user_id = $1 ORDER BY p.updated_at DESC LIMIT 20`,
        [id]
      ),
      pool.query(`SELECT status, COUNT(*)::int AS n FROM posts WHERE user_id = $1 GROUP BY status`, [id]),
    ]);
    res.json({
      user: { ...user, stripeDashboardUrl: stripeDashboardUrl(user.stripe_customer_id) },
      accounts: accounts.rows,
      recentPosts: posts.rows.map((p) => ({ ...p, content: p.content.slice(0, 140) })),
      postCounts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
    });
  })
);

// Free access for a review or test login, or taking it away, without SQL on the server. Refused
// for anyone with a running Stripe subscription: Stripe is the source of truth for them, and the
// webhook / nightly reconciliation would undo the change anyway.
router.post(
  '/users/:id/access',
  validate(accessSchema),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await pool.query('SELECT id, stripe_customer_id FROM users WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });

    if (rows[0].stripe_customer_id && billingConfigured()) {
      if (hasRunningSubscription(await subscriptionsFor(rows[0].stripe_customer_id))) {
        return res.status(409).json({
          error: 'has_subscription',
          message: 'This customer has a Stripe subscription. Change their plan in Stripe instead.',
        });
      }
    }

    const { grant, plan } = req.body;
    const { rows: updated } = await pool.query(
      grant
        ? `UPDATE users SET plan = $2, plan_status = 'active', plan_renews_at = NULL, plan_cancels_at = NULL
           WHERE id = $1 RETURNING id, email, plan, plan_status`
        : `UPDATE users SET plan_status = 'canceled', plan_cancels_at = NULL WHERE id = $1
           RETURNING id, email, plan, plan_status`,
      grant ? [id, plan] : [id]
    );
    await logProductEvent(id, 'admin_access_changed', { grant, plan: grant ? plan : undefined, by: req.user.id }).catch(
      (err) => req.log.error({ err }, 'failed to record product event')
    );
    res.json(updated[0]);
  })
);

export default router;
