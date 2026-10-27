import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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


describe('admin sign-ups and invites', () => {
  it('changes who can sign up', async () => {
    const email = 'admin-signups@example.com';
    const admin = await signupAndLogin(email);
    await makeAdmin(email);

    expect((await admin.get('/api/admin/signups')).body).toEqual({ mode: 'open', invites: [] });
    expect((await admin.post('/api/admin/signups').send({ mode: 'closed' })).body).toEqual({ mode: 'closed' });
    expect((await admin.get('/api/admin/signups')).body.mode).toBe('closed');
    expect((await admin.post('/api/admin/signups').send({ mode: 'whoever' })).status).toBe(400);

    const res = await request(app).post('/api/users').send({ email: 'nope@example.com', password: 'password123' });
    expect(res.status).toBe(403);
  });

  it('creates an invite link that signs one person up, lists it, and can revoke unused ones', async () => {
    const email = 'admin-invites@example.com';
    const admin = await signupAndLogin(email);
    await makeAdmin(email);
    await admin.post('/api/admin/signups').send({ mode: 'invite' });

    const created = await admin.post('/api/admin/invites').send({ note: 'for Robin' });
    expect(created.status).toBe(201);
    expect(created.body.url.startsWith(`${process.env.BASE_URL}/signup?invite=`)).toBe(true);
    const token = new URL(created.body.url).searchParams.get('invite');

    const signup = await request(app).post('/api/users').send({ email: 'robin@example.com', password: 'password123', invite: token });
    expect(signup.status).toBe(201);

    const spare = await admin.post('/api/admin/invites').send({});
    const { body } = await admin.get('/api/admin/signups');
    expect(body.invites).toHaveLength(2);
    const used = body.invites.find((i) => i.id === created.body.id);
    expect(used).toMatchObject({ note: 'for Robin', used_by_email: 'robin@example.com' });
    // The stored invite never exposes the link again.
    expect(JSON.stringify(body)).not.toContain(token);

    expect((await admin.delete(`/api/admin/invites/${created.body.id}`)).status).toBe(404); // used: kept as history
    expect((await admin.delete(`/api/admin/invites/${spare.body.id}`)).status).toBe(204);
    expect((await admin.get('/api/admin/signups')).body.invites).toHaveLength(1);
  });

  it('is admin-only', async () => {
    const other = await signupAndLogin('not-admin-signups@example.com');
    expect((await other.get('/api/admin/signups')).status).toBe(404);
    expect((await other.post('/api/admin/signups').send({ mode: 'open' })).status).toBe(404);
    expect((await other.post('/api/admin/invites').send({})).status).toBe(404);
  });
});

