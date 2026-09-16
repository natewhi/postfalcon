import { Router } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sanitizeUrl } from '../lib/url.js';
import { logProductEvent } from '../lib/activityLog.js';
import { logger } from '../lib/logger.js';
import { atAccountLimit } from '../middleware/planLimit.js';

const router = Router();
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
].join(' ');

function redirectUri() {
  return `${process.env.BASE_URL}/api/youtube/callback`;
}

router.get(
  '/connect',
  asyncHandler(async (req, res) => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(503).send('YouTube is not configured on this server.');
    }
    const state = crypto.randomBytes(16).toString('hex');
    req.session.youtubeOAuthState = state;

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  })
);

router.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.youtubeOAuthState) {
      return res.status(400).send('Invalid or expired OAuth state. Please try connecting again.');
    }
    delete req.session.youtubeOAuthState;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
        code: String(code),
      }),
    });
    const token = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !token.access_token) {
      return res.status(502).send('Failed to exchange the authorization code with Google.');
    }

    const chanRes = await fetch('https://www.googleapis.com/youtube/v3/channels?mine=true&part=snippet', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const chan = await chanRes.json().catch(() => ({}));
    const channel = chan.items?.[0];
    if (!channel) {
      return res.status(502).send('That Google account does not have a YouTube channel.');
    }

    const externalId = channel.id;
    const displayName = channel.snippet?.title || 'YouTube channel';
    const avatarUrl = sanitizeUrl(channel.snippet?.thumbnails?.default?.url);
    const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null;

    const already = await pool.query(
      `SELECT 1 FROM social_accounts WHERE user_id = $1 AND platform = 'youtube' AND external_account_id = $2`,
      [req.user.id, externalId]
    );
    if (already.rows.length === 0 && (await atAccountLimit(req.user))) {
      return res.redirect('/accounts?error=plan_limit');
    }

    const result = await pool.query(
      `INSERT INTO social_accounts
         (user_id, platform, display_name, external_account_id, access_token, refresh_token, token_expires_at, avatar_url)
       VALUES ($1, 'youtube', $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, platform, external_account_id)
       DO UPDATE SET display_name = EXCLUDED.display_name, access_token = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, social_accounts.refresh_token),
         token_expires_at = EXCLUDED.token_expires_at, avatar_url = EXCLUDED.avatar_url
       RETURNING id, (xmax = 0) AS inserted`,
      [req.user.id, displayName, externalId, token.access_token, token.refresh_token ?? null, expiresAt, avatarUrl]
    );
    if (result.rows[0].inserted) {
      await logProductEvent(req.user.id, 'social_account_connected', {
        platform: 'youtube',
        socialAccountId: result.rows[0].id,
      }).catch((err) => logger.error({ err }, 'failed to record product event'));
    }

    res.redirect('/accounts');
  })
);

export default router;
