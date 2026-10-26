import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { hashToken } from './tokens.js';
import { readInstanceSettings, saveInstanceSetting } from './instanceSettings.js';

// Who may create an account on this instance (migration 029), set from Admin -> Customers:
//   open    - anyone (the default, and what postfalcon.co runs)
//   invite  - only with a one-time invite link an admin created
//   closed  - nobody new
// The first account on a fresh install is always allowed whatever the mode, so an operator
// can't lock themselves out before they exist (it becomes the admin, migration 028).
// Both ways to create an account go through signupGate(): POST /api/users and a first
// "Sign in with Google" (routes/auth.js).

export const SIGNUP_MODES = ['open', 'invite', 'closed'];
export const INVITE_TTL_DAYS = 14;

export async function getSignupMode() {
  const { signup_mode: mode } = await readInstanceSettings();
  return SIGNUP_MODES.includes(mode) ? mode : 'open';
}

export async function setSignupMode(mode, userId) {
  await saveInstanceSetting('signup_mode', mode, userId);
}

// Returns the raw token once; only its hash is stored.
export async function createInvite({ note = null, userId }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const { rows } = await pool.query(
    `INSERT INTO invites (token_hash, note, created_by, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))
     RETURNING id, note, created_at, expires_at`,
    [hashToken(token), note, userId, INVITE_TTL_DAYS]
  );
  return { invite: rows[0], token };
}

export function inviteUrl(token) {
  return `${process.env.BASE_URL}/signup?invite=${encodeURIComponent(token)}`;
}

export async function listInvites() {
  const { rows } = await pool.query(
    `SELECT i.id, i.note, i.created_at, i.expires_at, i.used_at, u.email AS used_by_email
     FROM invites i LEFT JOIN users u ON u.id = i.used_by
     ORDER BY i.created_at DESC LIMIT 100`
  );
  return rows;
}

// Only an unused invite can be revoked; a used one is history.
export async function revokeInvite(id) {
  const { rowCount } = await pool.query('DELETE FROM invites WHERE id = $1 AND used_at IS NULL', [id]);
  return rowCount > 0;
}

async function usableInviteId(token) {
  if (typeof token !== 'string' || !token) return null;
  const { rows } = await pool.query(
    'SELECT id FROM invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()',
    [hashToken(token)]
  );
  return rows[0]?.id ?? null;
}

// Whether a new account may be created now. { ok: true, inviteId } (inviteId null when no
// invite is needed or given), or { ok: false, error, message } to show the visitor.
export async function signupGate(inviteToken) {
  const { rows } = await pool.query('SELECT EXISTS (SELECT 1 FROM users) AS any');
  const inviteId = await usableInviteId(inviteToken);
  if (!rows[0].any) return { ok: true, inviteId };

  const mode = await getSignupMode();
  if (mode === 'open') return { ok: true, inviteId };
  if (mode === 'invite') {
    if (inviteId) return { ok: true, inviteId };
    return {
      ok: false,
      error: inviteToken ? 'invite_invalid' : 'invite_required',
      message: inviteToken
        ? 'This invite link has already been used or has expired. Ask the admin for a new one.'
        : 'Sign-ups on this server are by invitation. Ask the admin for an invite link.',
    };
  }
  return { ok: false, error: 'signups_closed', message: 'Sign-ups are closed on this server.' };
}

// Creates the account via `insertUser(client)` in one transaction with claiming the invite,
// so one invite link can't create two accounts. Returns the new user, or null when the invite
// was claimed by someone else in the meantime.
export async function createUserThroughGate(gate, insertUser) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (gate.inviteId) {
      const claimed = await client.query(
        'UPDATE invites SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING id',
        [gate.inviteId]
      );
      if (claimed.rowCount === 0) {
        await client.query('ROLLBACK');
        return null;
      }
    }
    const user = await insertUser(client);
    if (gate.inviteId) {
      await client.query('UPDATE invites SET used_by = $1 WHERE id = $2', [user.id, gate.inviteId]);
    }
    await client.query('COMMIT');
    return user;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
