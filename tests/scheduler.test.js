import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../db/pool.js';
import { processDuePosts } from '../scheduler.js';
import { uploadDir } from '../middleware/upload.js';

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

async function createPostMedia(postId, { url, mediaType = 'image', altText = null, position = 0 }) {
  await pool.query('INSERT INTO post_media (post_id, url, media_type, alt_text, position) VALUES ($1, $2, $3, $4, $5)', [
    postId,
    url,
    mediaType,
    altText,
    position,
  ]);
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

  it('uploads media and includes media_ids for a Mastodon post with an image', async () => {
    const userId = await createUser('scheduler-mastodon-media@example.com');
    const accountId = await createMastodonAccount(userId);

    const filename = `test-${crypto.randomUUID()}.jpg`;
    await fs.writeFile(path.join(uploadDir, filename), 'fake-image-bytes');

    const postId = await createScheduledPost(userId, accountId, 'photo toot');
    await createPostMedia(postId, {
      url: `${process.env.BASE_URL}/uploads/${filename}`,
      altText: 'a nice toot photo',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        const u = String(url);
        if (u === 'https://example.social/api/v2/media') {
          expect(options.body).toBeInstanceOf(FormData);
          return jsonResponse({ id: 'media-1' });
        }
        if (u === 'https://example.social/api/v1/statuses') {
          const body = JSON.parse(options.body);
          expect(body.media_ids).toEqual(['media-1']);
          return jsonResponse({ id: 'status-with-media-1' });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('status-with-media-1');

    await fs.unlink(path.join(uploadDir, filename)).catch(() => {});
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

  it('posts a due Facebook text post', async () => {
    const userId = await createUser('fb-sched1@example.com');
    const accountRes = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'facebook', 'My Page', 'page-1', 'page-token') RETURNING id`,
      [userId]
    );
    const postId = await createScheduledPost(userId, accountRes.rows[0].id, 'hello facebook');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        expect(String(url)).toBe('https://graph.facebook.com/v19.0/page-1/feed');
        return jsonResponse({ id: 'fb-post-1' });
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('fb-post-1');
  });

  it('posts a single Facebook photo via the unpublished-photo + attached_media flow', async () => {
    const userId = await createUser('fb-sched2@example.com');
    const accountRes = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'facebook', 'My Page', 'page-2', 'page-token') RETURNING id`,
      [userId]
    );

    const filename = `test-${crypto.randomUUID()}.jpg`;
    await fs.writeFile(path.join(uploadDir, filename), 'fake-image-bytes');

    const postId = await createScheduledPost(userId, accountRes.rows[0].id, 'a photo post');
    await createPostMedia(postId, { url: `${process.env.BASE_URL}/uploads/${filename}` });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        const u = String(url);
        if (u === 'https://graph.facebook.com/v19.0/page-2/photos') {
          expect(options.body).toBeInstanceOf(FormData);
          return jsonResponse({ id: 'fb-photo-1' });
        }
        if (u === 'https://graph.facebook.com/v19.0/page-2/feed') {
          const body = JSON.parse(options.body);
          expect(body.attached_media).toEqual([{ media_fbid: 'fb-photo-1' }]);
          return jsonResponse({ id: 'fb-post-2' });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('fb-post-2');

    await fs.unlink(path.join(uploadDir, filename)).catch(() => {});
  });

  it('posts multiple Facebook photos via the attached_media flow', async () => {
    const userId = await createUser('fb-multi@example.com');
    const accountRes = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'facebook', 'My Page', 'page-multi', 'page-token') RETURNING id`,
      [userId]
    );

    const filenames = [1, 2].map(() => `test-${crypto.randomUUID()}.jpg`);
    await Promise.all(filenames.map((f) => fs.writeFile(path.join(uploadDir, f), 'fake-image-bytes')));

    const postId = await createScheduledPost(userId, accountRes.rows[0].id, 'multi photo post');
    await createPostMedia(postId, { url: `${process.env.BASE_URL}/uploads/${filenames[0]}`, position: 0 });
    await createPostMedia(postId, { url: `${process.env.BASE_URL}/uploads/${filenames[1]}`, position: 1 });

    let photoUploads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        const u = String(url);
        if (u === 'https://graph.facebook.com/v19.0/page-multi/photos') {
          photoUploads += 1;
          return jsonResponse({ id: `photo-${photoUploads}` });
        }
        if (u === 'https://graph.facebook.com/v19.0/page-multi/feed') {
          const body = JSON.parse(options.body);
          expect(body.attached_media).toEqual([{ media_fbid: 'photo-1' }, { media_fbid: 'photo-2' }]);
          return jsonResponse({ id: 'fb-multi-post-1' });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('fb-multi-post-1');

    await Promise.all(filenames.map((f) => fs.unlink(path.join(uploadDir, f)).catch(() => {})));
  });

  it('posts a Facebook video directly, not through the photo flow', async () => {
    const userId = await createUser('fb-video@example.com');
    const accountRes = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'facebook', 'My Page', 'page-video', 'page-token') RETURNING id`,
      [userId]
    );
    const filename = `test-${crypto.randomUUID()}.mp4`;
    await fs.writeFile(path.join(uploadDir, filename), 'fake-video-bytes');

    const postId = await createScheduledPost(userId, accountRes.rows[0].id, 'a video post');
    await createPostMedia(postId, { url: `${process.env.BASE_URL}/uploads/${filename}`, mediaType: 'video' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        expect(String(url)).toBe('https://graph.facebook.com/v19.0/page-video/videos');
        expect(options.body).toBeInstanceOf(FormData);
        return jsonResponse({ id: 'fb-video-1' });
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('fb-video-1');

    await fs.unlink(path.join(uploadDir, filename)).catch(() => {});
  });

  it('fails an Instagram post with no media attached', async () => {
    const userId = await createUser('ig-sched1@example.com');
    const accountRes = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'instagram', '@handle', 'ig-1', 'ig-token') RETURNING id`,
      [userId]
    );
    const postId = await createScheduledPost(userId, accountRes.rows[0].id, 'no image here');

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error_message).toMatch(/requires an image or video/);
  });

  it('posts a due Instagram post via the single-image flow, including alt text', async () => {
    const userId = await createUser('ig-sched2@example.com');
    const accountRes = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'instagram', '@handle', 'ig-2', 'ig-token') RETURNING id`,
      [userId]
    );
    const postId = await createScheduledPost(userId, accountRes.rows[0].id, 'check this out');
    await createPostMedia(postId, { url: 'http://example.test/uploads/photo.jpg', altText: 'a nice photo' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        const u = String(url);
        if (u === 'https://graph.facebook.com/v19.0/ig-2/media') {
          const body = JSON.parse(options.body);
          expect(body.image_url).toBe('http://example.test/uploads/photo.jpg');
          expect(body.caption).toBe('check this out');
          expect(body.alt_text).toBe('a nice photo');
          return jsonResponse({ id: 'container-1' });
        }
        if (u.startsWith('https://graph.facebook.com/v19.0/container-1?')) {
          return jsonResponse({ status_code: 'FINISHED' });
        }
        if (u === 'https://graph.facebook.com/v19.0/ig-2/media_publish') {
          const body = JSON.parse(options.body);
          expect(body.creation_id).toBe('container-1');
          return jsonResponse({ id: 'ig-post-1' });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('ig-post-1');
  });

  it('fails an Instagram post when the media container reports an error', async () => {
    const userId = await createUser('ig-sched-error@example.com');
    const accountRes = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'instagram', '@handle', 'ig-err', 'ig-token') RETURNING id`,
      [userId]
    );
    const postId = await createScheduledPost(userId, accountRes.rows[0].id, 'this will fail to process');
    await createPostMedia(postId, { url: 'http://example.test/uploads/broken.jpg' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const u = String(url);
        if (u === 'https://graph.facebook.com/v19.0/ig-err/media') {
          return jsonResponse({ id: 'bad-container-1' });
        }
        if (u.startsWith('https://graph.facebook.com/v19.0/bad-container-1?')) {
          return jsonResponse({ status_code: 'ERROR' });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error_message).toMatch(/failed to process/);
  });

  it('posts a due Instagram carousel with multiple images', async () => {
    const userId = await createUser('ig-sched3@example.com');
    const accountRes = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'instagram', '@handle', 'ig-3', 'ig-token') RETURNING id`,
      [userId]
    );
    const postId = await createScheduledPost(userId, accountRes.rows[0].id, 'a carousel');
    await createPostMedia(postId, { url: 'http://example.test/uploads/one.jpg', position: 0 });
    await createPostMedia(postId, { url: 'http://example.test/uploads/two.jpg', position: 1 });

    let childCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        const u = String(url);
        if (u === 'https://graph.facebook.com/v19.0/ig-3/media') {
          const body = JSON.parse(options.body);
          if (body.media_type === 'CAROUSEL') {
            expect(body.children).toEqual(['child-1', 'child-2']);
            expect(body.caption).toBe('a carousel');
            return jsonResponse({ id: 'carousel-container-1' });
          }
          expect(body.is_carousel_item).toBe(true);
          childCalls += 1;
          return jsonResponse({ id: `child-${childCalls}` });
        }
        if (u.startsWith('https://graph.facebook.com/v19.0/child-1?') || u.startsWith('https://graph.facebook.com/v19.0/child-2?') || u.startsWith('https://graph.facebook.com/v19.0/carousel-container-1?')) {
          return jsonResponse({ status_code: 'FINISHED' });
        }
        if (u === 'https://graph.facebook.com/v19.0/ig-3/media_publish') {
          const body = JSON.parse(options.body);
          expect(body.creation_id).toBe('carousel-container-1');
          return jsonResponse({ id: 'ig-carousel-post-1' });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('ig-carousel-post-1');
  });
});
