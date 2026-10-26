import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

describe('admin billing view', () => {
  it("lists accounts' billing state, filterable by status", async () => {
    const email = 'admin-billing@example.com';
    const client = await signupAndLogin(email);
    await makeAdmin(email);
    await signupAndLogin('payer@example.com');
    await pool.query("UPDATE users SET plan = 'pro', plan_status = 'past_due' WHERE email = 'payer@example.com'");

    const res = await client.get('/api/admin/billing').query({ status: 'past_due' });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({ email: 'payer@example.com', plan: 'pro', plan_status: 'past_due' });
  });

  it('is admin-only', async () => {
    const client = await signupAndLogin('not-admin-billing@example.com');
    const res = await client.get('/api/admin/billing');
    expect(res.status).toBe(404);
  });
});

describe('admin sidebar link', () => {
  it('shows the Admin link to an admin', async () => {
    const email = 'admin-link@example.com';
    const client = await signupAndLogin(email);
    await makeAdmin(email);
    const res = await client.get('/settings');
    expect(res.text).toContain('href="/admin/activity"');
  });

  it('hides it from everyone else', async () => {
    const client = await signupAndLogin('no-admin-link@example.com');
    const res = await client.get('/settings');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('href="/admin/activity"');
  });
});

describe('admin overview', () => {
  async function adminClient(email) {
    const client = await signupAndLogin(email);
    await makeAdmin(email);
    return client;
  }

  it('serves the overview and customers pages to admins only', async () => {
    const admin = await adminClient('admin-pages@example.com');
    expect((await admin.get('/admin/overview')).status).toBe(200);
    expect((await admin.get('/admin/customers')).status).toBe(200);
    const other = await signupAndLogin('not-admin-pages@example.com');
    expect((await other.get('/admin/overview')).status).toBe(404);
    expect((await other.get('/api/admin/overview')).status).toBe(404);
  });

  it('reports setup, scheduler, publishing, business and storage without leaking secrets', async () => {
    const admin = await adminClient('admin-overview@example.com');
    const payer = await signupAndLogin('overview-payer@example.com');
    await pool.query(
      `UPDATE users SET stripe_customer_id = 'cus_ov', plan = 'team', plan_status = 'active', plan_interval = 'yearly',
         plan_renews_at = now() + interval '300 days' WHERE email = 'overview-payer@example.com'`
    );
    const { rows: acc } = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, needs_reconnect_at, reconnect_reason)
       SELECT id, 'mastodon', '@ov', 'ov-1', 'secret-token', now(), 'token revoked' FROM users WHERE email = 'overview-payer@example.com'
       RETURNING id, user_id`
    );
    await pool.query(
      `INSERT INTO posts (user_id, social_account_id, content, status, error_message)
       VALUES ($1, $2, 'broke', 'failed', 'Mastodon said no')`,
      [acc[0].user_id, acc[0].id]
    );
    expect(payer).toBeTruthy();

    const res = await admin.get('/api/admin/overview');
    expect(res.status).toBe(200);
    const { setup, scheduler, publishing, business, storage } = res.body;

    expect(Array.isArray(setup.checks)).toBe(true);
    expect(setup.platforms.find((p) => p.name === 'Mastodon').configured).toBe(true);
    expect(scheduler).toMatchObject({ overduePosts: 0 });
    expect(publishing.recentFailures[0]).toMatchObject({ platform: 'mastodon', error_message: 'Mastodon said no' });
    expect(publishing.needsReconnect[0]).toMatchObject({ display_name: '@ov', reconnect_reason: 'token revoked' });
    expect(business.paying).toBe(1);
    expect(business.mrrUsd).toBe(32.5); // Team yearly $390 / 12
    expect(storage.local).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain('secret-token');
  });

  it('flags overdue posts the scheduler has not sent', async () => {
    const admin = await adminClient('admin-overdue@example.com');
    const { rows: acc } = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       SELECT id, 'mastodon', '@late', 'late-1', 't' FROM users WHERE email = 'admin-overdue@example.com' RETURNING id, user_id`
    );
    await pool.query(
      `INSERT INTO posts (user_id, social_account_id, content, status, scheduled_for)
       VALUES ($1, $2, 'late', 'scheduled', now() - interval '20 minutes')`,
      [acc[0].user_id, acc[0].id]
    );
    const res = await admin.get('/api/admin/overview');
    expect(res.body.scheduler.overduePosts).toBe(1);
  });
});

