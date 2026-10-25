import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { savePlatformSetting, clearPlatformSetting } from '../lib/platformSettings.js';
import { pool } from '../db/pool.js';
import { escapeLittleText } from '../lib/platforms/linkedin.js';

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

// Walks a logged-in client through /connect and a mocked token + userinfo exchange.
async function connectWithMockedLinkedIn(client, { accessToken = 'at-1', sub = 'li-123', name = 'Alice Example' } = {}) {
  const connect = await client.get('/api/linkedin/connect');
  const state = new URL(connect.headers.location).searchParams.get('state');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const u = String(url);
      if (u === 'https://www.linkedin.com/oauth/v2/accessToken') {
        return jsonResponse({ access_token: accessToken, expires_in: 5184000 });
      }
      if (u === 'https://api.linkedin.com/v2/userinfo') {
        return jsonResponse({ sub, name, picture: 'https://example.com/pic.jpg' });
      }
      throw new Error(`unexpected fetch: ${u}`);
    })
  );
  return client.get('/api/linkedin/callback').query({ code: 'good-code', state });
}

describe('linkedin escapeLittleText', () => {
  it('escapes the little-text-format markup characters', () => {
    expect(escapeLittleText('New (beta) feature [v2] {x} <y> @bob *bold* _it_ ~s~ a|b \\ end')).toBe(
      'New \\(beta\\) feature \\[v2\\] \\{x\\} \\<y\\> \\@bob \\*bold\\* \\_it\\_ \\~s\\~ a\\|b \\\\ end'
    );
  });

  it('leaves hashtags, URLs and ordinary punctuation alone', () => {
    const text = 'Launching today! #buildinpublic https://postfalcon.co/blog?x=1 — 50% off, "quoted".';
    expect(escapeLittleText(text)).toBe(text);
  });

  it('treats missing content as an empty post body', () => {
    expect(escapeLittleText(null)).toBe('');
  });
});

describe('linkedin platform switch', () => {
  it('404s the connect route while LinkedIn is switched off (its default)', async () => {
    const client = await loginNewUser();
    const res = await client.get('/api/linkedin/connect');
    expect(res.status).toBe(404);
  });
});

describe('linkedin oauth', () => {
  // LinkedIn is unlisted (off) by default, which blocks its connect routes; switch it on for these
  // tests the same way the admin Platforms page would. Inside the describe so the cleanup runs
  // before tests/setup.js's file-level afterAll closes the database pool.
  beforeAll(async () => {
    await savePlatformSetting('linkedin', true, null);
  });
  afterAll(async () => {
    await clearPlatformSetting('linkedin');
  });

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

  it('says so when LinkedIn credentials are not configured', async () => {
    const client = await loginNewUser();
    const saved = process.env.LINKEDIN_CLIENT_ID;
    delete process.env.LINKEDIN_CLIENT_ID;
    try {
      const res = await client.get('/api/linkedin/connect');
      expect(res.status).toBe(503);
    } finally {
      process.env.LINKEDIN_CLIENT_ID = saved;
    }
  });

  it('asks for the OpenID Connect profile scopes and the callback redirect URI', async () => {
    const client = await loginNewUser();
    const res = await client.get('/api/linkedin/connect');
    const url = new URL(res.headers.location);
    expect(url.searchParams.get('scope')).toBe('openid profile email w_member_social');
    expect(url.searchParams.get('redirect_uri')).toBe(`${process.env.BASE_URL}/api/linkedin/callback`);
    expect(url.searchParams.get('client_id')).toBe('lid');
  });

  it('goes back to Accounts without storing anything when the user cancels consent', async () => {
    const client = await loginNewUser();
    const connect = await client.get('/api/linkedin/connect');
    const state = new URL(connect.headers.location).searchParams.get('state');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await client
      .get('/api/linkedin/callback')
      .query({ error: 'user_cancelled_authorize', error_description: 'The user cancelled the authorization', state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/accounts');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still rejects an error callback whose state does not match', async () => {
    const client = await loginNewUser();
    await client.get('/api/linkedin/connect');
    const res = await client.get('/api/linkedin/callback').query({ error: 'user_cancelled_authorize', state: 'wrong' });
    expect(res.status).toBe(400);
  });

  it('502s when LinkedIn refuses the code exchange', async () => {
    const client = await loginNewUser();
    const connect = await client.get('/api/linkedin/connect');
    const state = new URL(connect.headers.location).searchParams.get('state');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'invalid_request' }, 400)));

    const res = await client.get('/api/linkedin/callback').query({ code: 'bad', state });
    expect(res.status).toBe(502);
  });

  it('502s when the userinfo response has no member id', async () => {
    const client = await loginNewUser();
    const connect = await client.get('/api/linkedin/connect');
    const state = new URL(connect.headers.location).searchParams.get('state');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) =>
        String(url).includes('accessToken') ? jsonResponse({ access_token: 'at-x', expires_in: 60 }) : jsonResponse({}, 401)
      )
    );

    const res = await client.get('/api/linkedin/callback').query({ code: 'good-code', state });
    expect(res.status).toBe(502);
  });

  it('updates the token in place when the same profile reconnects, and clears needs_reconnect', async () => {
    const client = await loginNewUser();
    const first = await connectWithMockedLinkedIn(client, { accessToken: 'old-token', sub: 'li-recon' });
    expect(first.status).toBe(302);
    await pool.query(
      "UPDATE social_accounts SET needs_reconnect_at = now() WHERE platform = 'linkedin' AND external_account_id = 'li-recon'"
    );

    const second = await connectWithMockedLinkedIn(client, { accessToken: 'new-token', sub: 'li-recon', name: 'Alice Renamed' });
    expect(second.status).toBe(302);

    const { rows } = await pool.query(
      "SELECT display_name, access_token, needs_reconnect_at FROM social_accounts WHERE platform = 'linkedin' AND external_account_id = 'li-recon'"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ display_name: 'Alice Renamed', access_token: 'new-token', needs_reconnect_at: null });
  });
});
