import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { pool } from '../db/pool.js';
import { setSignupMode, createInvite } from '../lib/signups.js';

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
    // No plan picked: straight into the app on the free plan.
    expect(res.headers.location).toBe('/dashboard');

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

describe('sign-up control (lib/signups.js)', () => {
  // Every rule except "first account" needs someone to already exist.
  async function existingUser() {
    await request(app).post('/api/users').send({ email: 'existing@example.com', password: 'password123' });
  }

  it('turns new accounts away when sign-ups are closed', async () => {
    await existingUser();
    await setSignupMode('closed', null);
    const res = await request(app).post('/api/users').send({ email: 'late@example.com', password: 'password123' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('signups_closed');
    const { rows } = await pool.query("SELECT 1 FROM users WHERE email = 'late@example.com'");
    expect(rows).toHaveLength(0);
  });

  it('always lets the first account on a fresh install in, even when closed', async () => {
    await setSignupMode('closed', null);
    const res = await request(app).post('/api/users').send({ email: 'owner@example.com', password: 'password123' });
    expect(res.status).toBe(201);
  });

  it('needs an invite when invite-only, and each invite works exactly once', async () => {
    await existingUser();
    await setSignupMode('invite', null);
    const { token, invite } = await createInvite({ note: 'for Sam', userId: null });

    const without = await request(app).post('/api/users').send({ email: 'sam@example.com', password: 'password123' });
    expect(without.status).toBe(403);
    expect(without.body.error).toBe('invite_required');

    const withInvite = await request(app)
      .post('/api/users')
      .send({ email: 'sam@example.com', password: 'password123', invite: token });
    expect(withInvite.status).toBe(201);
    const { rows } = await pool.query('SELECT used_at, used_by FROM invites WHERE id = $1', [invite.id]);
    expect(rows[0].used_at).not.toBeNull();
    expect(Number(rows[0].used_by)).toBe(Number(withInvite.body.id));

    const reuse = await request(app)
      .post('/api/users')
      .send({ email: 'sam2@example.com', password: 'password123', invite: token });
    expect(reuse.status).toBe(403);
    expect(reuse.body.error).toBe('invite_invalid');
  });

  it('refuses an expired invite', async () => {
    await existingUser();
    await setSignupMode('invite', null);
    const { token, invite } = await createInvite({ userId: null });
    await pool.query("UPDATE invites SET expires_at = now() - interval '1 minute' WHERE id = $1", [invite.id]);

    const res = await request(app).post('/api/users').send({ email: 'slow@example.com', password: 'password123', invite: token });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('invite_invalid');
  });

  it("doesn't use up an invite on a signup that fails (email already registered)", async () => {
    await existingUser();
    await setSignupMode('invite', null);
    const { token, invite } = await createInvite({ userId: null });

    const dup = await request(app)
      .post('/api/users')
      .send({ email: 'existing@example.com', password: 'password123', invite: token });
    expect(dup.status).toBe(409);
    const { rows } = await pool.query('SELECT used_at FROM invites WHERE id = $1', [invite.id]);
    expect(rows[0].used_at).toBeNull();
  });

  it('shows why on the signup page instead of a form that would be refused', async () => {
    await existingUser();
    await setSignupMode('invite', null);
    const blocked = await request(app).get('/signup');
    expect(blocked.text).toContain('by invitation');
    expect(blocked.text).not.toContain('id="signup-form"');

    const { token } = await createInvite({ userId: null });
    const invited = await request(app).get('/signup').query({ invite: token });
    expect(invited.text).toContain('id="signup-form"');
    expect(invited.text).toContain(`data-invite="${token}"`);

    await setSignupMode('closed', null);
    expect((await request(app).get('/signup')).text).toContain('Sign-ups are closed');
  });

  describe('first Google sign-in', () => {
    beforeAll(() => {
      process.env.GOOGLE_CLIENT_ID = 'gid';
      process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
    });
    afterEach(() => vi.unstubAllGlobals());

    async function googleSignIn(client, query = {}) {
      const start = await client.get('/api/auth/google').query(query);
      const state = new URL(start.headers.location).searchParams.get('state');
      return client.get('/api/auth/google/callback').query({ code: 'good-code', state });
    }

    it('is refused when sign-ups are closed, without creating the account', async () => {
      await existingUser();
      await setSignupMode('closed', null);
      stubGoogleFetch({ sub: 'g-closed', email: 'g-closed@example.com', email_verified: true });

      const res = await googleSignIn(request.agent(app));
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/signup?error=signups_closed');
      const { rows } = await pool.query("SELECT 1 FROM users WHERE email = 'g-closed@example.com'");
      expect(rows).toHaveLength(0);
    });

    it('works with an invite carried through from the signup page', async () => {
      await existingUser();
      await setSignupMode('invite', null);
      const { token, invite } = await createInvite({ userId: null });
      stubGoogleFetch({ sub: 'g-invited', email: 'g-invited@example.com', email_verified: true });

      const res = await googleSignIn(request.agent(app), { invite: token });
      expect(res.status).toBe(302);
      expect(res.headers.location).not.toContain('/signup');
      const { rows } = await pool.query('SELECT used_by FROM invites WHERE id = $1', [invite.id]);
      expect(rows[0].used_by).not.toBeNull();
    });

    it('still logs in an existing account when sign-ups are closed', async () => {
      await request(app).post('/api/users').send({ email: 'g-existing@example.com', password: 'password123' });
      await setSignupMode('closed', null);
      stubGoogleFetch({ sub: 'g-existing', email: 'g-existing@example.com', email_verified: true });

      const res = await googleSignIn(request.agent(app));
      expect(res.headers.location).toBe('/dashboard');
    });
  });
});

