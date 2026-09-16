import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { pool } from '../db/pool.js';

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function loginNewUser() {
  const client = request.agent(app);
  const email = `yt${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

beforeAll(() => {
  process.env.GOOGLE_CLIENT_ID = 'gid';
  process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
});

describe('youtube oauth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires authentication', async () => {
    const res = await request(app).get('/api/youtube/connect');
    expect(res.status).toBe(401);
  });

  it('redirects to the Google consent screen with the upload scope', async () => {
    const client = await loginNewUser();
    const res = await client.get('/api/youtube/connect');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(res.headers.location).toContain('youtube.upload');
    expect(res.headers.location).toContain('access_type=offline');
  });

  it('rejects a callback with a mismatched state', async () => {
    const client = await loginNewUser();
    await client.get('/api/youtube/connect');
    const res = await client.get('/api/youtube/callback').query({ code: 'x', state: 'wrong' });
    expect(res.status).toBe(400);
  });

  it('stores the channel with its refresh token on a valid callback', async () => {
    const client = await loginNewUser();
    const connect = await client.get('/api/youtube/connect');
    const state = new URL(connect.headers.location).searchParams.get('state');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const u = String(url);
        if (u === 'https://oauth2.googleapis.com/token') {
          return jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
        }
        if (u.startsWith('https://www.googleapis.com/youtube/v3/channels')) {
          return jsonResponse({ items: [{ id: 'UC123', snippet: { title: 'My Channel' } }] });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    const res = await client.get('/api/youtube/callback').query({ code: 'good-code', state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/accounts');

    const { rows } = await pool.query(
      "SELECT display_name, external_account_id, access_token, refresh_token, token_expires_at FROM social_accounts WHERE platform = 'youtube'"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      display_name: 'My Channel',
      external_account_id: 'UC123',
      access_token: 'at-1',
      refresh_token: 'rt-1',
    });
    expect(rows[0].token_expires_at).toBeInstanceOf(Date);
  });
});
