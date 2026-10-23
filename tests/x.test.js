import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { pool } from '../db/pool.js';
import { connectablePlatforms, livePlatforms } from '../lib/platforms.js';

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

async function loginNewUser() {
  const client = request.agent(app);
  const email = `x${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

beforeAll(() => {
  process.env.X_CLIENT_ID = 'xid';
  process.env.X_CLIENT_SECRET = 'xsecret';
});

describe('x platform', () => {
  it('is built but unlisted: not on the connect page or the marketing platform row', () => {
    expect(connectablePlatforms().map((p) => p.id)).not.toContain('x');
    expect(livePlatforms().map((p) => p.id)).not.toContain('x');
  });
});

describe('x oauth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires authentication', async () => {
    const res = await request(app).get('/api/x/connect');
    expect(res.status).toBe(401);
  });

  it('redirects to X with PKCE and the posting scopes', async () => {
    const client = await loginNewUser();
    const res = await client.get('/api/x/connect');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope').split(' ')).toEqual(
      expect.arrayContaining(['tweet.write', 'users.read', 'media.write', 'offline.access'])
    );
  });

  it('rejects a callback with a mismatched state', async () => {
    const client = await loginNewUser();
    await client.get('/api/x/connect');
    const res = await client.get('/api/x/callback').query({ code: 'c', state: 'wrong' });
    expect(res.status).toBe(400);
  });

  it('stores the account with its refresh token on a valid callback', async () => {
    const client = await loginNewUser();
    const connect = await client.get('/api/x/connect');
    const state = new URL(connect.headers.location).searchParams.get('state');

    let tokenBody;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts) => {
        const u = String(url);
        if (u === 'https://api.x.com/2/oauth2/token') {
          expect(opts.headers.Authorization).toMatch(/^Basic /);
          tokenBody = new URLSearchParams(opts.body);
          return jsonResponse({ access_token: 'xat', refresh_token: 'xrt', expires_in: 7200 });
        }
        if (u.startsWith('https://api.x.com/2/users/me')) {
          return jsonResponse({ data: { id: '123', username: 'alice', name: 'Alice', profile_image_url: 'https://pbs.twimg.com/a.jpg' } });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    const res = await client.get('/api/x/callback').query({ code: 'good', state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/accounts');
    expect(tokenBody.get('code_verifier')).toBeTruthy();

    const { rows } = await pool.query(
      "SELECT display_name, external_account_id, access_token, refresh_token, token_expires_at FROM social_accounts WHERE platform = 'x'"
    );
    expect(rows[0]).toMatchObject({ display_name: '@alice', external_account_id: '123', access_token: 'xat', refresh_token: 'xrt' });
    expect(rows[0].token_expires_at).toBeInstanceOf(Date);
  });
});
