import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { pool } from '../db/pool.js';

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

async function loginNewUser() {
  const client = request.agent(app);
  const email = `pi${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

beforeAll(() => {
  process.env.PINTEREST_APP_ID = 'pid';
  process.env.PINTEREST_APP_SECRET = 'psecret';
});

describe('pinterest oauth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires authentication', async () => {
    const res = await request(app).get('/api/pinterest/connect');
    expect(res.status).toBe(401);
  });

  it('redirects to the Pinterest consent screen with the write scope', async () => {
    const client = await loginNewUser();
    const res = await client.get('/api/pinterest/connect');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('pinterest.com/oauth/');
    const scope = new URL(res.headers.location).searchParams.get('scope');
    // POST /v5/pins rejects a token without both write scopes; GET /v5/user_account (the
    // username + picture) needs user_accounts:read.
    expect(scope.split(',')).toEqual(
      expect.arrayContaining(['boards:read', 'boards:write', 'pins:read', 'pins:write', 'user_accounts:read'])
    );
  });

  it('rejects a callback with a mismatched state', async () => {
    const client = await loginNewUser();
    await client.get('/api/pinterest/connect');
    const res = await client.get('/api/pinterest/callback').query({ code: 'x', state: 'wrong' });
    expect(res.status).toBe(400);
  });

  it('stores the account with its first board on a valid callback', async () => {
    const client = await loginNewUser();
    const connect = await client.get('/api/pinterest/connect');
    const state = new URL(connect.headers.location).searchParams.get('state');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts) => {
        const u = String(url);
        if (u === 'https://api.pinterest.com/v5/oauth/token') {
          expect(opts.headers.Authorization).toMatch(/^Basic /);
          return jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 2592000 });
        }
        if (u === 'https://api.pinterest.com/v5/user_account') {
          return jsonResponse({ username: 'alice', profile_image: 'https://example.com/pic.jpg' });
        }
        if (u.startsWith('https://api.pinterest.com/v5/boards')) {
          return jsonResponse({ items: [{ id: 'board-1', name: 'My Board' }] });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    const res = await client.get('/api/pinterest/callback').query({ code: 'good-code', state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/accounts');

    const { rows } = await pool.query(
      "SELECT display_name, external_account_id, access_token, refresh_token, token_expires_at, metadata FROM social_accounts WHERE platform = 'pinterest'"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      display_name: 'alice',
      external_account_id: 'alice',
      access_token: 'at-1',
      // Kept so the 30-day access token can be renewed (lib/platforms/pinterest.js).
      refresh_token: 'rt-1',
    });
    expect(rows[0].token_expires_at).toBeInstanceOf(Date);
    expect(rows[0].metadata).toEqual({ board_id: 'board-1', board_name: 'My Board' });
  });

  it('creates a Postfalcon board for an account with none, in the configured API (sandbox)', async () => {
    process.env.PINTEREST_API_BASE = 'https://api-sandbox.pinterest.com';
    try {
      const client = await loginNewUser();
      const connect = await client.get('/api/pinterest/connect');
      const state = new URL(connect.headers.location).searchParams.get('state');

      let created;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url, opts) => {
          const u = String(url);
          if (u === 'https://api.pinterest.com/v5/oauth/token') return jsonResponse({ access_token: 'at-2', expires_in: 2592000 });
          // Profile reads stay on production, which Trial access allows.
          if (u === 'https://api.pinterest.com/v5/user_account') return jsonResponse({ username: 'noboards' });
          if (u === 'https://api-sandbox.pinterest.com/v5/boards?page_size=1') return jsonResponse({ items: [] });
          if (u === 'https://api-sandbox.pinterest.com/v5/boards' && opts.method === 'POST') {
            created = JSON.parse(opts.body);
            return jsonResponse({ id: 'sandbox-board', name: created.name }, 201);
          }
          throw new Error(`unexpected fetch: ${u}`);
        })
      );

      const res = await client.get('/api/pinterest/callback').query({ code: 'good-code', state });
      expect(res.status).toBe(302);
      expect(created.name).toBe('Postfalcon');
      const { rows } = await pool.query("SELECT metadata FROM social_accounts WHERE platform = 'pinterest'");
      expect(rows[0].metadata).toEqual({ board_id: 'sandbox-board', board_name: 'Postfalcon' });
    } finally {
      delete process.env.PINTEREST_API_BASE;
    }
  });

  it('refuses to connect when it has no board and none can be created', async () => {
    const client = await loginNewUser();
    const connect = await client.get('/api/pinterest/connect');
    const state = new URL(connect.headers.location).searchParams.get('state');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts) => {
        const u = String(url);
        if (u === 'https://api.pinterest.com/v5/oauth/token') return jsonResponse({ access_token: 'at-3', expires_in: 2592000 });
        if (u === 'https://api.pinterest.com/v5/user_account') return jsonResponse({ username: 'noboards' });
        if (u.startsWith('https://api.pinterest.com/v5/boards?')) return jsonResponse({ items: [] });
        if (u === 'https://api.pinterest.com/v5/boards' && opts.method === 'POST') return jsonResponse({ message: 'nope' }, 403);
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    const res = await client.get('/api/pinterest/callback').query({ code: 'good-code', state });
    expect(res.status).toBe(400);
  });
});
