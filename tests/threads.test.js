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
  const email = `th${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

beforeAll(() => {
  process.env.THREADS_CLIENT_ID = 'tid';
  process.env.THREADS_CLIENT_SECRET = 'tsecret';
});

describe('threads oauth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires authentication', async () => {
    const res = await request(app).get('/api/threads/connect');
    expect(res.status).toBe(401);
  });

  it('redirects to the Threads consent screen with the publish scope', async () => {
    const client = await loginNewUser();
    const res = await client.get('/api/threads/connect');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('threads.net/oauth/authorize');
    expect(res.headers.location).toContain('threads_content_publish');
  });

  it('rejects a callback with a mismatched state', async () => {
    const client = await loginNewUser();
    await client.get('/api/threads/connect');
    const res = await client.get('/api/threads/callback').query({ code: 'x', state: 'wrong' });
    expect(res.status).toBe(400);
  });

  it('stores the account with a long-lived token on a valid callback', async () => {
    const client = await loginNewUser();
    const connect = await client.get('/api/threads/connect');
    const state = new URL(connect.headers.location).searchParams.get('state');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const u = String(url);
        if (u === 'https://graph.threads.net/oauth/access_token') {
          return jsonResponse({ access_token: 'short-1', user_id: 'u1' });
        }
        if (u.startsWith('https://graph.threads.net/access_token')) {
          return jsonResponse({ access_token: 'long-1', expires_in: 5184000 });
        }
        if (u.startsWith('https://graph.threads.net/v1.0/me')) {
          return jsonResponse({ id: 'th-123', username: 'alice' });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    const res = await client.get('/api/threads/callback').query({ code: 'good-code', state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/accounts');

    const { rows } = await pool.query(
      "SELECT display_name, external_account_id, access_token, token_expires_at FROM social_accounts WHERE platform = 'threads'"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      display_name: '@alice',
      external_account_id: 'th-123',
      access_token: 'long-1',
    });
    expect(rows[0].token_expires_at).toBeInstanceOf(Date);
  });
});
