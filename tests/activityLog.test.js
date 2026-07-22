import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { pool } from '../db/pool.js';
import { cleanupOldActivityLogs } from '../lib/activityLog.js';
import { processDuePosts } from '../scheduler.js';

async function signupAndLogin(email) {
  const client = request.agent(app);
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('auth event logging', () => {
  it('records a signup event', async () => {
    const email = 'activity-signup@example.com';
    await request(app).post('/api/users').send({ email, password: 'password123' });

    const { rows } = await pool.query('SELECT * FROM auth_events WHERE event_type = $1', ['signup']);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(email);
    expect(rows[0].user_id).not.toBeNull();
  });

  it('records login_success and login_failure separately', async () => {
    const email = 'activity-login@example.com';
    await request(app).post('/api/users').send({ email, password: 'password123' });

    await request(app).post('/api/auth/login').send({ email, password: 'wrongpassword' });
    await request(app).post('/api/auth/login').send({ email, password: 'password123' });

    const { rows: failures } = await pool.query('SELECT * FROM auth_events WHERE event_type = $1', [
      'login_failure',
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0].email).toBe(email);
    expect(failures[0].user_id).toBeNull();

    const { rows: successes } = await pool.query('SELECT * FROM auth_events WHERE event_type = $1', [
      'login_success',
    ]);
    expect(successes).toHaveLength(1);
    expect(successes[0].user_id).not.toBeNull();
  });

  it('records a logout event for the logged-in user', async () => {
    const client = await signupAndLogin('activity-logout@example.com');
    await client.post('/api/auth/logout');

    const { rows } = await pool.query('SELECT * FROM auth_events WHERE event_type = $1', ['logout']);
    expect(rows).toHaveLength(1);
  });

  it('does not record a logout event when nobody was logged in', async () => {
    await request(app).post('/api/auth/logout');
    const { rows } = await pool.query('SELECT * FROM auth_events WHERE event_type = $1', ['logout']);
    expect(rows).toHaveLength(0);
  });

  it('keeps the account_deleted audit row after the account is gone', async () => {
    const email = 'activity-delete@example.com';
    const client = await signupAndLogin(email);
    await client.post('/api/auth/delete-account').send({ password: 'password123' });

    const { rows } = await pool.query('SELECT * FROM auth_events WHERE event_type = $1', ['account_deleted']);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(email);
    // The user row is gone, so the FK's ON DELETE SET NULL should have fired.
    expect(rows[0].user_id).toBeNull();
  });

  it('records api token creation and revocation', async () => {
    const client = await signupAndLogin('activity-token@example.com');
    await client.post('/api/auth/api-token');
    await client.delete('/api/auth/api-token');

    const { rows } = await pool.query(
      "SELECT event_type FROM auth_events WHERE event_type IN ('api_token_created', 'api_token_revoked') ORDER BY id"
    );
    expect(rows.map((r) => r.event_type)).toEqual(['api_token_created', 'api_token_revoked']);
  });
});

describe('page visit logging', () => {
  it('records an anonymous visit to the landing page', async () => {
    await request(app).get('/');
    const { rows } = await pool.query('SELECT * FROM page_visits WHERE path = $1', ['/']);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
  });

  it('records an authenticated visit with the user attached', async () => {
    const client = await signupAndLogin('activity-visit@example.com');
    await client.get('/dashboard');

    const { rows } = await pool.query('SELECT * FROM page_visits WHERE path = $1', ['/dashboard']);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).not.toBeNull();
  });
});

