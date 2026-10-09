import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logger } from '../lib/logger.js';

// Meta calls these server-to-server when someone removes Postfalcon from their Threads
// account ("Uninstall callback URL") or asks for their data to be deleted ("Delete callback
// URL") — both required fields in the Threads use case settings. Each POST carries a
// `signed_request`, authenticated by HMAC with the app secret rather than a session, so this
// router is mounted ahead of csrfProtection (like the Stripe webhook) and without requireAuth.
const router = Router();

const signedRequestSchema = z.object({ signed_request: z.string().min(1).max(4096) });

const base64UrlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// Returns the decoded payload, or null if the signature doesn't match `secret`.
export function parseSignedRequest(signedRequest, secret) {
  const [encodedSig, payload] = String(signedRequest).split('.', 2);
  if (!encodedSig || !payload || !secret) return null;
  const sig = base64UrlDecode(encodedSig);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(base64UrlDecode(payload).toString('utf8'));
    return data && data.user_id ? data : null;
  } catch {
    return null;
  }
}

function threadsUserId(req, res) {
  const data = parseSignedRequest(req.body.signed_request, process.env.THREADS_CLIENT_SECRET);
  if (!data) {
    res.status(400).json({ error: 'invalid signed_request' });
    return null;
  }
  return String(data.user_id);
}

// The user removed Postfalcon from Threads: drop the now-useless token and flag the account,
// so it shows "Needs reconnecting" (and scheduled posts fail clearly) rather than vanishing
// along with the user's posts. Setting needs_reconnect_at in the same UPDATE keeps the
// migration-022 trigger from clearing the flag over the token change.
router.post(
  '/threads/uninstall',
  validate(signedRequestSchema),
  asyncHandler(async (req, res) => {
    const userId = threadsUserId(req, res);
    if (!userId) return;
    const { rowCount } = await pool.query(
      `UPDATE social_accounts
       SET access_token = '', refresh_token = NULL, needs_reconnect_at = now(),
           reconnect_reason = 'Postfalcon was removed from this Threads account.'
       WHERE platform = 'threads' AND external_account_id = $1`,
      [userId]
    );
    logger.info({ accounts: rowCount }, 'threads uninstall callback');
    res.json({ success: true });
  })
);

// Data deletion request: delete every Threads connection for that user (posts cascade), and
// answer with the confirmation code + status URL Meta's spec requires.
router.post(
  '/threads/delete',
  validate(signedRequestSchema),
  asyncHandler(async (req, res) => {
    const userId = threadsUserId(req, res);
    if (!userId) return;
    const { rowCount } = await pool.query(
      `DELETE FROM social_accounts WHERE platform = 'threads' AND external_account_id = $1`,
      [userId]
    );
    const code = crypto.randomBytes(8).toString('hex');
    logger.info({ accounts: rowCount, code }, 'threads data deletion callback');
    res.json({ url: `${process.env.BASE_URL}/api/meta/deletion-status?code=${code}`, confirmation_code: code });
  })
);

// Where the deletion confirmation URL points. Deletion happens synchronously in the request
// above, so any code Meta hands back to the user is already complete.
router.get('/deletion-status', (req, res) => {
  res
    .type('text/plain')
    .send('Your Postfalcon data deletion request has been completed. All data for that account has been deleted.');
});

export default router;
