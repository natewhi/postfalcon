import { Router } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

const INSTANCE_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function normalizeInstance(raw) {
  if (!raw) return null;
  const stripped = String(raw).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  return INSTANCE_RE.test(stripped) ? stripped.toLowerCase() : null;
}

function redirectUri() {
  return `${process.env.BASE_URL}/api/mastodon/callback`;
}

async function getOrRegisterApp(instance) {
  const existing = await pool.query('SELECT client_id, client_secret FROM mastodon_apps WHERE instance = $1', [
    instance,
  ]);
  if (existing.rows.length > 0) return existing.rows[0];

  const res = await fetch(`https://${instance}/api/v1/apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Postfox',
      redirect_uris: redirectUri(),
      scopes: 'read write',
      website: process.env.BASE_URL,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to register app on ${instance} (status ${res.status})`);
  }
  const app = await res.json();
  await pool.query('INSERT INTO mastodon_apps (instance, client_id, client_secret) VALUES ($1, $2, $3)', [
    instance,
    app.client_id,
    app.client_secret,
  ]);
  return { client_id: app.client_id, client_secret: app.client_secret };
}

router.get(
  '/connect',
  asyncHandler(async (req, res) => {
    const instance = normalizeInstance(req.query.instance);
    if (!instance) {
      return res.status(400).send('Enter a valid Mastodon instance domain, e.g. mastodon.social');
    }

    const app = await getOrRegisterApp(instance);
    const state = crypto.randomBytes(16).toString('hex');
    req.session.mastodonOAuth = { state, instance };

    const authorizeUrl = new URL(`https://${instance}/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', app.client_id);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri());
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', 'read write');
    authorizeUrl.searchParams.set('state', state);

    res.redirect(authorizeUrl.toString());
  })
);

router.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    const pending = req.session.mastodonOAuth;

    if (!pending || !state || state !== pending.state || !code) {
      return res.status(400).send('Invalid or expired OAuth state. Please try connecting again.');
    }

    const { instance } = pending;
    delete req.session.mastodonOAuth;

    const app = await getOrRegisterApp(instance);

    const tokenRes = await fetch(`https://${instance}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: app.client_id,
        client_secret: app.client_secret,
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
        code,
        scope: 'read write',
      }),
    });
    if (!tokenRes.ok) {
      return res.status(502).send('Failed to exchange authorization code with Mastodon.');
    }
    const token = await tokenRes.json();

    const accountRes = await fetch(`https://${instance}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!accountRes.ok) {
      return res.status(502).send('Failed to fetch Mastodon account details.');
    }
    const account = await accountRes.json();

    await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, metadata)
       VALUES ($1, 'mastodon', $2, $3, $4, $5)
       ON CONFLICT (user_id, platform, external_account_id)
       DO UPDATE SET display_name = EXCLUDED.display_name, access_token = EXCLUDED.access_token, metadata = EXCLUDED.metadata`,
      [req.session.userId, `@${account.username}@${instance}`, account.id, token.access_token, JSON.stringify({ instance })]
    );

    res.redirect('/');
  })
);

export default router;