describe('admin customers', () => {
  it('finds a customer and shows their details', async () => {
    const email = 'admin-cust@example.com';
    const admin = await signupAndLogin(email);
    await makeAdmin(email);
    await signupAndLogin('findme@example.com');

    const list = await admin.get('/api/admin/users').query({ q: 'findme' });
    expect(list.body).toHaveLength(1);
    const detail = await admin.get(`/api/admin/users/${list.body[0].id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.user.email).toBe('findme@example.com');
    expect(detail.body.accounts).toEqual([]);
    expect((await admin.get('/api/admin/users/999999')).status).toBe(404);
  });

  it('gives and removes free access for a login with no subscription', async () => {
    const email = 'admin-access@example.com';
    const admin = await signupAndLogin(email);
    await makeAdmin(email);
    await signupAndLogin('reviewer@example.com');
    const { rows } = await pool.query("SELECT id FROM users WHERE email = 'reviewer@example.com'");

    const granted = await admin.post(`/api/admin/users/${rows[0].id}/access`).send({ grant: true, plan: 'team' });
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({ plan: 'team', plan_status: 'active' });

    const revoked = await admin.post(`/api/admin/users/${rows[0].id}/access`).send({ grant: false });
    expect(revoked.body.plan_status).toBe('canceled');

    expect((await admin.post(`/api/admin/users/${rows[0].id}/access`).send({ grant: 'yes' })).status).toBe(400);
  });

  it('is admin-only', async () => {
    const other = await signupAndLogin('not-admin-cust@example.com');
    expect((await other.get('/api/admin/users')).status).toBe(404);
    expect((await other.post('/api/admin/users/1/access').send({ grant: true })).status).toBe(404);
  });
});

describe('admin overview backups check', () => {
  it('flags a missing database backup, and reports a recent one', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-backups-'));
    process.env.BACKUP_DIR = dir;
    try {
      const email = 'admin-backup@example.com';
      const admin = await signupAndLogin(email);
      await makeAdmin(email);

      let res = await admin.get('/api/admin/overview');
      expect(res.body.setup.checks.find((c) => c.title === 'No database backup yet')?.level).toBe('error');

      await fs.writeFile(path.join(dir, 'postfalcon-2026-01-01.dump'), 'x');
      res = await admin.get('/api/admin/overview');
      expect(res.body.setup.checks.find((c) => c.title === 'Database is backed up')?.level).toBe('ok');
    } finally {
      delete process.env.BACKUP_DIR;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('admin platform switches', () => {
  async function adminClient(email) {
    const client = await signupAndLogin(email);
    await makeAdmin(email);
    return client;
  }

  it('lists platforms with their defaults (LinkedIn and X off, Mastodon on), without the twitter placeholder', async () => {
    const admin = await adminClient('admin-plat-list@example.com');
    const res = await admin.get('/api/admin/platforms');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.map((p) => [p.id, p]));
    expect(byId.mastodon).toMatchObject({ built: true, enabled: true, credentialsSet: true });
    expect(byId.linkedin.enabled).toBe(false);
    expect(byId.x.enabled).toBe(false);
    expect(byId.reddit.built).toBe(false);
    expect(byId.twitter).toBeUndefined();
  });

  it('switching a platform off hides it everywhere and blocks connecting; reset restores it', async () => {
    const admin = await adminClient('admin-plat-off@example.com');
    try {
      const off = await admin.post('/api/admin/platforms/mastodon').send({ enabled: false });
      expect(off.body).toEqual({ id: 'mastodon', enabled: false });

      expect((await admin.get('/api/mastodon/connect').query({ instance: 'mastodon.social' })).status).toBe(404);
      // The Accounts page's hand-built Mastodon block goes too, not just the generated ones.
      const accountsPage = await admin.get('/accounts');
      expect(accountsPage.text).not.toContain('id="connect-mastodon"');
      expect(accountsPage.text).toContain('id="connect-bluesky"');
      const landing = await request(app).get('/');
      expect(landing.text).not.toContain('Instagram, Mastodon, YouTube');
      expect(landing.text).toContain('Instagram, YouTube');
      const list = await admin.get('/api/admin/platforms');
      expect(list.body.find((p) => p.id === 'mastodon').switchedAt).toBeTruthy();
    } finally {
      const reset = await admin.post('/api/admin/platforms/mastodon').send({ reset: true });
      expect(reset.body.enabled).toBe(true);
    }
    expect((await request(app).get('/')).text).toContain('Instagram, Mastodon, YouTube');
  });

  it('keeps the shared Facebook connect for whichever of Facebook/Instagram is still on', async () => {
    const admin = await adminClient('admin-plat-ig@example.com');
    try {
      await admin.post('/api/admin/platforms/instagram').send({ enabled: false });
      let page = await admin.get('/accounts');
      expect(page.text).toContain('Connect Facebook</a>');
      expect(page.text).not.toContain('Connect Facebook / Instagram');

      await admin.post('/api/admin/platforms/facebook').send({ enabled: false });
      page = await admin.get('/accounts');
      expect(page.text).not.toContain('id="connect-facebook"');
      expect((await admin.get('/api/facebook/connect')).status).toBe(404);
    } finally {
      await admin.post('/api/admin/platforms/instagram').send({ reset: true });
      await admin.post('/api/admin/platforms/facebook').send({ reset: true });
    }
    expect((await admin.get('/accounts')).text).toContain('Connect Facebook / Instagram');
  });

  it('turns an unlisted platform on, and refuses to turn on one that is not built', async () => {
    const admin = await adminClient('admin-plat-on@example.com');
    try {
      expect((await admin.post('/api/admin/platforms/x').send({ enabled: true })).body.enabled).toBe(true);
      expect((await request(app).get('/')).text).toContain(', and X');
    } finally {
      await admin.post('/api/admin/platforms/x').send({ reset: true });
    }
    expect((await admin.post('/api/admin/platforms/reddit').send({ enabled: true })).status).toBe(400);
    expect((await admin.post('/api/admin/platforms/nope').send({ enabled: true })).status).toBe(404);
    expect((await admin.post('/api/admin/platforms/x').send({ enabled: 'yes' })).status).toBe(400);
  });

  it('is admin-only', async () => {
    const other = await signupAndLogin('not-admin-plat@example.com');
    expect((await other.get('/api/admin/platforms')).status).toBe(404);
    expect((await other.post('/api/admin/platforms/x').send({ enabled: true })).status).toBe(404);
    expect((await other.get('/admin/platforms')).status).toBe(404);
  });
});

describe('admin rights', () => {
  it('makes a customer an admin and takes it away again, effective on their next request', async () => {
    const email = 'admin-roles@example.com';
    const admin = await signupAndLogin(email);
    await makeAdmin(email);
    const helper = await signupAndLogin('helper@example.com');
    const { rows } = await pool.query("SELECT id FROM users WHERE email = 'helper@example.com'");

    expect((await helper.get('/api/admin/users')).status).toBe(404);

    const made = await admin.post(`/api/admin/users/${rows[0].id}/admin`).send({ admin: true });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ email: 'helper@example.com', is_admin: true });
    expect((await helper.get('/api/admin/users')).status).toBe(200);

    const removed = await admin.post(`/api/admin/users/${rows[0].id}/admin`).send({ admin: false });
    expect(removed.body.is_admin).toBe(false);
    expect((await helper.get('/api/admin/users')).status).toBe(404);
  });

  it("won't let an admin remove their own rights, so there's always one left", async () => {
    const email = 'admin-self@example.com';
    const admin = await signupAndLogin(email);
    await makeAdmin(email);
    const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);

    const res = await admin.post(`/api/admin/users/${rows[0].id}/admin`).send({ admin: false });
    expect(res.status).toBe(409);
    const { rows: after } = await pool.query('SELECT is_admin FROM users WHERE id = $1', [rows[0].id]);
    expect(after[0].is_admin).toBe(true);
  });

  it('validates, 404s an unknown user, and is admin-only', async () => {
    const email = 'admin-roles-misc@example.com';
    const admin = await signupAndLogin(email);
    await makeAdmin(email);
    expect((await admin.post('/api/admin/users/999999/admin').send({ admin: true })).status).toBe(404);
    expect((await admin.post('/api/admin/users/1/admin').send({ admin: 'yes' })).status).toBe(400);

    const other = await signupAndLogin('not-admin-roles@example.com');
    const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', ['not-admin-roles@example.com']);
    expect((await other.post(`/api/admin/users/${rows[0].id}/admin`).send({ admin: true })).status).toBe(404);
    const { rows: after } = await pool.query('SELECT is_admin FROM users WHERE id = $1', [rows[0].id]);
    expect(after[0].is_admin).toBe(false);
  });
});

describe('first account on a fresh install', () => {
  // tests/setup.js switches this trigger off for every other test; each test starts with an
  // empty users table, which is exactly the fresh-install case.
  beforeAll(async () => {
    await pool.query('ALTER TABLE users ENABLE TRIGGER first_user_is_admin');
  });
  afterAll(async () => {
    await pool.query('ALTER TABLE users DISABLE TRIGGER first_user_is_admin');
  });

  it('becomes an admin on the top plan without Stripe; later signups do not', async () => {
    const owner = await signupAndLogin('owner@example.com');
    await signupAndLogin('second@example.com');

    const { rows } = await pool.query('SELECT email, is_admin, plan, plan_status FROM users ORDER BY id');
    expect(rows).toEqual([
      { email: 'owner@example.com', is_admin: true, plan: 'pro', plan_status: 'active' },
      { email: 'second@example.com', is_admin: false, plan: 'standard', plan_status: 'trialing' },
    ]);
    expect((await owner.get('/api/admin/users')).status).toBe(200);
  });
});

