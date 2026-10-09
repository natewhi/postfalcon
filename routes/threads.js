import { Router } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sanitizeUrl } from '../lib/url.js';
import { logProductEvent } from '../lib/activityLog.js';
import { logger } from '../lib/logger.js';
import { atAccountLimit } from '../middleware/planLimit.js';

const router = Router();
// threads_manage_insights backs fetchMetrics() in lib/platforms/threads.js (the /insights endpoint).
const SCOPES = 'threads_basic,threads_content_publish,threads_manage_insights';

function redirectUri() {
  return `${process.env.BASE_URL}/api/threads/callback`;
}

router.get(
  '/connect',
  asyncHandler(async (req, res) => {
    if (!process.env.THREADS_CLIENT_ID) {
      return res.status(503).send('Threads is not configured on this server.');
    }
    const state = crypto.randomBytes(16).toString('hex');
    req.session.threadsOAuthState = state;

    const url = new URL('https://threads.net/oauth/authorize');
    url.searchParams.set('client_id', process.env.THREADS_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  })
);

router.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.threadsOAuthState) {
      return res.status(400).send('Invalid or expired OAuth state. Please try connecting again.');
    }
    delete req.session.threadsOAuthState;

    const tokenRes = await fetch('https://graph.threads.net/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.THREADS_CLIENT_ID,
        client_secret: process.env.THREADS_CLIENT_SECRET,
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
        code: String(code),
      }),
    });
    const shortToken = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !shortToken.access_token) {
      return res.status(502).send('Failed to exchange the authorization code with Threads.');
    }

    // Short-lived tokens (valid ~1h) must be exchanged for a long-lived one (~60 days) —
    // see lib/platforms/threads.js for how that token is kept fresh afterwards.
    const exchangeUrl = new URL('https://graph.threads.net/access_token');
    exchangeUrl.searchParams.set('grant_type', 'th_exchange_token');
    exchangeUrl.searchParams.set('client_secret', process.env.THREADS_CLIENT_SECRET);
    exchangeUrl.searchParams.set('access_token', shortToken.access_token);
    const longRes = await fetch(exchangeUrl);
    const longToken = await longRes.json().catch(() => ({}));
    if (!longRes.ok || !longToken.access_token) {
      return res.status(502).send('Failed to get a long-lived Threads token.');
    }

    const profileUrl = new URL('https://graph.threads.net/v1.0/me');
    profileUrl.searchParams.set('fields', 'id,username,threads_profile_picture_url');
    profileUrl.searchParams.set('access_token', longToken.access_token);
    const profileRes = await fetch(profileUrl);
    const profile = await profileRes.json().catch(() => ({}));
    if (!profileRes.ok || !profile.id) {
      return res.status(502).send('Failed to fetch the Threads profile.');
    }

    const externalId = profile.id;
    const displayName = profile.username ? `@${profile.username}` : 'Threads account';
    const avatarUrl = sanitizeUrl(profile.threads_profile_picture_url);
    const expiresAt = longToken.expires_in ? new Date(Date.now() + longToken.expires_in * 1000) : null;

    const already = await pool.query(
      `SELECT 1 FROM social_accounts WHERE user_id = $1 AND platform = 'threads' AND external_account_id = $2`,
      [req.user.id, externalId]
    );
    if (already.rows.length === 0 && (await atAccountLimit(req.user))) {
      return res.redirect('/accounts?error=plan_limit');
    }

    const result = await pool.query(
      `INSERT INTO social_accounts
         (user_id, platform, display_name, external_account_id, access_token, token_expires_at, avatar_url)
       VALUES ($1, 'threads', $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, platform, external_account_id)
       DO UPDATE SET display_name = EXCLUDED.display_name, access_token = EXCLUDED.access_token,
         token_expires_at = EXCLUDED.token_expires_at, avatar_url = EXCLUDED.avatar_url
       RETURNING id, (xmax = 0) AS inserted`,
      [req.user.id, displayName, externalId, longToken.access_token, expiresAt, avatarUrl]
    );
    if (result.rows[0].inserted) {
      await logProductEvent(req.user.id, 'social_account_connected', {
        platform: 'threads',
        socialAccountId: result.rows[0].id,
      }).catch((err) => logger.error({ err }, 'failed to record product event'));
    }

    res.redirect('/accounts');
  })
);

export default router;
