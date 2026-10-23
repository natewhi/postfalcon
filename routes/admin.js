import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { billingConfigured } from '../lib/billing.js';
import { reconcileSubscriptions } from '../lib/billingSync.js';

const router = Router();

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

export default router;
