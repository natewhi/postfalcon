import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { pool } from '../db/pool.js';
import { uploadDir } from '../middleware/upload.js';
import { cleanupOldMedia } from '../lib/mediaCleanup.js';

async function createUser(email) {
  const res = await pool.query("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
  return res.rows[0].id;
}

async function createAccount(userId) {
  const res = await pool.query(
    `INSERT INTO social_accounts (user_id, platform, display_name) VALUES ($1, 'twitter', '@me') RETURNING id`,
    [userId]
  );
  return res.rows[0].id;
}

async function createPostWithMedia(userId, accountId, { status, postedAt = null, updatedAt }) {
  const res = await pool.query(
    `INSERT INTO posts (user_id, social_account_id, content, status, posted_at, updated_at)
     VALUES ($1, $2, 'test post', $3, $4, $5)
     RETURNING id`,
    [userId, accountId, status, postedAt, updatedAt]
  );
  const postId = res.rows[0].id;

  const filename = `test-${crypto.randomUUID()}.jpg`;
  await fs.writeFile(path.join(uploadDir, filename), 'fake-image-bytes');
  await pool.query(`INSERT INTO post_media (post_id, url, media_type, position) VALUES ($1, $2, 'image', 0)`, [
    postId,
    `${process.env.BASE_URL}/uploads/${filename}`,
  ]);

  return { postId, filename };
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function exists(filePath) {
  return fs.access(filePath).then(
    () => true,
    () => false
  );
}

describe('media cleanup', () => {
  it('removes media for a posted post older than the retention window, keeping the post', async () => {
    const userId = await createUser('cleanup1@example.com');
    const accountId = await createAccount(userId);
    const { postId, filename } = await createPostWithMedia(userId, accountId, {
      status: 'posted',
      postedAt: daysAgo(31),
      updatedAt: daysAgo(31),
    });
    const filePath = path.join(uploadDir, filename);
    expect(await exists(filePath)).toBe(true);

    const result = await cleanupOldMedia();
    expect(result.postsCleaned).toBe(1);
    expect(result.filesRemoved).toBe(1);
    expect(await exists(filePath)).toBe(false);

    const { rows: mediaRows } = await pool.query('SELECT * FROM post_media WHERE post_id = $1', [postId]);
    expect(mediaRows).toHaveLength(0);

    const { rows: postRows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(postRows).toHaveLength(1);
    expect(postRows[0].content).toBe('test post');
    expect(postRows[0].status).toBe('posted');
  });

  it('leaves media alone for a recently posted post', async () => {
    const userId = await createUser('cleanup2@example.com');
    const accountId = await createAccount(userId);
    const { filename } = await createPostWithMedia(userId, accountId, {
      status: 'posted',
      postedAt: daysAgo(10),
      updatedAt: daysAgo(10),
    });

    const result = await cleanupOldMedia();
    expect(result.postsCleaned).toBe(0);

    const filePath = path.join(uploadDir, filename);
    expect(await exists(filePath)).toBe(true);
    await fs.unlink(filePath).catch(() => {});
  });

  it('cleans up an old failed post using updated_at when posted_at is null', async () => {
    const userId = await createUser('cleanup3@example.com');
    const accountId = await createAccount(userId);
    const { postId, filename } = await createPostWithMedia(userId, accountId, {
      status: 'failed',
      postedAt: null,
      updatedAt: daysAgo(45),
    });

    const result = await cleanupOldMedia();
    expect(result.postsCleaned).toBe(1);

    expect(await exists(path.join(uploadDir, filename))).toBe(false);
    const { rows } = await pool.query('SELECT * FROM post_media WHERE post_id = $1', [postId]);
    expect(rows).toHaveLength(0);
  });

  it('never touches media for draft or scheduled posts, regardless of age', async () => {
    const userId = await createUser('cleanup4@example.com');
    const accountId = await createAccount(userId);
    const draft = await createPostWithMedia(userId, accountId, { status: 'draft', updatedAt: daysAgo(400) });
    const scheduled = await createPostWithMedia(userId, accountId, { status: 'scheduled', updatedAt: daysAgo(400) });

    const result = await cleanupOldMedia();
    expect(result.postsCleaned).toBe(0);

    for (const { filename } of [draft, scheduled]) {
      const filePath = path.join(uploadDir, filename);
      expect(await exists(filePath)).toBe(true);
      await fs.unlink(filePath).catch(() => {});
    }
  });
});
