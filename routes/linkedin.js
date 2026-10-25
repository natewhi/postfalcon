import { Router } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sanitizeUrl } from '../lib/url.js';
import { logProductEvent } from '../lib/activityLog.js';
import { logger } from '../lib/logger.js';
import { atAccountLimit } from '../middleware/planLimit.js';

const router = Router();
// "Sign In with LinkedIn using OpenID Connect" (openid/profile/email) + "Share on LinkedIn"
// (w_member_social) — both generally available to any registered app, unlike LinkedIn's
// Company Page / analytics APIs which need Marketing Developer Platform partner approval.
const SCOPES = 'openid profile email w_member_social';

function redirectUri() {
  return `${process.env.BASE_URL}/api/linkedin/callback`;
}

router.get(
  '/connect',
  asyncHandler(async (req, res) => {
    if (!process.env.LINKEDIN_CLIENT_ID) {
      return res.status(503).send('LinkedIn is not configured on this server.');
    }
    const state = crypto.randomBytes(16).toString('hex');
    req.session.linkedinOAuthState = state;

    const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', process.env.LINKEDIN_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  })
);

router.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    // The user pressed Cancel on LinkedIn's consent screen (error=user_cancelled_authorize):
    // nothing to store, just take them back where they started.
    if (req.query.error && state && state === req.session.linkedinOAuthState) {
      delete req.session.linkedinOAuthState;
      return res.redirect('/accounts');
    }
    if (!code || !state || state !== req.session.linkedinOAuthState) {
      return res.status(400).send('Invalid or expired OAuth state. Please try connecting again.');
    }
    delete req.session.linkedinOAuthState;

    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri(),
        client_id: process.env.LINKEDIN_CLIENT_ID,
        client_secret: process.env.LINKEDIN_CLIENT_SECRET,
      }),
    });
    const token = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !token.access_token) {
      return res.status(502).send('Failed to exchange the authorization code with LinkedIn.');
    }

    const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const profile = await profileRes.json().catch(() => ({}));
    if (!profile.sub) {
      return res.status(502).send('LinkedIn did not return a usable profile.');
    }

    const externalId = profile.sub;
    const displayName = profile.name || 'LinkedIn account';
    const avatarUrl = sanitizeUrl(profile.picture);
    // LinkedIn doesn't issue a refresh_token to standard apps (that needs a separate,
    // approval-gated product) — the access token just lives for its full lifetime (~60 days),
    // then publish() starts failing with a clear error until the account is reconnected.
    const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null;

    const already = await pool.query(
      `SELECT 1 FROM social_accounts WHERE user_id = $1 AND platform = 'linkedin' AND external_account_id = $2`,
      [req.user.id, externalId]
    );
    if (already.rows.length === 0 && (await atAccountLimit(req.user))) {
      return res.redirect('/accounts?error=plan_limit');
    }

    const result = await pool.query(
      `INSERT INTO social_accounts
         (user_id, platform, display_name, external_account_id, access_token, token_expires_at, avatar_url)
       VALUES ($1, 'linkedin', $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, platform, external_account_id)
       DO UPDATE SET display_name = EXCLUDED.display_name, access_token = EXCLUDED.access_token,
         token_expires_at = EXCLUDED.token_expires_at, avatar_url = EXCLUDED.avatar_url
       RETURNING id, (xmax = 0) AS inserted`,
      [req.user.id, displayName, externalId, token.access_token, expiresAt, avatarUrl]
    );
    if (result.rows[0].inserted) {
      await logProductEvent(req.user.id, 'social_account_connected', {
        platform: 'linkedin',
        socialAccountId: result.rows[0].id,
      }).catch((err) => logger.error({ err }, 'failed to record product event'));
    }

    res.redirect('/accounts');
  })
);

export default router;
