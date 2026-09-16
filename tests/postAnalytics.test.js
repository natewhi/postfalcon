import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { pool } from '../db/pool.js';

async function loginNewUser() {
  const client = request.agent(app);
  const email = `analytics${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  return { client, userId: rows[0].id };
}

async function createAccount(userId, platform = 'mastodon') {
  const res = await pool.query(
    `INSERT INTO social_accounts (user_id, platform, display_name) VALUES ($1, $2, '@me') RETURNING id`,
    [userId, platform]
  );
  return res.rows[0].id;
}

async function createPostedPost(userId, accountId, { content = 'x', postedAt, metrics = {} } = {}) {
  const res = await pool.query(
    `INSERT INTO posts
       (user_id, social_account_id, content, status, posted_at, metric_views, metric_likes, metric_comments, metric_shares, metrics_updated_at)
     VALUES ($1, $2, $3, 'posted', $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      userId,
      accountId,
      content,
      postedAt || new Date(),
      metrics.views ?? null,
      metrics.likes ?? null,
      metrics.comments ?? null,
      metrics.shares ?? null,
      Object.keys(metrics).length ? new Date() : null,
    ]
  );
  return res.rows[0].id;
}

describe('post analytics API', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/analytics/summary');
    expect(res.status).toBe(401);
  });

  it('returns a 7-day chart of zeros and no top post when nothing has been posted', async () => {
    const { client } = await loginNewUser();
    const res = await client.get('/api/v1/analytics/summary');
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(7);
    expect(res.body.days.every((d) => d.views === 0)).toBe(true);
    expect(res.body.totals).toEqual({ views: 0, likes: 0, comments: 0, shares: 0 });
    expect(res.body.postsPosted).toBe(0);
    expect(res.body.postsWithMetrics).toBe(0);
    expect(res.body.topPost).toBeNull();
  });

  it('aggregates totals and today\'s bucket, and picks the top post by views', async () => {
    const { client, userId } = await loginNewUser();
    const accountId = await createAccount(userId, 'youtube');

    await createPostedPost(userId, accountId, {
      content: 'the big one',
      postedAt: new Date(),
      metrics: { views: 500, likes: 40, comments: 5, shares: 0 },
    });
    await createPostedPost(userId, accountId, {
      content: 'a smaller one',
      postedAt: new Date(),
      metrics: { views: 100, likes: 10, comments: 1, shares: 0 },
    });
    // Not posted yet — must not count toward totals or postsPosted.
    await pool.query(
      `INSERT INTO posts (user_id, social_account_id, content, status) VALUES ($1, $2, 'draft one', 'draft')`,
      [userId, accountId]
    );

    const res = await client.get('/api/v1/analytics/summary');
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ views: 600, likes: 50, comments: 6, shares: 0 });
    expect(res.body.postsPosted).toBe(2);
    expect(res.body.postsWithMetrics).toBe(2);

    const todayBucket = res.body.days[res.body.days.length - 1];
    expect(todayBucket.views).toBe(600);

    expect(res.body.topPost).toBeTruthy();
    expect(res.body.topPost.content).toBe('the big one');
    expect(res.body.topPost.metric_views).toBe(500);
    expect(res.body.topPost.platform).toBe('youtube');
  });

  it('only aggregates the requesting user\'s own posts', async () => {
    const { client: clientA, userId: userA } = await loginNewUser();
    const { userId: userB } = await loginNewUser();
    const accountB = await createAccount(userB);
    await createPostedPost(userB, accountB, { metrics: { views: 999, likes: 1, comments: 1, shares: 1 } });

    const res = await clientA.get('/api/v1/analytics/summary');
    expect(res.body.totals.views).toBe(0);
    expect(res.body.topPost).toBeNull();
    expect(userA).not.toBe(userB);
  });

  it('excludes posts older than 7 days from the day-by-day chart but still counts them in totals', async () => {
    const { client, userId } = await loginNewUser();
    const accountId = await createAccount(userId);
    await createPostedPost(userId, accountId, {
      postedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      metrics: { views: 50, likes: 5, comments: 0, shares: 0 },
    });

    const res = await client.get('/api/v1/analytics/summary');
    expect(res.body.totals.views).toBe(50);
    expect(res.body.days.every((d) => d.views === 0)).toBe(true);
  });
});