describe('admin instance settings', () => {
  async function adminClient(email) {
    const client = await signupAndLogin(email);
    await makeAdmin(email);
    return client;
  }

  it('renames the site everywhere it is shown, and resets to the default', async () => {
    const admin = await adminClient('admin-name@example.com');
    const saved = await admin.post('/api/admin/settings').send({ site_name: 'Acme Social' });
    expect(saved.status).toBe(200);
    expect(saved.body.siteName).toBe('Acme Social');

    const login = await request(app).get('/login');
    expect(login.text).toContain('<title>Log in - Acme Social</title>');
    expect(login.text).toContain('Log in to Acme Social');
    expect((await admin.get('/dashboard')).text).toContain('<span>Acme Social</span>');

    const reset = await admin.post('/api/admin/settings').send({ site_name: null });
    expect(reset.body.siteName).toBe('Postfalcon');
    expect((await request(app).get('/login')).text).toContain('Log in to Postfalcon');
  });

  it('turns the public website off: / goes to log in, the blog 404s, the sitemap drops the marketing pages', async () => {
    const admin = await adminClient('admin-public@example.com');
    const off = await admin.post('/api/admin/settings').send({ public_site: 'off' });
    expect(off.body).toMatchObject({ publicSite: false, publicSiteSaved: true });

    const home = await request(app).get('/');
    expect(home.status).toBe(302);
    expect(home.headers.location).toBe('/login');
    expect((await request(app).get('/blog')).status).toBe(404);
    const sitemap = await request(app).get('/sitemap.xml');
    expect(sitemap.text).not.toContain('/pricing</loc>');
    expect(sitemap.text).toContain('/api-docs</loc>');

    await admin.post('/api/admin/settings').send({ public_site: 'on' });
    expect((await request(app).get('/')).status).toBe(200);
  });

  it("dates the landing page's calendar and composer mock-ups from today", async () => {
    const home = await request(app).get('/');
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    expect(home.text).toContain(`<div class="fcm-title">${now.toLocaleString('en-US', { month: 'long', year: 'numeric' })}</div>`);
    expect(home.text).toContain(tomorrow.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
    expect(home.text).toContain('curl -fsSL https://postfalcon.co/install.sh | sh');
  });

  it('defaults the public website to off on a self-hosted server and on with Stripe', async () => {
    const admin = await adminClient('admin-public-default@example.com');
    const res = await admin.post('/api/admin/settings').send({ public_site: 'default' });
    expect(res.body).toMatchObject({ selfHosted: true, publicSite: false, publicSiteDefault: false, publicSiteSaved: false });
    expect((await request(app).get('/')).headers.location).toBe('/login');

    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    try {
      expect((await request(app).get('/')).status).toBe(200);
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
    }
  });

  it('validates and is admin-only', async () => {
    const admin = await adminClient('admin-settings-misc@example.com');
    expect((await admin.post('/api/admin/settings').send({})).status).toBe(400);
    expect((await admin.post('/api/admin/settings').send({ public_site: 'maybe' })).status).toBe(400);
    expect((await admin.post('/api/admin/settings').send({ site_name: 'x'.repeat(41) })).status).toBe(400);
    expect((await admin.get('/admin/settings')).status).toBe(200);

    const other = await signupAndLogin('not-admin-settings@example.com');
    expect((await other.get('/api/admin/settings')).status).toBe(404);
    expect((await other.post('/api/admin/settings').send({ site_name: 'Mine' })).status).toBe(404);
    expect((await other.get('/admin/settings')).status).toBe(404);
  });
});

describe('platform setup on a new server', () => {
  it('lists how to set each platform up, with absolute callback URLs and which keys are set', async () => {
    const email = 'admin-setup@example.com';
    const admin = await signupAndLogin(email);
    await makeAdmin(email);
    const { body } = await admin.get('/api/admin/platforms');
    const byId = Object.fromEntries(body.map((p) => [p.id, p]));

    expect(byId.pinterest.setup).toMatchObject({
      console: 'https://developers.pinterest.com/apps/',
      callbackUrls: [`${process.env.BASE_URL}/api/pinterest/callback`],
      env: [
        { name: 'PINTEREST_APP_ID', set: true },
        { name: 'PINTEREST_APP_SECRET', set: true },
      ],
    });
    expect(byId.youtube.setup.callbackUrls).toContain(`${process.env.BASE_URL}/api/auth/google/callback`);
    expect(byId.bluesky.setup).toMatchObject({ console: null, callbackUrls: [], env: [] });
    // Names and set/unset only, never a key's value.
    expect(JSON.stringify(byId.pinterest.setup)).not.toContain(process.env.PINTEREST_APP_SECRET);
  });

  it("doesn't offer a switched-on platform until its app keys are set", async () => {
    const { livePlatforms, connectablePlatforms } = await import('../lib/platforms.js');
    const saved = process.env.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_ID = 'change-me';
    try {
      expect(livePlatforms().map((p) => p.id)).not.toContain('youtube');
      expect(connectablePlatforms().map((p) => p.id)).not.toContain('youtube');
      // Platforms that need no keys are always offered.
      expect(livePlatforms().map((p) => p.id)).toEqual(expect.arrayContaining(['mastodon', 'bluesky', 'telegram']));
    } finally {
      process.env.GOOGLE_CLIENT_ID = saved;
    }
    expect(livePlatforms().map((p) => p.id)).toContain('youtube');
  });
});

describe('admin account actions', () => {
  // An admin, plus a customer (logged in, with a session of their own) to act on.
  async function adminAndCustomer(tag) {
    const adminEmail = `admin-${tag}@example.com`;
    const admin = await signupAndLogin(adminEmail);
    await makeAdmin(adminEmail);
    const customerEmail = `cust-${tag}@example.com`;
    const customer = await signupAndLogin(customerEmail);
    const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [customerEmail]);
    return { admin, customer, customerEmail, customerId: Number(rows[0].id) };
  }

  it('makes a one-time password reset link that works for the customer', async () => {
    const { admin, customerEmail, customerId } = await adminAndCustomer('reset');
    const res = await admin.post(`/api/admin/users/${customerId}/password-reset-link`);
    expect(res.status).toBe(201);
    expect(res.body.url.startsWith(`${process.env.BASE_URL}/reset-password?token=`)).toBe(true);
    const token = new URL(res.body.url).searchParams.get('token');

    const reset = await request(app).post('/api/auth/reset-password').send({ token, password: 'brand-new-pass' });
    expect(reset.status).toBeLessThan(300);
    const login = await request(app).post('/api/auth/login').send({ email: customerEmail, password: 'brand-new-pass' });
    expect(login.status).toBe(200);
    // Single use.
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: 'another-pass' })).status).toBe(400);
  });

  it('resends the verification email, or marks the email verified', async () => {
    const { sendMail } = await import('../lib/mailer.js');
    const { admin, customerEmail, customerId } = await adminAndCustomer('verify');
    sendMail.mockClear();

    const resend = await admin.post(`/api/admin/users/${customerId}/verification-email`);
    expect(resend.status).toBe(200);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: customerEmail }));

    const marked = await admin.post(`/api/admin/users/${customerId}/verify-email`);
    expect(marked.body.email_verified_at).toBeTruthy();
    expect((await admin.post(`/api/admin/users/${customerId}/verification-email`)).status).toBe(409);
  });

  it('suspends an account: no sign-in, no session, no API token, no publishing; unsuspend restores it', async () => {
    const { admin, customer, customerEmail, customerId } = await adminAndCustomer('suspend');
    const { body: tokenBody } = await customer.post('/api/auth/api-token');
    const bearer = { Authorization: `Bearer ${tokenBody.token}` };
    const { rows: acc } = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, metadata)
       VALUES ($1, 'mastodon', '@s@example.social', 'ext-s', 'tok', '{"instance":"example.social"}') RETURNING id`,
      [customerId]
    );
    const { rows: post } = await pool.query(
      `INSERT INTO posts (user_id, social_account_id, content, status, scheduled_for)
       VALUES ($1, $2, 'queued', 'scheduled', now() - interval '1 minute') RETURNING id`,
      [customerId, acc[0].id]
    );

    const res = await admin.post(`/api/admin/users/${customerId}/suspend`).send({ suspended: true });
    expect(res.body.suspended_at).toBeTruthy();

    expect((await customer.get('/api/auth/me')).status).toBe(401);
    const login = await request(app).post('/api/auth/login').send({ email: customerEmail, password: 'password123' });
    expect(login.status).toBe(401);
    expect(login.body.error).toMatch(/suspended/);
    expect((await request(app).get('/api/v1/posts').set(bearer)).status).toBe(401);

    const { processDuePosts } = await import('../scheduler.js');
    await processDuePosts();
    const { rows: after } = await pool.query('SELECT status, error_message FROM posts WHERE id = $1', [post[0].id]);
    expect(after[0]).toMatchObject({ status: 'failed' });
    expect(after[0].error_message).toMatch(/suspended/);

    await admin.post(`/api/admin/users/${customerId}/suspend`).send({ suspended: false });
    expect((await request(app).get('/api/v1/posts').set(bearer)).status).toBe(200);
    const again = await request(app).post('/api/auth/login').send({ email: customerEmail, password: 'password123' });
    expect(again.status).toBe(200);
  });

  it('deletes an account and everything in it', async () => {
    const { admin, customer, customerId } = await adminAndCustomer('delete');
    const res = await admin.delete(`/api/admin/users/${customerId}`);
    expect(res.status).toBe(204);
    const { rows } = await pool.query('SELECT 1 FROM users WHERE id = $1', [customerId]);
    expect(rows).toHaveLength(0);
    expect((await customer.get('/api/auth/me')).status).toBe(401);
    expect((await admin.delete(`/api/admin/users/${customerId}`)).status).toBe(404);
  });

  it("won't suspend or delete yourself or another admin", async () => {
    const { admin, customerId } = await adminAndCustomer('guard');
    const { rows: me } = await pool.query("SELECT id FROM users WHERE email = 'admin-guard@example.com'");
    expect((await admin.post(`/api/admin/users/${me[0].id}/suspend`).send({ suspended: true })).status).toBe(409);
    expect((await admin.delete(`/api/admin/users/${me[0].id}`)).status).toBe(409);

    await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [customerId]);
    const res = await admin.post(`/api/admin/users/${customerId}/suspend`).send({ suspended: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('is_admin');
    expect((await admin.delete(`/api/admin/users/${customerId}`)).status).toBe(409);
  });

  it("revokes a customer's API token and shows it in their details", async () => {
    const { admin, customer, customerId } = await adminAndCustomer('token');
    const { body } = await customer.post('/api/auth/api-token');
    expect((await admin.get(`/api/admin/users/${customerId}`)).body.apiToken).toMatchObject({ last_used_at: null });

    expect((await admin.delete(`/api/admin/users/${customerId}/api-token`)).status).toBe(204);
    expect((await request(app).get('/api/v1/posts').set({ Authorization: `Bearer ${body.token}` })).status).toBe(401);
    expect((await admin.get(`/api/admin/users/${customerId}`)).body.apiToken).toBeNull();
    expect((await admin.delete(`/api/admin/users/${customerId}/api-token`)).status).toBe(404);
  });

  it('is admin-only', async () => {
    const { customer, customerId } = await adminAndCustomer('only');
    expect((await customer.post(`/api/admin/users/${customerId}/password-reset-link`)).status).toBe(404);
    expect((await customer.post(`/api/admin/users/${customerId}/suspend`).send({ suspended: true })).status).toBe(404);
    expect((await customer.delete(`/api/admin/users/${customerId}`)).status).toBe(404);
    expect((await customer.post('/api/admin/email/test').send({})).status).toBe(404);
    expect((await customer.get('/api/admin/backups')).status).toBe(404);
  });
});

describe('admin email test', () => {
  it("sends to the admin by default and reports the server's answer, or why it failed", async () => {
    const { sendTestMail } = await import('../lib/mailer.js');
    const email = 'admin-mailtest@example.com';
    const admin = await signupAndLogin(email);
    await makeAdmin(email);

    const ok = await admin.post('/api/admin/email/test').send({});
    expect(ok.body).toMatchObject({ ok: true, to: email, response: '250 OK (mocked)' });
    expect((await admin.post('/api/admin/email/test').send({ to: 'other@example.com' })).body.to).toBe('other@example.com');

    sendTestMail.mockRejectedValueOnce(new Error('550 domain not verified'));
    const failed = await admin.post('/api/admin/email/test').send({});
    expect(failed.status).toBe(502);
    expect(failed.body.message).toBe('550 domain not verified');
    expect((await admin.post('/api/admin/email/test').send({ to: 'not-an-email' })).status).toBe(400);
  });
});

describe('admin backups', () => {
  it('lists, downloads and deletes backups, but nothing outside the backup folder', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-backups-'));
    process.env.BACKUP_DIR = dir;
    try {
      const email = 'admin-backups@example.com';
      const admin = await signupAndLogin(email);
      await makeAdmin(email);
      await fs.writeFile(path.join(dir, 'postfalcon-2026-01-01.dump'), 'dump-bytes');
      await fs.writeFile(path.join(dir, 'secret.txt'), 'not a backup');

      const list = await admin.get('/api/admin/backups');
      expect(list.body.backups.map((b) => b.name)).toEqual(['postfalcon-2026-01-01.dump']);
      expect(list.body.dir).toBe(dir);

      const download = await admin
        .get('/api/admin/backups/postfalcon-2026-01-01.dump')
        .buffer(true)
        .parse((res, done) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => done(null, data));
        });
      expect(download.status).toBe(200);
      expect(download.headers['content-disposition']).toContain('postfalcon-2026-01-01.dump');
      expect(download.body).toBe('dump-bytes');

      expect((await admin.get('/api/admin/backups/secret.txt')).status).toBe(404);
      expect((await admin.get('/api/admin/backups/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);

      // Delete: only listed backups, and the file is really gone.
      expect((await admin.delete('/api/admin/backups/secret.txt')).status).toBe(404);
      expect((await admin.delete('/api/admin/backups/..%2Fsecret.txt')).status).toBe(404);
      const deleted = await admin.delete('/api/admin/backups/postfalcon-2026-01-01.dump');
      expect(deleted.status).toBe(200);
      expect(deleted.body).toEqual({ name: 'postfalcon-2026-01-01.dump', bucketDeleted: false });
      expect((await admin.get('/api/admin/backups')).body.backups).toEqual([]);
      expect(await fs.readFile(path.join(dir, 'secret.txt'), 'utf8')).toBe('not a backup');

      const other = await signupAndLogin('not-admin-backup-delete@example.com');
      expect((await other.delete('/api/admin/backups/anything.dump')).status).toBe(404);
    } finally {
      delete process.env.BACKUP_DIR;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('server error log', () => {
  it('reads the message, error and request out of each way pino gets called', async () => {
    const { errorFromLogCall } = await import('../lib/errorLog.js');
    const err = new Error('boom');
    expect(errorFromLogCall(['plain message'], null)).toMatchObject({ message: 'plain message', err: null });
    expect(errorFromLogCall([{ err }, 'unhandled error'], { req: { method: 'POST', url: '/api/v1/posts' } })).toMatchObject({
      message: 'unhandled error',
      err,
      method: 'POST',
      url: '/api/v1/posts',
    });
    expect(errorFromLogCall([err], null)).toMatchObject({ message: 'boom', err, method: null });
  });

  it('keeps errors for Activity, newest first, admin-only', async () => {
    const { recordServerError } = await import('../lib/errorLog.js');
    await recordServerError({ message: 'database backup failed', err: new Error('pg_dump exited with 1') });
    await recordServerError({ message: 'unhandled error', err: new TypeError('x is undefined'), method: 'GET', url: '/dashboard' });

    const email = 'admin-errors@example.com';
    const admin = await signupAndLogin(email);
    await makeAdmin(email);
    const res = await admin.get('/api/admin/errors');
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ message: 'unhandled error', error_type: 'TypeError', method: 'GET', url: '/dashboard' });
    expect(res.body[0].stack).toContain('x is undefined');
    expect(res.body[1]).toMatchObject({ message: 'database backup failed', error_message: 'pg_dump exited with 1', method: null });

    const other = await signupAndLogin('not-admin-errors@example.com');
    expect((await other.get('/api/admin/errors')).status).toBe(404);
  });
});

describe('admin alerts', () => {
  let backupDir;
  // A backup folder holding one fresh backup, so the backup check stays quiet unless a test
  // wants it to fire.
  beforeAll(async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-alert-backups-'));
    await fs.writeFile(path.join(backupDir, 'postfalcon-fresh.dump'), 'x');
    process.env.BACKUP_DIR = backupDir;
  });
  afterAll(async () => {
    const fs = await import('node:fs/promises');
    delete process.env.BACKUP_DIR;
    await fs.rm(backupDir, { recursive: true, force: true });
  });

  async function adminWithAccount(email) {
    const admin = await signupAndLogin(email);
    await makeAdmin(email);
    const { rows: user } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    const { rows: acc } = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, metadata)
       VALUES ($1, 'mastodon', '@a@example.social', 'ext-alert', 'tok', '{"instance":"example.social"}') RETURNING id`,
      [user[0].id]
    );
    return { admin, userId: user[0].id, accountId: acc[0].id };
  }

  async function overduePost(userId, accountId) {
    const { rows } = await pool.query(
      `INSERT INTO posts (user_id, social_account_id, content, status, scheduled_for)
       VALUES ($1, $2, 'late', 'scheduled', now() - interval '30 minutes') RETURNING id`,
      [userId, accountId]
    );
    return rows[0].id;
  }

  it('emails admins once when a problem starts, stays quiet while it lasts, and reports when it clears', async () => {
    const { sendMail } = await import('../lib/mailer.js');
    const { checkAlerts } = await import('../lib/alerts.js');
    const { userId, accountId } = await adminWithAccount('admin-alerts@example.com');
    sendMail.mockClear();

    expect(await checkAlerts()).toMatchObject({ raised: [], resolved: [], emailedTo: [] });
    expect(sendMail).not.toHaveBeenCalled();

    const postId = await overduePost(userId, accountId);
    const first = await checkAlerts();
    expect(first).toMatchObject({ raised: ['overdue_posts'], emailedTo: ['admin-alerts@example.com'] });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({ to: 'admin-alerts@example.com' });
    expect(sendMail.mock.calls[0][0].subject).toContain('1 scheduled post is overdue');

    expect(await checkAlerts()).toMatchObject({ raised: [], reminded: [], resolved: [] });
    expect(sendMail).toHaveBeenCalledTimes(1);

    await pool.query('DELETE FROM posts WHERE id = $1', [postId]);
    const cleared = await checkAlerts();
    expect(cleared.resolved).toEqual(['overdue_posts']);
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(sendMail.mock.calls[1][0].subject).toContain('Resolved');
  });

  it('reminds every 24 hours while a problem lasts', async () => {
    const { sendMail } = await import('../lib/mailer.js');
    const { checkAlerts } = await import('../lib/alerts.js');
    const { userId, accountId } = await adminWithAccount('admin-remind@example.com');
    await overduePost(userId, accountId);
    await checkAlerts();
    await pool.query("UPDATE admin_alerts SET notified_at = now() - interval '25 hours' WHERE key = 'overdue_posts'");
    sendMail.mockClear();

    expect((await checkAlerts()).reminded).toEqual(['overdue_posts']);
    expect(sendMail.mock.calls[0][0].text).toContain('Still going on');
  });

  it('spots a burst of failures on one platform, a spike in server errors, and stopped backups', async () => {
    const { checkAlerts } = await import('../lib/alerts.js');
    const { recordServerError } = await import('../lib/errorLog.js');
    const fs = await import('node:fs/promises');
    const { userId, accountId } = await adminWithAccount('admin-bursts@example.com');
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO posts (user_id, social_account_id, content, status, scheduled_for, error_message)
         VALUES ($1, $2, 'x', 'failed', now() - interval '5 minutes', 'Mastodon said no')`,
        [userId, accountId]
      );
    }
    for (let i = 0; i < 20; i++) await recordServerError({ message: `error ${i}` });
    await fs.rm(backupDir, { recursive: true, force: true });
    await fs.mkdir(backupDir);
    await pool.query("UPDATE users SET created_at = now() - interval '3 days'");

    const { raised } = await checkAlerts();
    expect(raised).toEqual(expect.arrayContaining(['failures_mastodon', 'server_errors', 'backups_stale']));
    await fs.writeFile((await import('node:path')).join(backupDir, 'postfalcon-fresh.dump'), 'x');
  });

  it('records problems but sends nothing when alert emails are switched off', async () => {
    const { sendMail } = await import('../lib/mailer.js');
    const { checkAlerts } = await import('../lib/alerts.js');
    const { admin, userId, accountId } = await adminWithAccount('admin-quiet@example.com');
    await admin.post('/api/admin/settings').send({ alert_emails: 'off' });
    await overduePost(userId, accountId);
    sendMail.mockClear();

    const result = await checkAlerts();
    expect(result).toMatchObject({ raised: ['overdue_posts'], emailedTo: [] });
    expect(sendMail).not.toHaveBeenCalled();
    const { body } = await admin.get('/api/admin/alerts');
    expect(body.emailsOn).toBe(false);
    expect(body.alerts.map((a) => a.key)).toEqual(['overdue_posts']);
  });

  it('lets an admin run the check from Overview, and nobody else', async () => {
    const { admin, userId, accountId } = await adminWithAccount('admin-checknow@example.com');
    await overduePost(userId, accountId);
    const res = await admin.post('/api/admin/alerts/check');
    expect(res.status).toBe(200);
    expect(res.body.alerts.map((a) => a.key)).toEqual(['overdue_posts']);

    const other = await signupAndLogin('not-admin-alerts@example.com');
    expect((await other.post('/api/admin/alerts/check')).status).toBe(404);
    expect((await other.get('/api/admin/alerts')).status).toBe(404);
  });
});

describe('admin version', () => {
  afterEach(async () => {
    const { clearUpdateCache } = await import('../lib/version.js');
    clearUpdateCache();
    delete process.env.APP_COMMIT;
    delete process.env.UPDATE_CHECK;
    vi.unstubAllGlobals();
  });

  async function adminClient(email) {
    const client = await signupAndLogin(email);
    await makeAdmin(email);
    return client;
  }

  it("reports how far behind the project's GitHub main this server is, and that migrations are applied", async () => {
    process.env.APP_COMMIT = 'a'.repeat(40);
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u === 'https://api.github.com/repos/natewhi/postfalcon/commits/main') {
        return { ok: true, status: 200, json: async () => ({ sha: 'b'.repeat(40), commit: { committer: { date: '2026-10-26T00:00:00Z' } } }) };
      }
      if (u === `https://api.github.com/repos/natewhi/postfalcon/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`) {
        return { ok: true, status: 200, json: async () => ({ ahead_by: 3 }) };
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const admin = await adminClient('admin-version@example.com');

    const res = await admin.get('/api/admin/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      commit: 'a'.repeat(40),
      pendingMigrations: [],
      upstream: { repo: 'natewhi/postfalcon', latestCommit: 'b'.repeat(40), behindBy: 3 },
    });
    // Cached: a second look doesn't ask GitHub again.
    await admin.get('/api/admin/version');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says up to date when running the latest commit, and copes with GitHub being unreachable or the check being off', async () => {
    process.env.APP_COMMIT = 'c'.repeat(40);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ sha: 'c'.repeat(40), commit: { committer: { date: null } } }) }))
    );
    const admin = await adminClient('admin-version2@example.com');
    expect((await admin.get('/api/admin/version')).body.upstream.behindBy).toBe(0);

    const { clearUpdateCache } = await import('../lib/version.js');
    clearUpdateCache();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    expect((await admin.get('/api/admin/version')).body.upstream.error).toMatch(/404/);

    clearUpdateCache();
    process.env.UPDATE_CHECK = 'false';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect((await admin.get('/api/admin/version')).body.upstream).toEqual({ disabled: true });
    expect(fetchSpy).not.toHaveBeenCalled();

    const other = await signupAndLogin('not-admin-version@example.com');
    expect((await other.get('/api/admin/version')).status).toBe(404);
  });
});

