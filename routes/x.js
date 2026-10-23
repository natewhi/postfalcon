import { Router } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sanitizeUrl } from '../lib/url.js';
import { logProductEvent } from '../lib/activityLog.js';
import { logger } from '../lib/logger.js';
import { atAccountLimit } from '../middleware/planLimit.js';
import { X_API, basicAuthHeader } from '../lib/platforms/x.js';

// X OAuth 2.0 Authorization Code flow with PKCE (required by X, like TikTok's). The platform is
// unlisted in lib/platforms.js, so nothing links here until it's launched.
const router = Router();
const SCOPES = 'tweet.read tweet.write users.read media.write offline.access';

function redirectUri() {
  return `${process.env.BASE_URL}/api/x/callback`;
}

function base64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

router.get(
  '/connect',
  asyncHandler(async (req, res) => {
    if (!process.env.X_CLIENT_ID) {
      return res.status(503).send('X is not configured on this server.');
    }
    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = base64Url(crypto.randomBytes(48));
    const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
    req.session.xOAuth = { state, codeVerifier };

    const url = new URL('https://x.com/i/oauth2/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', process.env.X_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    res.redirect(url.toString());
  })
);

router.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    const pending = req.session.xOAuth;
    if (!pending || !code || !state || state !== pending.state) {
      return res.status(400).send('Invalid or expired OAuth state. Please try connecting again.');
    }
    delete req.session.xOAuth;

    const tokenRes = await fetch(`${X_API}/2/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuthHeader() },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri(),
        code_verifier: pending.codeVerifier,
        client_id: process.env.X_CLIENT_ID,
      }),
    });
    const token = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !token.access_token) {
      req.log.warn({ status: tokenRes.status, error: token.error }, 'x token exchange failed');
      return res.status(502).send('Failed to exchange the authorization code with X.');
    }

    const meRes = await fetch(`${X_API}/2/users/me?user.fields=profile_image_url`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const me = (await meRes.json().catch(() => ({}))).data;
    if (!me?.id) {
      return res.status(502).send('X did not return a usable account profile.');
    }

    const already = await pool.query(
      `SELECT 1 FROM social_accounts WHERE user_id = $1 AND platform = 'x' AND external_account_id = $2`,
      [req.user.id, me.id]
    );
    if (already.rows.length === 0 && (await atAccountLimit(req.user))) {
      return res.redirect('/accounts?error=plan_limit');
    }

    const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null;
    const result = await pool.query(
      `INSERT INTO social_accounts
         (user_id, platform, display_name, external_account_id, access_token, refresh_token, token_expires_at, avatar_url)
       VALUES ($1, 'x', $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, platform, external_account_id)
       DO UPDATE SET display_name = EXCLUDED.display_name, access_token = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, social_accounts.refresh_token),
         token_expires_at = EXCLUDED.token_expires_at, avatar_url = EXCLUDED.avatar_url
       RETURNING id, (xmax = 0) AS inserted`,
      [
        req.user.id,
        me.username ? `@${me.username}` : me.name || 'X account',
        me.id,
        token.access_token,
        token.refresh_token ?? null,
        expiresAt,
        sanitizeUrl(me.profile_image_url),
      ]
    );
    if (result.rows[0].inserted) {
      await logProductEvent(req.user.id, 'social_account_connected', {
        platform: 'x',
        socialAccountId: result.rows[0].id,
      }).catch((err) => logger.error({ err }, 'failed to record product event'));
    }

    res.redirect('/accounts');
  })
);

export default router;
