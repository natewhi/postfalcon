import crypto from 'node:crypto';
import { pool } from '../db/pool.js';

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createToken(userId, purpose, ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMs);
  await pool.query('INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, $4)', [
    userId,
    purpose,
    hashToken(token),
    expiresAt,
  ]);
  return token;
}

export async function consumeToken(token, purpose) {
  const result = await pool.query(
    `DELETE FROM user_tokens WHERE token_hash = $1 AND purpose = $2 AND expires_at > now() RETURNING user_id`,
    [hashToken(token), purpose]
  );
  return result.rows[0]?.user_id ?? null;
}
