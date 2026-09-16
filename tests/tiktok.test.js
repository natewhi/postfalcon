import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
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
  const email = `tk${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

beforeAll(() => {
  process.env.TIKTOK_CLIENT_KEY = 'ckey';
  process.env.TIKTOK_CLIENT_SECRET = 'csecret';
});

describe('tiktok oauth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires authentication', async () => {
    const res = await request(app).get('/api/tiktok/connect');
    expect(res.status).toBe(401);
  });

  it('redirects to the TikTok consent screen with PKCE and the publish scope', async () => {
    const client = await loginNewUser();
    const res = await client.get('/api/tiktok/connect');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    expect(url.origin + url.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(url.searchParams.get('scope')).toContain('video.publish');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('rejects a callback with a mismatched state', async () => {
    const client = await loginNewUser();
    await client.get('/api/tiktok/connect');
    const res = await client.get('/api/tiktok/callback').query({ code: 'x', state: 'nope' });
    expect(res.status).toBe(400);
  });

  it('stores the profile with its refresh token on a valid callback', async () => {
    const client = await loginNewUser();
    const connect = await client.get('/api/tiktok/connect');
    const state = new URL(connect.headers.location).searchParams.get('state');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const u = String(url);
        if (u === 'https://open.tiktokapis.com/v2/oauth/token/') {
          return jsonResponse({ access_token: 'at-9', refresh_token: 'rt-9', expires_in: 86400, open_id: 'open-9' });
        }
        if (u.startsWith('https://open.tiktokapis.com/v2/user/info/')) {
          return jsonResponse({ data: { user: { open_id: 'open-9', display_name: 'creator', avatar_url: 'https://x/y.png' } } });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    const res = await client.get('/api/tiktok/callback').query({ code: 'good', state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/accounts');

    const { rows } = await pool.query(
      "SELECT display_name, external_account_id, access_token, refresh_token FROM social_accounts WHERE platform = 'tiktok'"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      display_name: '@creator',
      external_account_id: 'open-9',
      access_token: 'at-9',
      refresh_token: 'rt-9',
    });
  });
});
