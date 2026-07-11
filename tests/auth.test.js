import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app.js';

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
