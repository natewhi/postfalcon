import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';

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
  const email = `fb${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

function mockFacebookApi({ pages = [], linkedInstagram = {} } = {}) {
  return vi.fn(async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/v19.0/oauth/access_token') {
      if (u.searchParams.get('grant_type') === 'fb_exchange_token') {
        return jsonResponse({ access_token: 'long-lived-token' });
      }
      return jsonResponse({ access_token: 'short-lived-token' });
    }
    if (u.pathname === '/v19.0/me/accounts') {
      return jsonResponse({ data: pages });
    }
    const pageMatch = pages.find((p) => u.pathname === `/v19.0/${p.id}`);
    if (pageMatch) {
      const ig = linkedInstagram[pageMatch.id];
      return jsonResponse(ig ? { instagram_business_account: { id: ig.id } } : {});
    }
    const igEntry = Object.values(linkedInstagram).find((ig) => u.pathname === `/v19.0/${ig.id}`);
    if (igEntry) {
      return jsonResponse({ username: igEntry.username, profile_picture_url: igEntry.avatar });
    }
    throw new Error(`Unexpected fetch: ${u.toString()}`);
  });
}

describe('facebook oauth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/facebook/connect');
    expect(res.status).toBe(401);
  });

  it('redirects to the facebook authorize page with a state', async () => {
    const client = await loginNewUser();
    const res = await client.get('/api/facebook/connect');
    expect(res.status).toBe(302);

    const location = new URL(res.headers.location);
    expect(location.hostname).toBe('www.facebook.com');
    expect(location.searchParams.get('client_id')).toBe('test-app-id');
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(location.searchParams.get('scope')).toContain('pages_manage_posts');
  });

  it('rejects a callback with a mismatched state', async () => {
    const client = await loginNewUser();
    await client.get('/api/facebook/connect');

    const res = await client.get('/api/facebook/callback?code=fake&state=wrong');
    expect(res.status).toBe(400);
  });

  it('creates a facebook page account on callback', async () => {
    const client = await loginNewUser();
    vi.stubGlobal(
      'fetch',
      mockFacebookApi({
        pages: [
          {
            id: 'page-1',
            name: 'My Page',
            access_token: 'page-token-1',
            picture: { data: { url: 'https://example.com/page-1.png' } },
          },
        ],
      })
    );

    const connectRes = await client.get('/api/facebook/connect');
    const state = new URL(connectRes.headers.location).searchParams.get('state');

    const callbackRes = await client.get(`/api/facebook/callback?code=fake-code&state=${state}`);
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toBe('/accounts');

    const accounts = await client.get('/api/v1/social-accounts');
    expect(accounts.body).toHaveLength(1);
    expect(accounts.body[0].platform).toBe('facebook');
    expect(accounts.body[0].display_name).toBe('My Page');
    expect(accounts.body[0].avatar_url).toBe('https://example.com/page-1.png');
  });

  it('also creates a linked instagram account when present', async () => {
    const client = await loginNewUser();
    vi.stubGlobal(
      'fetch',
      mockFacebookApi({
        pages: [{ id: 'page-2', name: 'Another Page', access_token: 'page-token-2' }],
        linkedInstagram: { 'page-2': { id: 'ig-1', username: 'myhandle', avatar: 'https://example.com/ig-1.png' } },
      })
    );

    const connectRes = await client.get('/api/facebook/connect');
    const state = new URL(connectRes.headers.location).searchParams.get('state');
    await client.get(`/api/facebook/callback?code=fake-code&state=${state}`);

    const accounts = await client.get('/api/v1/social-accounts');
    expect(accounts.body).toHaveLength(2);
    const platforms = accounts.body.map((a) => a.platform).sort();
    expect(platforms).toEqual(['facebook', 'instagram']);
    const ig = accounts.body.find((a) => a.platform === 'instagram');
    expect(ig.display_name).toBe('@myhandle');
    expect(ig.avatar_url).toBe('https://example.com/ig-1.png');
  });

  it('does not create a duplicate page without a linked instagram account', async () => {
    const client = await loginNewUser();
    vi.stubGlobal(
      'fetch',
      mockFacebookApi({ pages: [{ id: 'page-3', name: 'No IG Page', access_token: 'page-token-3' }] })
    );

    const connectRes = await client.get('/api/facebook/connect');
    const state = new URL(connectRes.headers.location).searchParams.get('state');
    await client.get(`/api/facebook/callback?code=fake-code&state=${state}`);

    const accounts = await client.get('/api/v1/social-accounts');
    expect(accounts.body).toHaveLength(1);
    expect(accounts.body[0].platform).toBe('facebook');
  });
});
