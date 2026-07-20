import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';

// CSRF protection is skipped whenever NODE_ENV === 'test' (see app.js), the same way authLimiter
// already skips itself in tests, so the rest of the suite doesn't need to fetch a token for every
// mutating request. To actually exercise the real middleware here, these tests flip NODE_ENV for
// the duration of a single assertion and restore it immediately after. Safe because vitest.config.js
// sets fileParallelism: false, so nothing else runs concurrently while it's flipped.
describe('csrf protection', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  async function loginNewUser() {
    const client = request.agent(app);
    const email = `csrf${Date.now()}${Math.random()}@example.com`;
    await client.post('/api/users').send({ email, password: 'password123' });
    await client.post('/api/auth/login').send({ email, password: 'password123' });
    return client;
  }

  it('rejects a mutating request with no csrf token once protection is active', async () => {
    const client = await loginNewUser();
    process.env.NODE_ENV = 'development';

    const res = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('invalid_csrf_token');
  });

  it('allows a mutating request that presents a matching csrf token and cookie', async () => {
    const client = await loginNewUser();
    process.env.NODE_ENV = 'development';

    const tokenRes = await client.get('/api/csrf-token');
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.csrfToken).toBeTruthy();

    const res = await client
      .post('/api/v1/social-accounts')
      .set('x-csrf-token', tokenRes.body.csrfToken)
      .send({ platform: 'twitter', display_name: '@me' });
    expect(res.status).toBe(201);
  });

  it('supports the anonymous pre-login flow: fetch a token, then sign up with it', async () => {
    process.env.NODE_ENV = 'development';
    const client = request.agent(app);

    const tokenRes = await client.get('/api/csrf-token');
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.csrfToken).toBeTruthy();

    const email = `csrfanon${Date.now()}${Math.random()}@example.com`;
    const res = await client
      .post('/api/users')
      .set('x-csrf-token', tokenRes.body.csrfToken)
      .send({ email, password: 'password123' });
    expect(res.status).toBe(201);
  });

  it('exempts bearer-token-authenticated requests from csrf protection', async () => {
    const client = await loginNewUser();
    const tokenGen = await client.post('/api/auth/api-token');
    const bearerToken = tokenGen.body.token;

    process.env.NODE_ENV = 'development';

    const res = await request(app)
      .post('/api/v1/social-accounts')
      .set('Authorization', `Bearer ${bearerToken}`)
      .send({ platform: 'twitter', display_name: '@agent' });
    expect(res.status).toBe(201);
  });
});
