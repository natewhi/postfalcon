import { Router } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sanitizeUrl } from '../lib/url.js';
import { logProductEvent } from '../lib/activityLog.js';
import { logger } from '../lib/logger.js';
import { limitsForPlan } from '../lib/billing.js';

const router = Router();
const GRAPH_VERSION = 'v19.0';
const SCOPE = 'pages_show_list,pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish';

function redirectUri() {
  return `${process.env.BASE_URL}/api/facebook/callback`;
}

async function upsertSocialAccount({ userId, platform, displayName, externalAccountId, accessToken, avatarUrl }) {
  // xmax = 0 is true only for a row this statement just inserted (Postgres system column
  // trick for upserts) — used below to log a connect event only for a genuinely new
  // account, not every reconnect/token-refresh through this same callback.
  const result = await pool.query(
    `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, avatar_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, platform, external_account_id)
     DO UPDATE SET display_name = EXCLUDED.display_name, access_token = EXCLUDED.access_token, avatar_url = EXCLUDED.avatar_url
     RETURNING id, (xmax = 0) AS inserted`,
    [userId, platform, displayName, externalAccountId, accessToken, sanitizeUrl(avatarUrl)]
  );
  if (result.rows[0].inserted) {
    await logProductEvent(userId, 'social_account_connected', {
      platform,
      socialAccountId: result.rows[0].id,
    }).catch((err) => logger.error({ err }, 'failed to record product event'));
  }
}

router.get(
  '/connect',
  asyncHandler(async (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.facebookOAuthState = state;

    const authorizeUrl = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
    authorizeUrl.searchParams.set('client_id', process.env.FACEBOOK_APP_ID);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri());
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('scope', SCOPE);

    res.redirect(authorizeUrl.toString());
  })
);

router.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.facebookOAuthState) {
      return res.status(400).send('Invalid or expired OAuth state. Please try connecting again.');
    }
    delete req.session.facebookOAuthState;

    const tokenUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
    tokenUrl.searchParams.set('client_id', process.env.FACEBOOK_APP_ID);
    tokenUrl.searchParams.set('client_secret', process.env.FACEBOOK_APP_SECRET);
    tokenUrl.searchParams.set('redirect_uri', redirectUri());
    tokenUrl.searchParams.set('code', code);

    const tokenRes = await fetch(tokenUrl);
    if (!tokenRes.ok) {
      return res.status(502).send('Failed to exchange authorization code with Facebook.');
    }
    const { access_token: shortLivedToken } = await tokenRes.json();

    const exchangeUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
    exchangeUrl.searchParams.set('grant_type', 'fb_exchange_token');
    exchangeUrl.searchParams.set('client_id', process.env.FACEBOOK_APP_ID);
    exchangeUrl.searchParams.set('client_secret', process.env.FACEBOOK_APP_SECRET);
    exchangeUrl.searchParams.set('fb_exchange_token', shortLivedToken);

    const exchangeRes = await fetch(exchangeUrl);
    if (!exchangeRes.ok) {
      return res.status(502).send('Failed to obtain a long-lived Facebook token.');
    }
    const { access_token: longLivedToken } = await exchangeRes.json();

    const pagesRes = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?fields=id,name,access_token,picture&access_token=${encodeURIComponent(longLivedToken)}`
    );
    if (!pagesRes.ok) {
      return res.status(502).send('Failed to fetch your Facebook Pages.');
    }
    const { data: pages } = await pagesRes.json();

    // Reconnecting an account already on the books just refreshes its token, so it's always
    // allowed; brand-new accounts are capped by the user's plan. Track a running count so
    // one callback can't blow past the limit by connecting many Pages at once.
    const accountCap = limitsForPlan(req.user.plan).accounts;
    const { rows: currentAccounts } = await pool.query(
      'SELECT platform, external_account_id FROM social_accounts WHERE user_id = $1',
      [req.user.id]
    );
    const known = new Set(currentAccounts.map((r) => `${r.platform}:${r.external_account_id}`));
    let accountCount = currentAccounts.length;
    let skippedAny = false;

    function reserveSlot(platform, externalId) {
      const key = `${platform}:${externalId}`;
      if (known.has(key)) return true;
      if (accountCap !== Infinity && accountCount >= accountCap) {
        skippedAny = true;
        return false;
      }
      known.add(key);
      accountCount += 1;
      return true;
    }

    for (const page of pages) {
      if (!reserveSlot('facebook', page.id)) continue;
      await upsertSocialAccount({
        userId: req.user.id,
        platform: 'facebook',
        displayName: page.name,
        externalAccountId: page.id,
        accessToken: page.access_token,
        avatarUrl: page.picture?.data?.url,
      });

      const igRes = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${page.id}?fields=instagram_business_account&access_token=${encodeURIComponent(page.access_token)}`
      );
      if (!igRes.ok) continue;
      const { instagram_business_account: igAccount } = await igRes.json();
      if (!igAccount) continue;
      if (!reserveSlot('instagram', igAccount.id)) continue;

      const igInfoRes = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${igAccount.id}?fields=username,profile_picture_url&access_token=${encodeURIComponent(page.access_token)}`
      );
      const igInfo = igInfoRes.ok ? await igInfoRes.json() : {};

      await upsertSocialAccount({
        userId: req.user.id,
        platform: 'instagram',
        displayName: igInfo.username ? `@${igInfo.username}` : `Instagram (${page.name})`,
        externalAccountId: igAccount.id,
        accessToken: page.access_token,
        avatarUrl: igInfo.profile_picture_url,
      });
    }

    res.redirect(skippedAny ? '/accounts?error=plan_limit' : '/accounts');
  })
);

export default router;
