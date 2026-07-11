import { describe, it, expect, vi, afterEach } from 'vitest';
import { pool } from '../db/pool.js';
import { processDuePosts } from '../scheduler.js';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function createUser(email) {
  const res = await pool.query("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
  return res.rows[0].id;
}

async function createMastodonAccount(userId, metadata = { instance: 'example.social' }) {
  const res = await pool.query(
    `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, metadata)
     VALUES ($1, 'mastodon', '@test@example.social', 'ext-1', 'token123', $2)
     RETURNING id`,
    [userId, JSON.stringify(metadata)]
  );
  return res.rows[0].id;
}

async function createScheduledPost(userId, accountId, content = 'hello from the scheduler') {
  const res = await pool.query(
    `INSERT INTO posts (user_id, social_account_id, content, status, scheduled_for)
     VALUES ($1, $2, $3, 'scheduled', now() - interval '1 minute')
     RETURNING id`,
    [userId, accountId, content]
  );
  return res.rows[0].id;
}

describe('scheduler', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts a due Mastodon post and records the platform post id', async () => {
    const userId = await createUser('scheduler1@example.com');
    const accountId = await createMastodonAccount(userId);
    const postId = await createScheduledPost(userId, accountId);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        expect(String(url)).toBe('https://example.social/api/v1/statuses');
        return jsonResponse({ id: 'remote-status-1' });
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('remote-status-1');
    expect(rows[0].posted_at).not.toBeNull();
  });

  it('marks a post failed when Mastodon rejects it', async () => {
    const userId = await createUser('scheduler2@example.com');
    const accountId = await createMastodonAccount(userId);
    const postId = await createScheduledPost(userId, accountId);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'Validation failed' }, 422))
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error_message).toMatch(/422/);
  });

  it('fails clearly when a mastodon account is missing instance metadata', async () => {
    const userId = await createUser('scheduler3@example.com');
    const accountId = await createMastodonAccount(userId, {});
    const postId = await createScheduledPost(userId, accountId);

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error_message).toMatch(/instance metadata/);
  });

  it('marks a stub (non-mastodon) post as posted without calling fetch', async () => {
    const userId = await createUser('scheduler4@example.com');
    const accountRes = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name) VALUES ($1, 'twitter', '@stub') RETURNING id`,
      [userId]
    );
    const postId = await createScheduledPost(userId, accountRes.rows[0].id);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await processDuePosts();

    expect(fetchMock).not.toHaveBeenCalled();
    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBeNull();
  });
});
