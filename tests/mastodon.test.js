import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { pool } from '../db/pool.js';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function loginNewUser() {
  const client = request.agent(app);
  const email = `mastodon${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

function mockMastodonApi({
  appId = 'client-1',
  appSecret = 'secret-1',
  accessToken = 'access-1',
  accountId = 'acct-1',
  username = 'tester',
  avatar = 'https://example.social/avatars/tester.png',
} = {}) {
  return vi.fn(async (url) => {
    const u = String(url);
    if (u.endsWith('/api/v1/apps')) return jsonResponse({ client_id: appId, client_secret: appSecret });
    if (u.endsWith('/oauth/token')) return jsonResponse({ access_token: accessToken });
    if (u.endsWith('/api/v1/accounts/verify_credentials')) return jsonResponse({ id: accountId, username, avatar });
    throw new Error(`Unexpected fetch: ${u}`);
  });
}

describe('mastodon oauth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/mastodon/connect?instance=example.social');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid instance domain', async () => {
    const client = await loginNewUser();
    const res = await client.get('/api/mastodon/connect').query({ instance: 'not a domain!!' });
    expect(res.status).toBe(400);
  });

  it('registers an app and redirects to the instance authorize page', async () => {
    const client = await loginNewUser();
    vi.stubGlobal('fetch', mockMastodonApi());

    const res = await client.get('/api/mastodon/connect?instance=example.social');
    expect(res.status).toBe(302);

    const location = new URL(res.headers.location);
    expect(location.hostname).toBe('example.social');
    expect(location.pathname).toBe('/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe('client-1');
    expect(location.searchParams.get('state')).toBeTruthy();

    const cached = await pool.query('SELECT * FROM mastodon_apps WHERE instance = $1', ['example.social']);
    expect(cached.rows).toHaveLength(1);
  });

  it('reuses a cached app instead of re-registering', async () => {
    const client = await loginNewUser();
    const fetchMock = mockMastodonApi();
    vi.stubGlobal('fetch', fetchMock);

    await client.get('/api/mastodon/connect?instance=example.social');
    await client.get('/api/mastodon/connect?instance=example.social');

    const appRegistrationCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/apps'));
    expect(appRegistrationCalls).toHaveLength(1);
  });

  it('completes the callback and creates a social account', async () => {
    const client = await loginNewUser();
    vi.stubGlobal(
      'fetch',
      mockMastodonApi({ accessToken: 'final-token', accountId: 'acct-42', username: 'natew' })
    );

    const connectRes = await client.get('/api/mastodon/connect?instance=example.social');
    const state = new URL(connectRes.headers.location).searchParams.get('state');

    const callbackRes = await client.get(`/api/mastodon/callback?code=fake-code&state=${state}`);
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toBe('/accounts');

    const accounts = await client.get('/api/v1/social-accounts');
    expect(accounts.body).toHaveLength(1);
    expect(accounts.body[0].platform).toBe('mastodon');
    expect(accounts.body[0].display_name).toBe('@natew@example.social');
    expect(accounts.body[0].avatar_url).toBe('https://example.social/avatars/tester.png');
  });

  it('rejects a callback with a mismatched state', async () => {
    const client = await loginNewUser();
    vi.stubGlobal('fetch', mockMastodonApi());
    await client.get('/api/mastodon/connect?instance=example.social');

    const res = await client.get('/api/mastodon/callback?code=fake-code&state=wrong-state');
    expect(res.status).toBe(400);
  });
});
