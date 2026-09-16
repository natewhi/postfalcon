import { pool } from '../db/pool.js';
import { hashToken } from '../lib/tokens.js';

async function authenticateBearerToken(req) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;

  const token = header.slice(7).trim();
  if (!token) return null;

  const tokenHash = hashToken(token);
  const result = await pool.query(
    `SELECT users.id, users.email, users.email_verified_at, users.created_at,
            users.stripe_customer_id, users.plan, users.plan_status, users.plan_renews_at
     FROM api_tokens
     JOIN users ON users.id = api_tokens.user_id
     WHERE api_tokens.token_hash = $1`,
    [tokenHash]
  );
  if (result.rows.length === 0) return null;

  pool.query('UPDATE api_tokens SET last_used_at = now() WHERE token_hash = $1', [tokenHash]).catch(() => {});
  return result.rows[0];
}

export async function requireAuth(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }

  const user = await authenticateBearerToken(req);
  if (user) {
    req.user = user;
    return next();
  }

  res.status(401).json({ error: 'not authenticated' });
}

export function requirePageAuth(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.redirect('/login');
  }
  next();
}

// Session-only (unlike requireAuth, no Bearer token path) — this gates a human-operated
// admin console, not part of the agent/API surface. Responds 404, not 401/403, for both
// "not logged in" and "logged in but not admin", so probing /admin/* doesn't confirm the
// route exists to anyone who isn't already an admin — same reasoning as forgot-password
// never revealing whether an email is registered. Covers both the admin page (rendered
// 404) and its backing JSON endpoints (json 404), based on the request path.
export function requireAdmin(req, res, next) {
  if (req.isAuthenticated() && req.user.is_admin) {
    return next();
  }
  // originalUrl, not path/url: this middleware is mounted at /api/admin (see app.js), and
  // Express strips the mount prefix from req.url/req.path for the duration of that layer —
  // only originalUrl still has it, which is what the /api/ prefix check needs.
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(404).json({ error: 'not found' });
  }
  res.status(404).render('404');
}
