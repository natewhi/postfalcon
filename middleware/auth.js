import { pool } from '../db/pool.js';
import { hashToken } from '../lib/tokens.js';

async function authenticateBearerToken(req) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;

  const token = header.slice(7).trim();
  if (!token) return null;

  const tokenHash = hashToken(token);
  const result = await pool.query(
    `SELECT users.id, users.email, users.email_verified_at, users.created_at
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
