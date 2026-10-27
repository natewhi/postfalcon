import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { pool } from '../db/pool.js';

async function loginNewUser() {
  const client = request.agent(app);
  const email = `onb${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  return { client, userId: rows[0].id };
}

async function addAccount(client) {
  const res = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@onb' });
  return res.body.id;
}

describe('"Get started" checklist', () => {
  it('starts with nothing done and shows on the dashboard', async () => {
    const { client } = await loginNewUser();
    const res = await client.get('/api/onboarding');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ account: false, post: false, agent: false, complete: false, show: true });
    expect(res.body.quickPlatforms).toEqual(expect.arrayContaining(['Mastodon', 'Bluesky', 'Telegram']));

    const page = await client.get('/dashboard');
    expect(page.text).toContain('id="onboarding" class="onboarding"');
    expect(page.text).not.toMatch(/id="onboarding"[^>]*hidden/);
    expect(page.text).toContain('1 of 3 done');
  });

  it('ticks steps off from what the user has done; a draft is not a scheduled post', async () => {
    const { client, userId } = await loginNewUser();
    const accountId = await addAccount(client);
    expect((await client.get('/api/onboarding')).body).toMatchObject({ account: true, post: false, show: true });

    await pool.query("INSERT INTO posts (user_id, social_account_id, content, status) VALUES ($1, $2, 'draft', 'draft')", [
      userId,
      accountId,
    ]);
    expect((await client.get('/api/onboarding')).body.post).toBe(false);

    await pool.query(
      "INSERT INTO posts (user_id, social_account_id, content, status, scheduled_for) VALUES ($1, $2, 'go', 'scheduled', now() + interval '1 day')",
      [userId, accountId]
    );
    const done = (await client.get('/api/onboarding')).body;
    expect(done).toMatchObject({ account: true, post: true, complete: true, show: false });
    expect((await client.get('/dashboard')).text).toMatch(/id="onboarding"[^>]*hidden/);
  });

  it('notes an AI assistant once there is an API token', async () => {
    const { client } = await loginNewUser();
    await client.post('/api/auth/api-token');
    expect((await client.get('/api/onboarding')).body.agent).toBe(true);
    expect((await client.get('/dashboard')).text).toContain('Your AI assistant is set up');
  });

  it('stays closed once dismissed', async () => {
    const { client } = await loginNewUser();
    expect((await client.post('/api/onboarding/dismiss')).status).toBe(204);
    expect((await client.get('/api/onboarding')).body).toMatchObject({ dismissed: true, show: false });
    expect((await client.get('/dashboard')).text).toMatch(/id="onboarding"[^>]*hidden/);
  });

  it('is only for signed-in users', async () => {
    expect((await request(app).get('/api/onboarding')).status).toBe(401);
  });
});

describe('"Finish setting up your server" checklist', () => {
  it('shows admins what a fresh self-hosted install still needs, and only admins', async () => {
    await pool.query("DELETE FROM instance_settings WHERE key = 'signup_mode'");
    const { client, userId } = await loginNewUser();
    expect((await client.get('/dashboard')).text).not.toContain('id="admin-setup"');
    expect((await client.post('/api/onboarding/admin/dismiss')).status).toBe(404);

    await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [userId]);
    const page = (await client.get('/dashboard')).text;
    expect(page).toContain('id="admin-setup"');
    expect(page).toContain('Choose who can sign up');

    // Choosing a sign-up mode ticks that step off.
    await client.post('/api/admin/signups').send({ mode: 'invite' });
    // (If that was the last step on this test server, the whole card is gone instead.)
    const after = (await client.get('/dashboard')).text;
    if (after.includes('Choose who can sign up')) {
      const at = after.indexOf('Choose who can sign up');
      expect(after.slice(at - 400, at)).toContain('is-done');
    }
    await pool.query("DELETE FROM instance_settings WHERE key = 'signup_mode'");
  });

  it('stays closed once an admin dismisses it', async () => {
    const { client, userId } = await loginNewUser();
    await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [userId]);
    expect((await client.post('/api/onboarding/admin/dismiss')).status).toBe(204);
    expect((await client.get('/dashboard')).text).not.toContain('id="admin-setup"');
  });
});
