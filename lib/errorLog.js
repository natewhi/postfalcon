import { pool } from '../db/pool.js';

// Keeps error-level log lines in server_errors (migration 031) for Admin -> Activity, fed by the
// hook in lib/logger.js, so whatever any part of the app logs as an error (a request, the
// scheduler, a platform adapter) can be read without access to the server's logs.
//
// Best effort by design: writes are fire-and-forget, capped per minute so an error storm can't
// turn into a database storm, and a failure here is swallowed rather than logged (logging it
// as an error would feed straight back into this).

const MAX_PER_MINUTE = 60;
const KEEP_DAYS = 30;
let windowStart = 0;
let windowCount = 0;

function clip(value, max) {
  if (value == null) return null;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function recordServerError({ message, err, method, url }) {
  const now = Date.now();
  if (now - windowStart > 60000) {
    windowStart = now;
    windowCount = 0;
  }
  if (++windowCount > MAX_PER_MINUTE) return Promise.resolve();

  return pool
    .query(
      `INSERT INTO server_errors (message, error_type, error_message, stack, method, url)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        clip(message, 500),
        clip(err?.name ?? err?.type, 100),
        clip(err?.message, 2000),
        clip(err?.stack, 8000),
        clip(method, 10),
        clip(url, 500),
      ]
    )
    .catch(() => {});
}

export async function listServerErrors({ limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, created_at, message, error_type, error_message, stack, method, url
     FROM server_errors ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function countServerErrorsSince(since) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM server_errors WHERE created_at > $1', [since]);
  return rows[0].n;
}

export async function pruneServerErrors() {
  const { rowCount } = await pool.query(
    `DELETE FROM server_errors WHERE created_at < now() - make_interval(days => $1)`,
    [KEEP_DAYS]
  );
  return rowCount;
}

// For lib/logger.js: pulls the message, error and (for a request's logger) method and URL out of
// one pino call. pino takes (obj, msg), (err, msg) or (msg).
export function errorFromLogCall(args, bindings) {
  const [first, second] = args;
  let message = null;
  let err = null;
  if (typeof first === 'string') {
    message = first;
  } else if (first instanceof Error) {
    err = first;
    message = typeof second === 'string' ? second : first.message;
  } else if (first && typeof first === 'object') {
    err = first.err instanceof Error || first.err?.message ? first.err : first.error instanceof Error ? first.error : null;
    message = typeof second === 'string' ? second : first.msg ?? null;
  }
  const req = bindings?.req;
  return { message, err, method: req?.method ?? null, url: req?.url ?? null };
}
