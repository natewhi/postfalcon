import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { pool } from '../db/pool.js';

describe('signup + login', () => {
  it('signs up, logs in, and reads /api/auth/me', async () => {
    const client = request.agent(app);
    const email = 'test@example.com';
    const password = 'password123';

    const signupRes = await client.post('/api/users').send({ email, password });
    expect(signupRes.status).toBe(201);
    expect(signupRes.body.email).toBe(email);

    const loginRes = await client.post('/api/auth/login').send({ email, password });
    expect(loginRes.status).toBe(200);

    const meRes = await client.get('/api/auth/me');
    expect(meRes.status).toBe(200);
    expect(meRes.body.id).toBe(signupRes.body.id);
  });

  it('rejects invalid login credentials', async () => {
    const client = request.agent(app);
    await client.post('/api/users').send({ email: 'a@b.com', password: 'password123' });

    const res = await client.post('/api/auth/login').send({ email: 'a@b.com', password: 'wrongpassword' });
    expect(res.status).toBe(401);
  });

  it('rejects signup with an invalid email', async () => {
    const res = await request(app).post('/api/users').send({ email: 'not-an-email', password: 'password123' });
    expect(res.status).toBe(400);
  });

  it('rejects signup with a short password', async () => {
    const res = await request(app).post('/api/users').send({ email: 'short@example.com', password: 'short' });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate signup email with 409', async () => {
    const email = 'dup@example.com';
    await request(app).post('/api/users').send({ email, password: 'password123' });
    const res = await request(app).post('/api/users').send({ email, password: 'password123' });
    expect(res.status).toBe(409);
  });
});

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function stubGoogleFetch(profile) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const u = String(url);
      if (u === 'https://oauth2.googleapis.com/token') {
        return jsonResponse({ access_token: 'gat-1', expires_in: 3600 });
      }
      if (u === 'https://www.googleapis.com/oauth2/v3/userinfo') {
        return jsonResponse(profile);
      }
      throw new Error(`unexpected fetch: ${u}`);
    })
  );
}

describe('google sign-in', () => {
  beforeAll(() => {
    process.env.GOOGLE_CLIENT_ID = 'gid';
    process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
  });

  afterEach(() => vi.unstubAllGlobals());

  it('redirects to the Google consent screen with login-only scopes', async () => {
    const res = await request(app).get('/api/auth/google');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(res.headers.location).toContain('scope=openid+email+profile');
    // Login has no need for a stored token, unlike the YouTube connect flow.
    expect(res.headers.location).not.toContain('access_type=offline');
  });

  it('rejects a callback with a mismatched state', async () => {
    const client = request.agent(app);
    await client.get('/api/auth/google');
    const res = await client.get('/api/auth/google/callback').query({ code: 'x', state: 'wrong' });
    expect(res.status).toBe(400);
  });

  it('creates a new account on first Google sign-in, verified and password-less', async () => {
    const client = request.agent(app);
    const start = await client.get('/api/auth/google');
    const state = new URL(start.headers.location).searchParams.get('state');
    stubGoogleFetch({ sub: 'google-1', email: 'new-google-user@example.com', email_verified: true });

    const res = await client.get('/api/auth/google/callback').query({ code: 'good-code', state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/pricing');

    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', ['new-google-user@example.com']);
    expect(rows).toHaveLength(1);
    expect(rows[0].google_id).toBe('google-1');
    expect(rows[0].password_hash).toBeNull();
    expect(rows[0].email_verified_at).not.toBeNull();

    const me = await client.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('new-google-user@example.com');
  });

  it('carries a ?plan= through to the post-signup redirect', async () => {
    const client = request.agent(app);
    const start = await client.get('/api/auth/google').query({ plan: 'team' });
    const state = new URL(start.headers.location).searchParams.get('state');
    stubGoogleFetch({ sub: 'google-2', email: 'plan-google-user@example.com', email_verified: true });

    const res = await client.get('/api/auth/google/callback').query({ code: 'good-code', state });
    expect(res.headers.location).toBe('/pricing?start=team');
  });

  it('links Google to an existing password account matched by email, and logs in as that user', async () => {
    await request(app).post('/api/users').send({ email: 'linkme@example.com', password: 'password123' });

    const client = request.agent(app);
    const start = await client.get('/api/auth/google');
    const state = new URL(start.headers.location).searchParams.get('state');
    stubGoogleFetch({ sub: 'google-3', email: 'linkme@example.com', email_verified: true });

    const res = await client.get('/api/auth/google/callback').query({ code: 'good-code', state });
    // An existing account, not a new one — lands in the app, not back on /pricing.
    expect(res.headers.location).toBe('/dashboard');

    const { rows } = await pool.query('SELECT google_id, password_hash FROM users WHERE email = $1', [
      'linkme@example.com',
    ]);
    expect(rows[0].google_id).toBe('google-3');
    expect(rows[0].password_hash).not.toBeNull(); // the original password is untouched
  });

  it('logs in a returning Google user on a second sign-in', async () => {
    const first = request.agent(app);
    const start1 = await first.get('/api/auth/google');
    const state1 = new URL(start1.headers.location).searchParams.get('state');
    stubGoogleFetch({ sub: 'google-4', email: 'returning@example.com', email_verified: true });
    await first.get('/api/auth/google/callback').query({ code: 'good-code', state: state1 });

    const second = request.agent(app);
    const start2 = await second.get('/api/auth/google');
    const state2 = new URL(start2.headers.location).searchParams.get('state');
    stubGoogleFetch({ sub: 'google-4', email: 'returning@example.com', email_verified: true });
    const res = await second.get('/api/auth/google/callback').query({ code: 'good-code', state: state2 });

    expect(res.headers.location).toBe('/dashboard');
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE email = 'returning@example.com'");
    expect(rows[0].n).toBe(1); // no duplicate account created
  });
});
