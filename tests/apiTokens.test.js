import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app.js';

async function loginNewUser() {
  const client = request.agent(app);
  const email = `token${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

describe('api token management', () => {
  it('requires authentication for all token endpoints', async () => {
    expect((await request(app).get('/api/auth/api-token')).status).toBe(401);
    expect((await request(app).post('/api/auth/api-token')).status).toBe(401);
    expect((await request(app).delete('/api/auth/api-token')).status).toBe(401);
  });

  it('reports no token until one is generated', async () => {
    const client = await loginNewUser();
    const status = await client.get('/api/auth/api-token');
    expect(status.body).toEqual({ exists: false });
  });

  it('generates a token, shown once, and reflects status afterward', async () => {
    const client = await loginNewUser();
    const gen = await client.post('/api/auth/api-token');
    expect(gen.status).toBe(201);
    expect(gen.body.token).toMatch(/^pf_[a-f0-9]{48}$/);

    const status = await client.get('/api/auth/api-token');
    expect(status.body.exists).toBe(true);
    expect(status.body.last_used_at).toBeNull();
  });

  it('regenerating invalidates the previous token', async () => {
    const client = await loginNewUser();
    const first = await client.post('/api/auth/api-token');
    const second = await client.post('/api/auth/api-token');
    expect(first.body.token).not.toBe(second.body.token);

    const oldTokenRes = await request(app).get('/api/posts').set('Authorization', `Bearer ${first.body.token}`);
    expect(oldTokenRes.status).toBe(401);

    const newTokenRes = await request(app).get('/api/posts').set('Authorization', `Bearer ${second.body.token}`);
    expect(newTokenRes.status).toBe(200);
  });

  it('revokes the token', async () => {
    const client = await loginNewUser();
    const gen = await client.post('/api/auth/api-token');

    const del = await client.delete('/api/auth/api-token');
    expect(del.status).toBe(204);

    const status = await client.get('/api/auth/api-token');
    expect(status.body).toEqual({ exists: false });

    const res = await request(app).get('/api/posts').set('Authorization', `Bearer ${gen.body.token}`);
    expect(res.status).toBe(401);
  });
});

describe('bearer token authentication on the api', () => {
  it('rejects a garbage bearer token', async () => {
    const res = await request(app).get('/api/posts').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('authenticates requests with a valid bearer token, scoped to the token owner', async () => {
    const clientA = await loginNewUser();
    const clientB = await loginNewUser();
    const tokenA = (await clientA.post('/api/auth/api-token')).body.token;

    const accountA = await clientA.post('/api/social-accounts').send({ platform: 'twitter', display_name: '@a' });
    await clientA.post('/api/posts').send({ social_account_id: accountA.body.id, content: 'from A via session' });

    const accountB = await clientB.post('/api/social-accounts').send({ platform: 'twitter', display_name: '@b' });
    await clientB.post('/api/posts').send({ social_account_id: accountB.body.id, content: 'from B via session' });

    const viaToken = await request(app).get('/api/posts').set('Authorization', `Bearer ${tokenA}`);
    expect(viaToken.status).toBe(200);
    expect(viaToken.body).toHaveLength(1);
    expect(viaToken.body[0].content).toBe('from A via session');
  });

  it('lets an agent create a post via bearer token that shows up for the normal session user', async () => {
    const client = await loginNewUser();
    const token = (await client.post('/api/auth/api-token')).body.token;
    const account = await client.post('/api/social-accounts').send({ platform: 'mastodon', display_name: '@me' });

    const created = await request(app)
      .post('/api/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ social_account_id: account.body.id, content: 'scheduled by an agent' });
    expect(created.status).toBe(201);

    const list = await client.get('/api/posts');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].content).toBe('scheduled by an agent');
  });
});
