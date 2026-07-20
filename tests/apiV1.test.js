import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app.js';

async function loginNewUser() {
  const client = request.agent(app);
  const email = `apiv1${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

describe('unversioned resource paths', () => {
  it('no longer resolve — posts and social-accounts only exist under /api/v1', async () => {
    expect((await request(app).get('/api/posts')).status).toBe(404);
    expect((await request(app).get('/api/social-accounts')).status).toBe(404);
  });
});

describe('/api/v1 resource routes', () => {
  it('serves social-accounts and posts via a bearer token', async () => {
    const client = await loginNewUser();
    const token = (await client.post('/api/auth/api-token')).body.token;

    const account = await request(app)
      .post('/api/v1/social-accounts')
      .set('Authorization', `Bearer ${token}`)
      .send({ platform: 'mastodon', display_name: '@me' });
    expect(account.status).toBe(201);

    const posts = await request(app).get('/api/v1/posts').set('Authorization', `Bearer ${token}`);
    expect(posts.status).toBe(200);
    expect(posts.body).toEqual([]);
  });
});

describe('CORS on /api/v1', () => {
  it('allows a cross-origin preflight request without authentication', async () => {
    const res = await request(app)
      .options('/api/v1/posts')
      .set('Origin', 'https://example.com')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('sets the CORS header on an authenticated response', async () => {
    const client = await loginNewUser();
    const token = (await client.post('/api/auth/api-token')).body.token;

    const res = await request(app)
      .get('/api/v1/posts')
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', 'https://example.com');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('does not add CORS headers on the unversioned api', async () => {
    const res = await request(app).get('/api/auth/me').set('Origin', 'https://example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
