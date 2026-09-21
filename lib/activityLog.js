import { pool } from '../db/pool.js';

const RETENTION_DAYS = Number(process.env.ACTIVITY_LOG_RETENTION_DAYS) || 90;
const PRODUCT_EVENT_RETENTION_DAYS = Number(process.env.PRODUCT_EVENT_RETENTION_DAYS) || 365;

export async function logPageVisit(req) {
  // originalUrl (not path) so a query string survives — e.g. /signup?plan=team from a pricing
  // click is distinguishable in the admin console from a plain, unattributed /signup visit.
  await pool.query('INSERT INTO page_visits (user_id, path, ip_address, user_agent) VALUES ($1, $2, $3, $4)', [
    req.user?.id ?? null,
    req.originalUrl,
    req.ip,
    req.headers['user-agent'] ?? null,
  ]);
}

export async function logAuthEvent(req, eventType, { userId = null, email = null } = {}) {
  await pool.query(
    'INSERT INTO auth_events (user_id, email, event_type, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, eventType, req.ip, req.headers['user-agent'] ?? null]
  );
}

// No req here (unlike logPageVisit/logAuthEvent): product events are also raised from
// background jobs (see scheduler.js's post_published/post_failed), which have no request
// to pull ip/user-agent from and where that data isn't the point — this table is about
// what users did, not where from.
export async function logProductEvent(userId, eventName, metadata = null) {
  await pool.query('INSERT INTO product_events (user_id, event_name, metadata) VALUES ($1, $2, $3)', [
    userId,
    eventName,
    metadata ? JSON.stringify(metadata) : null,
  ]);
}

// Age-based pruning only — rows for deleted accounts are already kept (see migrations
// 008/009), so this doesn't need to special-case them. product_events uses its own,
// longer retention window since usage trends are useful over a longer horizon than the
// security audit tables.
export async function cleanupOldActivityLogs() {
  const visits = await pool.query(`DELETE FROM page_visits WHERE created_at < now() - ($1 || ' days')::interval`, [
    RETENTION_DAYS,
  ]);
  const events = await pool.query(`DELETE FROM auth_events WHERE created_at < now() - ($1 || ' days')::interval`, [
    RETENTION_DAYS,
  ]);
  const productEvents = await pool.query(
    `DELETE FROM product_events WHERE created_at < now() - ($1 || ' days')::interval`,
    [PRODUCT_EVENT_RETENTION_DAYS]
  );
  return { visitsRemoved: visits.rowCount, eventsRemoved: events.rowCount, productEventsRemoved: productEvents.rowCount };
}
