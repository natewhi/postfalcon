import { Router } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sanitizeUrl } from '../lib/url.js';
import { logProductEvent } from '../lib/activityLog.js';
import { logger } from '../lib/logger.js';
import { atAccountLimit } from '../middleware/planLimit.js';
import { basicAuthHeader, pinterestApiBase, sandboxToken } from '../lib/platforms/pinterest.js';

const router = Router();
// The exact set Pinterest's endpoints demand: POST /v5/pins needs boards:read+boards:write+
// pins:read+pins:write (a Pin is written into a board), and GET /v5/user_account (the
// username + picture below) needs user_accounts:read.
const SCOPES = 'boards:read,boards:write,pins:read,pins:write,user_accounts:read';

function redirectUri() {
  return `${process.env.BASE_URL}/api/pinterest/callback`;
}

router.get(
  '/connect',
  asyncHandler(async (req, res) => {
    if (!process.env.PINTEREST_APP_ID) {
      return res.status(503).send('Pinterest is not configured on this server.');
    }
    const state = crypto.randomBytes(16).toString('hex');
    req.session.pinterestOAuthState = state;

    const url = new URL('https://www.pinterest.com/oauth/');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', process.env.PINTEREST_APP_ID);
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
    if (!code || !state || state !== req.session.pinterestOAuthState) {
      return res.status(400).send('Invalid or expired OAuth state. Please try connecting again.');
    }
    delete req.session.pinterestOAuthState;

    // Pinterest's token endpoint authenticates the app via HTTP Basic auth, not client
    // credentials in the body (unlike every other OAuth token exchange in this codebase).
    const tokenRes = await fetch('https://api.pinterest.com/v5/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuthHeader(),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri(),
      }),
    });
    const token = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !token.access_token) {
      return res.status(502).send('Failed to exchange the authorization code with Pinterest.');
    }

    const profileRes = await fetch('https://api.pinterest.com/v5/user_account', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const profile = await profileRes.json().catch(() => ({}));
    if (!profile.username) {
      req.log.warn({ status: profileRes.status, body: profile }, 'pinterest user_account lookup failed');
      return res.status(502).send('Pinterest did not return a usable account profile.');
    }

    // A Pin always belongs to a board — pick the account's first one now rather than building
    // a board-picker UI; stored in metadata (same place Mastodon keeps its instance domain).
    // An account with no boards (any new account, and always in the API sandbox — see
    // pinterestApiBase()) gets a "Postfalcon" board created for it.
    const auth = { Authorization: `Bearer ${sandboxToken() || token.access_token}` };
    const boardsRes = await fetch(`${pinterestApiBase()}/v5/boards?page_size=1`, { headers: auth });
    const boards = await boardsRes.json().catch(() => ({}));
    let board = boards.items?.[0];
    if (!board) {
      const createRes = await fetch(`${pinterestApiBase()}/v5/boards`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Postfalcon', description: 'Pins published with Postfalcon', privacy: 'PUBLIC' }),
      });
      const created = await createRes.json().catch(() => null);
      board = createRes.ok ? created : null;
      if (!board?.id) {
        req.log.warn({ status: createRes.status, body: created }, 'pinterest board creation failed');
        return res
          .status(400)
          .send('Your Pinterest account has no boards and Postfalcon could not create one — create a board on Pinterest and try again.');
      }
    }

    const externalId = profile.username;
    const avatarUrl = sanitizeUrl(profile.profile_image);
    const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null;

    const already = await pool.query(
      `SELECT 1 FROM social_accounts WHERE user_id = $1 AND platform = 'pinterest' AND external_account_id = $2`,
      [req.user.id, externalId]
    );
    if (already.rows.length === 0 && (await atAccountLimit(req.user))) {
      return res.redirect('/accounts?error=plan_limit');
    }

    const result = await pool.query(
      `INSERT INTO social_accounts
         (user_id, platform, display_name, external_account_id, access_token, refresh_token, token_expires_at,
          avatar_url, metadata)
       VALUES ($1, 'pinterest', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, platform, external_account_id)
       DO UPDATE SET display_name = EXCLUDED.display_name, access_token = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, social_accounts.refresh_token),
         token_expires_at = EXCLUDED.token_expires_at, avatar_url = EXCLUDED.avatar_url, metadata = EXCLUDED.metadata
       RETURNING id, (xmax = 0) AS inserted`,
      [
        req.user.id,
        externalId,
        externalId,
        token.access_token,
        token.refresh_token ?? null,
        expiresAt,
        avatarUrl,
        JSON.stringify({ board_id: board.id, board_name: board.name }),
      ]
    );
    if (result.rows[0].inserted) {
      await logProductEvent(req.user.id, 'social_account_connected', {
        platform: 'pinterest',
        socialAccountId: result.rows[0].id,
      }).catch((err) => logger.error({ err }, 'failed to record product event'));
    }

    res.redirect('/accounts');
  })
);

export default router;
