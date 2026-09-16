import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { pool } from '../db/pool.js';

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

async function loginNewUser() {
  const client = request.agent(app);
  const email = `li${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

beforeAll(() => {
  process.env.LINKEDIN_CLIENT_ID = 'lid';
  process.env.LINKEDIN_CLIENT_SECRET = 'lsecret';
});

describe('linkedin oauth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires authentication', async () => {
    const res = await request(app).get('/api/linkedin/connect');
    expect(res.status).toBe(401);
  });

  it('redirects to the LinkedIn consent screen with the share scope', async () => {
    const client = await loginNewUser();
    const res = await client.get('/api/linkedin/connect');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('linkedin.com/oauth/v2/authorization');
    expect(res.headers.location).toContain('w_member_social');
  });

  it('rejects a callback with a mismatched state', async () => {
    const client = await loginNewUser();
    await client.get('/api/linkedin/connect');
    const res = await client.get('/api/linkedin/callback').query({ code: 'x', state: 'wrong' });
    expect(res.status).toBe(400);
  });

  it('stores the account on a valid callback', async () => {
    const client = await loginNewUser();
    const connect = await client.get('/api/linkedin/connect');
    const state = new URL(connect.headers.location).searchParams.get('state');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const u = String(url);
        if (u === 'https://www.linkedin.com/oauth/v2/accessToken') {
          return jsonResponse({ access_token: 'at-1', expires_in: 5184000 });
        }
        if (u === 'https://api.linkedin.com/v2/userinfo') {
          return jsonResponse({ sub: 'li-123', name: 'Alice Example', picture: 'https://example.com/pic.jpg' });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    const res = await client.get('/api/linkedin/callback').query({ code: 'good-code', state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/accounts');

    const { rows } = await pool.query(
      "SELECT display_name, external_account_id, access_token, token_expires_at FROM social_accounts WHERE platform = 'linkedin'"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      display_name: 'Alice Example',
      external_account_id: 'li-123',
      access_token: 'at-1',
    });
    expect(rows[0].token_expires_at).toBeInstanceOf(Date);
  });
});
