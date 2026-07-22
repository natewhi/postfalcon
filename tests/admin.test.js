import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { pool } from '../db/pool.js';

async function signupAndLogin(email) {
  const client = request.agent(app);
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

async function makeAdmin(email) {
  await pool.query('UPDATE users SET is_admin = true WHERE email = $1', [email]);
}

describe('admin access control', () => {
  it('404s the admin page for an anonymous visitor', async () => {
    const res = await request(app).get('/admin/activity');
    expect(res.status).toBe(404);
  });

  it('404s the admin page for a logged-in non-admin', async () => {
    const client = await signupAndLogin('notadmin@example.com');
    const res = await client.get('/admin/activity');
    expect(res.status).toBe(404);
  });

  it('serves the admin page for an admin', async () => {
    const email = 'admin1@example.com';
    const client = await signupAndLogin(email);
    await makeAdmin(email);

    const res = await client.get('/admin/activity');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Admin');
  });

  it('404s the admin api (as json) for an anonymous caller', async () => {
    const res = await request(app).get('/api/admin/auth-events');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('404s the admin api for a logged-in non-admin', async () => {
    const client = await signupAndLogin('notadmin2@example.com');
    const res = await client.get('/api/admin/auth-events');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });
});

describe('admin activity endpoints', () => {
  it('lists auth events across all users, newest first, with filtering', async () => {
    const adminEmail = 'admin2@example.com';
    const admin = await signupAndLogin(adminEmail);
    await makeAdmin(adminEmail);
    await signupAndLogin('other-user@example.com');

    const res = await admin.get('/api/admin/auth-events').query({ eventType: 'signup' });
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThanOrEqual(2);
    expect(res.body.rows.every((r) => r.event_type === 'signup')).toBe(true);
    const emails = res.body.rows.map((r) => r.email);
    expect(emails).toContain(adminEmail);
    expect(emails).toContain('other-user@example.com');
  });

  it('filters auth events by email substring', async () => {
    const adminEmail = 'admin3@example.com';
    const admin = await signupAndLogin(adminEmail);
    await makeAdmin(adminEmail);
    await signupAndLogin('findme-target@example.com');

    const res = await admin.get('/api/admin/auth-events').query({ email: 'findme' });
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThan(0);
    expect(res.body.rows.every((r) => r.email.includes('findme'))).toBe(true);
  });

  it('paginates results', async () => {
    const adminEmail = 'admin4@example.com';
    const admin = await signupAndLogin(adminEmail);
    await makeAdmin(adminEmail);

    await pool.query(
      `INSERT INTO auth_events (event_type, email) VALUES ('login_success', 'p1@x.com'), ('login_success', 'p2@x.com'), ('login_success', 'p3@x.com')`
    );

    // email filter scopes this to just the 3 rows inserted above — without it, the admin's
    // own signup+login (from signupAndLogin) would also match event_type: 'login_success'.
    const page1 = await admin
      .get('/api/admin/auth-events')
      .query({ eventType: 'login_success', email: '@x.com', page: 1, pageSize: 2 });
    expect(page1.body.rows).toHaveLength(2);
    expect(page1.body.total).toBe(3);

    const page2 = await admin
      .get('/api/admin/auth-events')
      .query({ eventType: 'login_success', email: '@x.com', page: 2, pageSize: 2 });
    expect(page2.body.rows).toHaveLength(1);
  });

  it('lists page visits across users with the visiting user\'s email joined in', async () => {
    const adminEmail = 'admin5@example.com';
    const admin = await signupAndLogin(adminEmail);
    await makeAdmin(adminEmail);
    const other = await signupAndLogin('visitor@example.com');
    await other.get('/dashboard');

    const res = await admin.get('/api/admin/page-visits').query({ path: '/dashboard' });
    expect(res.status).toBe(200);
    expect(res.body.rows.some((r) => r.email === 'visitor@example.com')).toBe(true);
  });

  it('lists product events with metadata intact', async () => {
    const adminEmail = 'admin6@example.com';
    const admin = await signupAndLogin(adminEmail);
    await makeAdmin(adminEmail);
    const other = await signupAndLogin('poster@example.com');
    const account = await other.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    await other.post('/api/v1/posts').send({ social_account_id: account.body.id, content: 'hi' });

    const res = await admin.get('/api/admin/product-events').query({ eventName: 'post_created' });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].email).toBe('poster@example.com');
    expect(res.body.rows[0].metadata.status).toBe('draft');
  });
});