describe('admin failed posts across customers', () => {
  async function failedPost(userId, accountId, ago, status = 'failed') {
    const { rows } = await pool.query(
      `INSERT INTO posts (user_id, social_account_id, content, status, scheduled_for, error_message, updated_at)
       VALUES ($1, $2, 'x', $3, now() - $4::interval, 'it broke', now() - $4::interval) RETURNING id`,
      [userId, accountId, status, ago]
    );
    return Number(rows[0].id);
  }

  async function customerWith(platform, email) {
    await signupAndLogin(email);
    const { rows: user } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    const { rows: acc } = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, metadata)
       VALUES ($1, $2, 'acct', $3, 'tok', '{"instance":"example.social"}') RETURNING id`,
      [user[0].id, platform, `ext-${email}`]
    );
    return { userId: user[0].id, accountId: acc[0].id };
  }

  it('lists failures from every customer by window and platform, and retries them in one go', async () => {
    const email = 'admin-failed@example.com';
    const admin = await signupAndLogin(email);
    await makeAdmin(email);
    const a = await customerWith('mastodon', 'fail-a@example.com');
    const b = await customerWith('bluesky', 'fail-b@example.com');
    const recentA = await failedPost(a.userId, a.accountId, '10 minutes');
    const recentB = await failedPost(b.userId, b.accountId, '20 minutes');
    const yesterdayA = await failedPost(a.userId, a.accountId, '30 hours');
    const tooOld = await failedPost(a.userId, a.accountId, '10 days');
    const notFailed = await failedPost(a.userId, a.accountId, '5 minutes', 'posted');

    const day = await admin.get('/api/admin/failed-posts');
    expect(day.body.map((p) => Number(p.id))).toEqual([recentA, recentB]);
    expect(day.body[0]).toMatchObject({ platform: 'mastodon', email: 'fail-a@example.com', error_message: 'it broke' });
    const week = await admin.get('/api/admin/failed-posts').query({ hours: '168' });
    expect(week.body.map((p) => Number(p.id))).toEqual([recentA, recentB, yesterdayA]);
    const bluesky = await admin.get('/api/admin/failed-posts').query({ platform: 'bluesky' });
    expect(bluesky.body.map((p) => Number(p.id))).toEqual([recentB]);
    expect((await admin.get('/api/admin/failed-posts').query({ hours: '5' })).status).toBe(400);

    const retry = await admin.post('/api/admin/failed-posts/retry').send({ ids: [recentA, recentB, tooOld, notFailed] });
    expect(retry.body.retried.sort()).toEqual([recentA, recentB].sort());
    const { rows } = await pool.query('SELECT id, status FROM posts WHERE id = ANY($1) ORDER BY id', [[recentA, recentB, tooOld, notFailed]]);
    expect(Object.fromEntries(rows.map((r) => [Number(r.id), r.status]))).toEqual({
      [recentA]: 'scheduled',
      [recentB]: 'scheduled',
      [tooOld]: 'failed',
      [notFailed]: 'posted',
    });
    expect((await admin.post('/api/admin/failed-posts/retry').send({ ids: [] })).status).toBe(400);
  });

  it('is admin-only', async () => {
    const other = await signupAndLogin('not-admin-failed@example.com');
    expect((await other.get('/api/admin/failed-posts')).status).toBe(404);
    expect((await other.post('/api/admin/failed-posts/retry').send({ ids: [1] })).status).toBe(404);
  });
});

describe('safeguards', () => {
  async function adminClient(email) {
    const client = await signupAndLogin(email);
    await makeAdmin(email);
    return client;
  }

  it('flags a server that sells plans but lost its Stripe key, on Overview and by alert email', async () => {
    const admin = await adminClient('admin-nokey@example.com');
    await signupAndLogin('payer@example.com');
    await pool.query("UPDATE users SET stripe_customer_id = 'cus_payer' WHERE email = 'payer@example.com'");

    const { body } = await admin.get('/api/admin/overview');
    const check = body.setup.checks.find((c) => c.title.startsWith('STRIPE_SECRET_KEY is missing'));
    expect(check?.level).toBe('error');
    expect(body.setup.checks.find((c) => c.title === 'Self-hosted mode: billing is off')).toBeUndefined();

    const { checkAlerts } = await import('../lib/alerts.js');
    expect((await checkAlerts()).raised).toContain('billing_key_missing');
  });

  it("won't make a password reset link for another admin or for yourself", async () => {
    const admin = await adminClient('admin-resetguard@example.com');
    await adminClient('other-admin@example.com');
    const { rows } = await pool.query(
      "SELECT id, email FROM users WHERE email IN ('admin-resetguard@example.com', 'other-admin@example.com')"
    );
    for (const row of rows) {
      expect((await admin.post(`/api/admin/users/${row.id}/password-reset-link`)).status).toBe(409);
    }
  });

  it('tells a customer when an admin deletes their account', async () => {
    const { sendMail } = await import('../lib/mailer.js');
    const admin = await adminClient('admin-notify@example.com');
    await signupAndLogin('goner@example.com');
    const { rows } = await pool.query("SELECT id FROM users WHERE email = 'goner@example.com'");
    sendMail.mockClear();

    expect((await admin.delete(`/api/admin/users/${rows[0].id}`)).status).toBe(204);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'goner@example.com', subject: 'Your Postfalcon account was deleted' }));
  });

  it("doesn't offer a platform with its id set but its secret missing", async () => {
    const { livePlatforms, platformCredentialsReady } = await import('../lib/platforms.js');
    const saved = process.env.PINTEREST_APP_SECRET;
    delete process.env.PINTEREST_APP_SECRET;
    try {
      expect(platformCredentialsReady('pinterest')).toBe(false);
      expect(livePlatforms().map((p) => p.id)).not.toContain('pinterest');
    } finally {
      process.env.PINTEREST_APP_SECRET = saved;
    }
    // FACEBOOK_CONFIG_ID is optional.
    const savedConfig = process.env.FACEBOOK_CONFIG_ID;
    delete process.env.FACEBOOK_CONFIG_ID;
    try {
      expect(platformCredentialsReady('facebook')).toBe(true);
    } finally {
      if (savedConfig !== undefined) process.env.FACEBOOK_CONFIG_ID = savedConfig;
    }
  });
});

describe('admin logo', () => {
  async function pngBytes(color) {
    const sharp = (await import('sharp')).default;
    return sharp({ create: { width: 400, height: 200, channels: 3, background: color } }).png().toBuffer();
  }

  it('uploads a logo shown in the header, sidebar and tab icon, replaces it, and removes it', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { uploadDir } = await import('../middleware/upload.js');
    const email = 'admin-logo@example.com';
    const admin = await signupAndLogin(email);
    await makeAdmin(email);

    const first = await admin.post('/api/admin/settings/logo').attach('logo', await pngBytes('#ff0000'), {
      filename: 'logo.png',
      contentType: 'image/png',
    });
    expect(first.status).toBe(200);
    expect(first.body.logoUrl).toMatch(/^\/uploads\/[0-9a-f-]{36}\.png$/);
    const firstFile = path.join(uploadDir, path.basename(first.body.logoUrl));
    const sharp = (await import('sharp')).default;
    expect(await sharp(firstFile).metadata()).toMatchObject({ width: 256, height: 256, format: 'png' });

    const login = await request(app).get('/login');
    expect(login.text).toContain(`<img class="site-brand-mark" src="${first.body.logoUrl}"`);
    expect(login.text).toContain(`<link rel="icon" href="${first.body.logoUrl}">`);
    expect((await admin.get('/dashboard')).text).toContain(`<img class="sidebar-brand-mark" src="${first.body.logoUrl}"`);

    const second = await admin.post('/api/admin/settings/logo').attach('logo', await pngBytes('#0000ff'), {
      filename: 'logo2.png',
      contentType: 'image/png',
    });
    expect(second.body.logoUrl).not.toBe(first.body.logoUrl);
    await expect(fs.access(firstFile)).rejects.toThrow();

    const removed = await admin.delete('/api/admin/settings/logo');
    expect(removed.body.logoUrl).toBeNull();
    await expect(fs.access(path.join(uploadDir, path.basename(second.body.logoUrl)))).rejects.toThrow();
    expect((await request(app).get('/login')).text).toContain('<link rel="icon" href="/favicon.svg">');
  });

  it('refuses SVGs, files that are not images, and anyone but an admin', async () => {
    const email = 'admin-logo-bad@example.com';
    const admin = await signupAndLogin(email);
    await makeAdmin(email);

    const svg = await admin
      .post('/api/admin/settings/logo')
      .attach('logo', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), {
        filename: 'logo.svg',
        contentType: 'image/svg+xml',
      });
    expect(svg.status).toBe(400);
    const fake = await admin
      .post('/api/admin/settings/logo')
      .attach('logo', Buffer.from('definitely not a png'), { filename: 'logo.png', contentType: 'image/png' });
    expect(fake.status).toBe(400);
    expect(fake.body.error).toBe('bad_image');
    expect((await admin.post('/api/admin/settings/logo')).status).toBe(400);
    expect((await admin.get('/api/admin/settings')).body.logoUrl).toBeNull();

    const other = await signupAndLogin('not-admin-logo@example.com');
    expect(
      (await other.post('/api/admin/settings/logo').attach('logo', await pngBytes('#00ff00'), { filename: 'x.png', contentType: 'image/png' })).status
    ).toBe(404);
  });
});
