import { pool } from '../db/pool.js';
import { sendMail } from './mailer.js';
import { logger } from './logger.js';
import { PLATFORMS } from './platforms.js';

// Error messages that mean "the platform no longer accepts this account's credentials", as
// opposed to a bad post, a rate limit or an outage. Adapters throw plain Errors whose
// message embeds the HTTP status and the platform's own error text, so this matches on
// those: an OAuth invalid_grant (revoked/expired refresh token), a 401, Meta's
// OAuthException / code 190, or the adapters' own "reconnect it" messages.
const AUTH_FAILURE_PATTERNS = [
  /token refresh failed/i,
  /no refresh token/i,
  /reconnect (it|the|this)/i,
  /\(401\)/,
  /\b401 Unauthorized\b/i,
  /OAuthException/,
  /"code"\s*:\s*190\b/,
  /Error validating access token/i,
  /invalid[_ ](access[_ ])?token/i,
  /access token (has )?(expired|been revoked)/i,
  /session has (expired|been invalidated)/i,
  /AuthenticationRequired|ExpiredToken|InvalidToken/,
];

export function looksLikeAuthFailure(err) {
  if (err?.oauthError === 'invalid_grant') return true;
  const message = String(err?.message || '');
  return AUTH_FAILURE_PATTERNS.some((re) => re.test(message));
}

// Flags the account and, the first time only, emails its owner. Safe to call repeatedly
// (every failed post for the account would otherwise send another email).
export async function markNeedsReconnect(accountId, reason) {
  const { rows } = await pool.query(
    `UPDATE social_accounts SET needs_reconnect_at = now(), reconnect_reason = $2
     WHERE id = $1 AND needs_reconnect_at IS NULL
     RETURNING user_id, platform, display_name`,
    [accountId, String(reason || '').slice(0, 500)]
  );
  if (rows.length === 0) return false;

  const { user_id: userId, platform, display_name: name } = rows[0];
  const label = PLATFORMS[platform]?.label || platform;
  const { rows: users } = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
  if (users[0]?.email) {
    await sendMail({
      to: users[0].email,
      subject: `Reconnect ${name} (${label}) to keep posting`,
      text:
        `${label} stopped accepting Postfalcon's access to ${name}. This usually means the ` +
        `connection expired or access was revoked.\n\n` +
        `Scheduled posts to ${name} will fail until you reconnect it:\n` +
        `${process.env.BASE_URL}/accounts\n\n` +
        `Reconnecting takes a few seconds and keeps your existing posts.`,
    }).catch((err) => logger.error({ err, accountId }, 'failed to send reconnect email'));
  }
  return true;
}

// A successful publish proves the credentials work again.
export async function clearNeedsReconnect(accountId) {
  await pool.query(
    `UPDATE social_accounts SET needs_reconnect_at = NULL, reconnect_reason = NULL
     WHERE id = $1 AND needs_reconnect_at IS NOT NULL`,
    [accountId]
  );
}
