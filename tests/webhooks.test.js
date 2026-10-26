import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { pool } from '../db/pool.js';

async function loginNewUser(plan = 'team') {
  const client = request.agent(app);
  const email = `wh${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  await pool.query('UPDATE users SET plan = $1 WHERE id = $2', [plan, rows[0].id]);
  return { client, userId: rows[0].id };
}

describe('webhooks API', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/webhooks');
    expect(res.status).toBe(401);
  });

  it('is gated to plans with the webhooks capability when billing is on', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    try {
      const { client } = await loginNewUser('standard');
      const res = await client.get('/api/v1/webhooks');
      expect(res.status).toBe(402);
      expect(res.body.error).toBe('plan_capability');
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
    }
  });

  it('is open to every account when self-hosted (no Stripe key)', async () => {
    const { client } = await loginNewUser('standard');
    const res = await client.get('/api/v1/webhooks');
    expect(res.status).toBe(200);
  });

  it('lets a Team-plan user register, list, and delete a webhook', async () => {
    const { client } = await loginNewUser('team');

    const created = await client
      .post('/api/v1/webhooks')
      .send({ url: 'https://example.com/hooks/postfalcon' });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^whsec_/);
    expect(created.body.url).toBe('https://example.com/hooks/postfalcon');
    expect(created.body.events).toEqual(['post.published', 'post.failed']);

    const list = await client.get('/api/v1/webhooks');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].secret).toBeUndefined(); // only returned on creation

    const del = await client.delete(`/api/v1/webhooks/${created.body.id}`);
    expect(del.status).toBe(204);

    const after = await client.get('/api/v1/webhooks');
    expect(after.body).toHaveLength(0);
  });

  it('accepts a custom events subset', async () => {
    const { client } = await loginNewUser('pro');
    const res = await client
      .post('/api/v1/webhooks')
      .send({ url: 'https://example.com/only-failures', events: ['post.failed'] });
    expect(res.status).toBe(201);
    expect(res.body.events).toEqual(['post.failed']);
  });

  it('rejects a non-https url', async () => {
    const { client } = await loginNewUser('team');
    const res = await client.post('/api/v1/webhooks').send({ url: 'http://example.com/insecure' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown event name', async () => {
    const { client } = await loginNewUser('team');
    const res = await client
      .post('/api/v1/webhooks')
      .send({ url: 'https://example.com/x', events: ['post.exploded'] });
    expect(res.status).toBe(400);
  });

  it("won't delete another user's webhook", async () => {
    const { client: a } = await loginNewUser('team');
    const { client: b } = await loginNewUser('team');
    const created = await a.post('/api/v1/webhooks').send({ url: 'https://example.com/mine' });

    const res = await b.delete(`/api/v1/webhooks/${created.body.id}`);
    expect(res.status).toBe(404);
  });
});
