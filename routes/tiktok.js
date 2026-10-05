import { Router } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sanitizeUrl } from '../lib/url.js';
import { logProductEvent } from '../lib/activityLog.js';
import { logger } from '../lib/logger.js';
import { atAccountLimit } from '../middleware/planLimit.js';
import { getCreatorInfo } from '../lib/platforms/tiktok.js';

const router = Router();
const API = 'https://open.tiktokapis.com';
const SCOPES = 'user.info.basic,video.publish,video.upload';

function redirectUri() {
  return `${process.env.BASE_URL}/api/tiktok/callback`;
}

function base64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

router.get(
  '/connect',
  asyncHandler(async (req, res) => {
    if (!process.env.TIKTOK_CLIENT_KEY) {
      return res.status(503).send('TikTok is not configured on this server.');
    }
    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = base64Url(crypto.randomBytes(48));
    const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
    req.session.tiktokOAuth = { state, codeVerifier };

    const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
    url.searchParams.set('client_key', process.env.TIKTOK_CLIENT_KEY);
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set('response_type', 'code');
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
    const pending = req.session.tiktokOAuth;
    if (!pending || !code || !state || state !== pending.state) {
      return res.status(400).send('Invalid or expired OAuth state. Please try connecting again.');
    }
    delete req.session.tiktokOAuth;

    const tokenRes = await fetch(`${API}/v2/oauth/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri(),
        code: String(code),
        code_verifier: pending.codeVerifier,
      }),
    });
    const token = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !token.access_token) {
      return res.status(502).send('Failed to exchange the authorization code with TikTok.');
    }

    const infoRes = await fetch(`${API}/v2/user/info/?fields=open_id,display_name,avatar_url`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const info = await infoRes.json().catch(() => ({}));
    const user = info.data?.user;
    const externalId = user?.open_id || token.open_id;
    if (!externalId) {
      return res.status(502).send('Failed to fetch your TikTok profile.');
    }

    const displayName = user?.display_name ? `@${user.display_name}` : 'TikTok';
    const avatarUrl = sanitizeUrl(user?.avatar_url);
    const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null;

    const already = await pool.query(
      `SELECT 1 FROM social_accounts WHERE user_id = $1 AND platform = 'tiktok' AND external_account_id = $2`,
      [req.user.id, externalId]
    );
    if (already.rows.length === 0 && (await atAccountLimit(req.user))) {
      return res.redirect('/accounts?error=plan_limit');
    }

    const result = await pool.query(
      `INSERT INTO social_accounts
         (user_id, platform, display_name, external_account_id, access_token, refresh_token, token_expires_at, avatar_url)
       VALUES ($1, 'tiktok', $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, platform, external_account_id)
       DO UPDATE SET display_name = EXCLUDED.display_name, access_token = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, social_accounts.refresh_token),
         token_expires_at = EXCLUDED.token_expires_at, avatar_url = EXCLUDED.avatar_url
       RETURNING id, (xmax = 0) AS inserted`,
      [req.user.id, displayName, externalId, token.access_token, token.refresh_token ?? null, expiresAt, avatarUrl]
    );
    if (result.rows[0].inserted) {
      await logProductEvent(req.user.id, 'social_account_connected', {
        platform: 'tiktok',
        socialAccountId: result.rows[0].id,
      }).catch((err) => logger.error({ err }, 'failed to record product event'));
    }

    res.redirect('/accounts');
  })
);

// Backs the composer's TikTok panel: who the user is posting as, which privacy levels
// they may pick, and which interactions their account has disabled. Queried fresh each
// time the panel opens, since TikTok's guidelines require reflecting current settings.
router.get(
  '/accounts/:id/creator-info',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await pool.query(
      `SELECT id, access_token, refresh_token, token_expires_at FROM social_accounts
       WHERE id = $1 AND user_id = $2 AND platform = 'tiktok'`,
      [id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });

    let info;
    try {
      info = await getCreatorInfo(rows[0]);
    } catch (err) {
      req.log.warn({ err, socialAccountId: id }, 'tiktok creator_info query failed');
      return res.status(502).json({ error: err.message });
    }
    res.json({
      nickname: info.creator_nickname ?? null,
      username: info.creator_username ?? null,
      avatar_url: sanitizeUrl(info.creator_avatar_url),
      privacy_level_options: info.privacy_level_options ?? [],
      comment_disabled: !!info.comment_disabled,
      duet_disabled: !!info.duet_disabled,
      stitch_disabled: !!info.stitch_disabled,
      max_video_post_duration_sec: info.max_video_post_duration_sec ?? null,
    });
  })
);

export default router;