describe('product event logging', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records social_account_connected only for a genuinely new mastodon account, not a reconnect', async () => {
    const client = await signupAndLogin('activity-mastodon@example.com');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const u = String(url);
        if (u.endsWith('/api/v1/apps')) return jsonResponse({ client_id: 'c1', client_secret: 's1' });
        if (u.endsWith('/oauth/token')) return jsonResponse({ access_token: 'tok' });
        if (u.endsWith('/api/v1/accounts/verify_credentials')) {
          return jsonResponse({ id: 'acct-1', username: 'tester', avatar: null });
        }
        throw new Error(`Unexpected fetch: ${u}`);
      })
    );

    const connectOnce = async () => {
      const connectRes = await client.get('/api/mastodon/connect?instance=example.social');
      const state = new URL(connectRes.headers.location).searchParams.get('state');
      await client.get(`/api/mastodon/callback?code=fake-code&state=${state}`);
    };
    await connectOnce();
    await connectOnce();

    const { rows } = await pool.query("SELECT * FROM product_events WHERE event_name = 'social_account_connected'");
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.platform).toBe('mastodon');
  });

  it('records social_account_disconnected', async () => {
    const client = await signupAndLogin('activity-disconnect@example.com');
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });

    await client.delete(`/api/v1/social-accounts/${account.body.id}`);

    const { rows } = await pool.query(
      "SELECT * FROM product_events WHERE event_name = 'social_account_disconnected'"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.platform).toBe('twitter');
  });

  it('records post_created, post_scheduled, and post_deleted', async () => {
    const client = await signupAndLogin('activity-posts@example.com');
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });

    const post = await client
      .post('/api/v1/posts')
      .send({ social_account_id: account.body.id, content: 'a draft post' });

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await client.patch(`/api/v1/posts/${post.body.id}`).send({ status: 'scheduled', scheduled_for: future });

    await client.delete(`/api/v1/posts/${post.body.id}`);

    const { rows } = await pool.query(
      "SELECT event_name FROM product_events WHERE event_name IN ('post_created', 'post_scheduled', 'post_deleted') ORDER BY id"
    );
    expect(rows.map((r) => r.event_name)).toEqual(['post_created', 'post_scheduled', 'post_deleted']);
  });

  it('records post_published and post_failed from the scheduler', async () => {
    const userRes = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ('activity-scheduler@example.com', 'x') RETURNING id"
    );
    const userId = userRes.rows[0].id;
    const accountRes = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name) VALUES ($1, 'twitter', '@stub') RETURNING id`,
      [userId]
    );
    await pool.query(
      `INSERT INTO posts (user_id, social_account_id, content, status, scheduled_for)
       VALUES ($1, $2, 'a stub post', 'scheduled', now() - interval '1 minute')`,
      [userId, accountRes.rows[0].id]
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT event_name FROM product_events WHERE user_id = $1', [userId]);
    expect(rows.map((r) => r.event_name)).toEqual(['post_published']);
  });
});

describe('cleanupOldActivityLogs', () => {
  it('prunes rows past the retention window and leaves recent ones', async () => {
    await pool.query(
      `INSERT INTO page_visits (path, created_at) VALUES ('/old', now() - interval '200 days'), ('/new', now())`
    );
    await pool.query(
      `INSERT INTO auth_events (event_type, email, created_at)
       VALUES ('login_success', 'old@example.com', now() - interval '200 days'),
              ('login_success', 'new@example.com', now())`
    );
    await pool.query(
      `INSERT INTO product_events (event_name, created_at)
       VALUES ('post_created', now() - interval '400 days'),
              ('post_created', now())`
    );

    const result = await cleanupOldActivityLogs();
    expect(result.visitsRemoved).toBe(1);
    expect(result.eventsRemoved).toBe(1);
    expect(result.productEventsRemoved).toBe(1);

    const { rows: visits } = await pool.query('SELECT path FROM page_visits');
    expect(visits.map((r) => r.path)).toEqual(['/new']);

    const { rows: events } = await pool.query('SELECT email FROM auth_events');
    expect(events.map((r) => r.email)).toEqual(['new@example.com']);

    const { rows: productEvents } = await pool.query('SELECT created_at FROM product_events');
    expect(productEvents).toHaveLength(1);
  });
});
