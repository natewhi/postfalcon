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
  const email = `bs${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

const VALID_APP_PASSWORD = 'abcd-efgh-ijkl-mnop';

function mockCreateSession({ ok = true, did = 'did:plc:abc123', handle = 'alice.bsky.social' } = {}) {
  return vi.fn(async (url) => {
    const u = String(url);
    if (u === 'https://bsky.social/xrpc/com.atproto.server.createSession') {
      return ok ? jsonResponse({ did, handle, accessJwt: 'jwt-1' }) : jsonResponse({ message: 'Invalid identifier or password' }, 401);
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
}

describe('bluesky connect', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/bluesky/connect')
      .send({ handle: 'alice.bsky.social', app_password: VALID_APP_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed app password before calling Bluesky', async () => {
    const client = await loginNewUser();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await client
      .post('/api/bluesky/connect')
      .send({ handle: 'alice.bsky.social', app_password: 'not-a-password' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stores the account after logging in', async () => {
    const client = await loginNewUser();
    vi.stubGlobal('fetch', mockCreateSession());

    const res = await client
      .post('/api/bluesky/connect')
      .send({ handle: 'alice.bsky.social', app_password: VALID_APP_PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.display_name).toBe('@alice.bsky.social');

    const { rows } = await pool.query(
      'SELECT platform, display_name, external_account_id, access_token FROM social_accounts WHERE id = $1',
      [res.body.id]
    );
    expect(rows[0]).toMatchObject({
      platform: 'bluesky',
      display_name: '@alice.bsky.social',
      external_account_id: 'did:plc:abc123',
      access_token: VALID_APP_PASSWORD,
    });
  });

  it('rejects an invalid handle/app password', async () => {
    const client = await loginNewUser();
    vi.stubGlobal('fetch', mockCreateSession({ ok: false }));
    const res = await client
      .post('/api/bluesky/connect')
      .send({ handle: 'alice.bsky.social', app_password: VALID_APP_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('reconnecting the same account updates the app password in place', async () => {
    const client = await loginNewUser();
    vi.stubGlobal('fetch', mockCreateSession());
    const first = await client
      .post('/api/bluesky/connect')
      .send({ handle: 'alice.bsky.social', app_password: VALID_APP_PASSWORD });

    const newPassword = 'wxyz-2345-6723-4567';
    const second = await client
      .post('/api/bluesky/connect')
      .send({ handle: 'alice.bsky.social', app_password: newPassword });
    expect(second.body.id).toBe(first.body.id);

    const { rows } = await pool.query("SELECT access_token FROM social_accounts WHERE platform = 'bluesky'");
    expect(rows).toHaveLength(1);
    expect(rows[0].access_token).toBe(newPassword);
  });
});
