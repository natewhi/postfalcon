import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../db/pool.js';
import { processDuePosts, refreshPostMetrics, refreshStoredPlatformData } from '../scheduler.js';
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

  it('sends Instagram a fitted JPEG copy of a photo it would reject, then deletes the copy', async () => {
    const { default: sharp } = await import('sharp');
    const userId = await createUser('ig-fit@example.com');
    const accountRes = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'instagram', '@handle', 'ig-fit', 'ig-token') RETURNING id`,
      [userId]
    );
    // The shape of the real photo that failed: 2928x1332 is ~2.2:1, wider than Instagram's 1.91:1.
    const filename = `test-${crypto.randomUUID()}.png`;
    await sharp({ create: { width: 2928, height: 1332, channels: 3, background: '#3366cc' } })
      .png()
      .toFile(path.join(uploadDir, filename));
    const originalUrl = `${process.env.BASE_URL}/uploads/${filename}`;
    const postId = await createScheduledPost(userId, accountRes.rows[0].id, 'a wide photo');
    await createPostMedia(postId, { url: originalUrl });

    let sentUrl;
    let fitted;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        const u = String(url);
        if (u === 'https://graph.facebook.com/v19.0/ig-fit/media') {
          sentUrl = JSON.parse(options.body).image_url;
          fitted = await sharp(path.join(uploadDir, path.basename(sentUrl))).metadata();
          return jsonResponse({ id: 'fit-container' });
        }
        if (u.startsWith('https://graph.facebook.com/v19.0/fit-container?')) return jsonResponse({ status_code: 'FINISHED' });
        if (u === 'https://graph.facebook.com/v19.0/ig-fit/media_publish') return jsonResponse({ id: 'ig-fit-post' });
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT status FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(sentUrl).not.toBe(originalUrl);
    expect(fitted.format).toBe('jpeg');
    expect(fitted.width).toBeLessThanOrEqual(1440);
    expect(fitted.width / fitted.height).toBeCloseTo(1.91, 1);
    // The fitted copy is gone; the user's original is untouched.
    await expect(fs.access(path.join(uploadDir, path.basename(sentUrl)))).rejects.toThrow();
    await expect(fs.access(path.join(uploadDir, filename))).resolves.toBeUndefined();
    await fs.unlink(path.join(uploadDir, filename)).catch(() => {});
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

  it('posts a due text-only Telegram post', async () => {
    const userId = await createUser('tg-sched1@example.com');
    const accountRes = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'telegram', 'My Channel', '-1001234567890', 'bot-token') RETURNING id`,
      [userId]
    );
    const postId = await createScheduledPost(userId, accountRes.rows[0].id, 'hello telegram');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        expect(String(url)).toBe('https://api.telegram.org/botbot-token/sendMessage');
        const body = JSON.parse(options.body);
        expect(body).toEqual({ chat_id: '-1001234567890', text: 'hello telegram' });
        return jsonResponse({ ok: true, result: { message_id: 4242 } });
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('4242');
  });

  it('sends a single Telegram photo with the caption', async () => {
    const userId = await createUser('tg-sched2@example.com');
    const accountRes = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'telegram', 'My Channel', '-100999', 'bot-token') RETURNING id`,
      [userId]
    );
    const filename = `test-${crypto.randomUUID()}.jpg`;
    await fs.writeFile(path.join(uploadDir, filename), 'fake-image-bytes');
    const postId = await createScheduledPost(userId, accountRes.rows[0].id, 'a photo caption');
    await createPostMedia(postId, { url: `${process.env.BASE_URL}/uploads/${filename}` });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        expect(String(url)).toBe('https://api.telegram.org/botbot-token/sendPhoto');
        expect(options.body).toBeInstanceOf(FormData);
        expect(options.body.get('caption')).toBe('a photo caption');
        return jsonResponse({ ok: true, result: { message_id: 7 } });
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('7');

    await fs.unlink(path.join(uploadDir, filename)).catch(() => {});
  });

  it('sends multiple Telegram media as an album and records the first message id', async () => {
    const userId = await createUser('tg-sched3@example.com');
    const accountRes = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'telegram', 'My Channel', '-100777', 'bot-token') RETURNING id`,
      [userId]
    );
    const filenames = [1, 2].map(() => `test-${crypto.randomUUID()}.jpg`);
    await Promise.all(filenames.map((f) => fs.writeFile(path.join(uploadDir, f), 'fake-image-bytes')));
    const postId = await createScheduledPost(userId, accountRes.rows[0].id, 'album caption');
    await createPostMedia(postId, { url: `${process.env.BASE_URL}/uploads/${filenames[0]}`, position: 0 });
    await createPostMedia(postId, { url: `${process.env.BASE_URL}/uploads/${filenames[1]}`, position: 1 });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        expect(String(url)).toBe('https://api.telegram.org/botbot-token/sendMediaGroup');
        const spec = JSON.parse(options.body.get('media'));
        expect(spec).toHaveLength(2);
        expect(spec[0]).toMatchObject({ type: 'photo', media: 'attach://file0', caption: 'album caption' });
        expect(spec[1]).toMatchObject({ type: 'photo', media: 'attach://file1' });
        expect(spec[1].caption).toBeUndefined();
        return jsonResponse({ ok: true, result: [{ message_id: 11 }, { message_id: 12 }] });
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('11');

    await Promise.all(filenames.map((f) => fs.unlink(path.join(uploadDir, f)).catch(() => {})));
  });

  async function createVideoAccount(userId, platform) {
    const res = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, refresh_token, token_expires_at)
       VALUES ($1, $2, '@vid', 'ext-vid', 'valid-token', 'refresh-token', now() + interval '1 hour') RETURNING id`,
      [userId, platform]
    );
    return res.rows[0].id;
  }

  it('uploads a due YouTube video via the resumable flow', async () => {
    const userId = await createUser('yt-sched@example.com');
    const accountId = await createVideoAccount(userId, 'youtube');
    const filename = `test-${crypto.randomUUID()}.mp4`;
    await fs.writeFile(path.join(uploadDir, filename), 'fake-video-bytes');
    const postId = await createScheduledPost(userId, accountId, 'my video');
    await createPostMedia(postId, { url: `${process.env.BASE_URL}/uploads/${filename}`, mediaType: 'video' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        const u = String(url);
        if (u.startsWith('https://www.googleapis.com/upload/youtube/v3/videos')) {
          const meta = JSON.parse(options.body);
          expect(meta.snippet.title).toBe('my video');
          // No youtube_options chosen: nothing goes public that the user didn't pick.
          expect(meta.status).toEqual({ privacyStatus: 'private', selfDeclaredMadeForKids: false });
          return { ok: true, status: 200, headers: { get: () => 'https://upload.googleapis.com/resume/abc' } };
        }
        if (u === 'https://upload.googleapis.com/resume/abc') {
          expect(options.method).toBe('PUT');
          return jsonResponse({ id: 'yt-vid-1' });
        }
        if (u.startsWith('https://www.googleapis.com/youtube/v3/videos?part=statistics&id=yt-vid-1')) {
          return jsonResponse({ items: [{ id: 'yt-vid-1', statistics: { viewCount: '0', likeCount: '0', commentCount: '0' } }] });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('yt-vid-1');
    // Metrics are read right after publishing, not only on the next 3-hourly refresh.
    expect(rows[0].metric_views).toBe(0);
    expect(rows[0].metrics_updated_at).not.toBeNull();

    await fs.unlink(path.join(uploadDir, filename)).catch(() => {});
  });

  it("uploads a YouTube video with the user's title, visibility and audience", async () => {
    const userId = await createUser('yt-opts@example.com');
    const accountId = await createVideoAccount(userId, 'youtube');
    const filename = `test-${crypto.randomUUID()}.mp4`;
    await fs.writeFile(path.join(uploadDir, filename), 'fake-video-bytes');
    const postId = await createScheduledPost(userId, accountId, 'the full description');
    await createPostMedia(postId, { url: `${process.env.BASE_URL}/uploads/${filename}`, mediaType: 'video' });
    await pool.query('UPDATE posts SET platform_options = $2 WHERE id = $1', [
      postId,
      { youtube: { title: 'Chosen title', privacy_status: 'unlisted', made_for_kids: true } },
    ]);

    let meta;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        const u = String(url);
        if (u.startsWith('https://www.googleapis.com/upload/youtube/v3/videos')) {
          meta = JSON.parse(options.body);
          return { ok: true, status: 200, headers: { get: () => 'https://upload.googleapis.com/resume/def' } };
        }
        if (u === 'https://upload.googleapis.com/resume/def') return jsonResponse({ id: 'yt-vid-2' });
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    await processDuePosts();

    expect(meta.snippet).toEqual({ title: 'Chosen title', description: 'the full description' });
    expect(meta.status).toEqual({ privacyStatus: 'unlisted', selfDeclaredMadeForKids: true });
    const { rows } = await pool.query('SELECT status FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    await fs.unlink(path.join(uploadDir, filename)).catch(() => {});
  });

  it('fails a YouTube post that has no video', async () => {
    const userId = await createUser('yt-novideo@example.com');
    const accountId = await createVideoAccount(userId, 'youtube');
    const postId = await createScheduledPost(userId, accountId, 'text only');

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error_message).toMatch(/need a video/);
  });

  it('publishes a due LinkedIn text post', async () => {
    const userId = await createUser('li-sched@example.com');
    const res = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'linkedin', 'Alice', 'li-123', 'valid-token') RETURNING id`,
      [userId]
    );
    const postId = await createScheduledPost(userId, res.rows[0].id, 'a LinkedIn update');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        expect(String(url)).toBe('https://api.linkedin.com/rest/posts');
        expect(JSON.parse(options.body).author).toBe('urn:li:person:li-123');
        return { ok: true, status: 201, headers: { get: (h) => (h === 'x-restli-id' ? 'urn:li:share:999' : null) } };
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('urn:li:share:999');
  });

  it('fails a LinkedIn post with media attached (not supported yet)', async () => {
    const userId = await createUser('li-media@example.com');
    const res = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'linkedin', 'Alice', 'li-124', 'valid-token') RETURNING id`,
      [userId]
    );
    const postId = await createScheduledPost(userId, res.rows[0].id, 'with a photo');
    await createPostMedia(postId, { url: `${process.env.BASE_URL}/uploads/whatever.jpg` });

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error_message).toMatch(/not supported yet/);
  });

  it('publishes a due Pinterest pin using the board stored at connect time', async () => {
    const userId = await createUser('pin-sched@example.com');
    const res = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, metadata)
       VALUES ($1, 'pinterest', 'alice', 'alice', 'valid-token', $2) RETURNING id`,
      [userId, JSON.stringify({ board_id: 'board-1', board_name: 'My Board' })]
    );
    const filename = `test-${crypto.randomUUID()}.jpg`;
    await fs.writeFile(path.join(uploadDir, filename), 'fake-image-bytes');
    const postId = await createScheduledPost(userId, res.rows[0].id, 'a pin');
    await createPostMedia(postId, { url: `${process.env.BASE_URL}/uploads/${filename}` });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        expect(String(url)).toBe('https://api.pinterest.com/v5/pins');
        expect(JSON.parse(options.body).board_id).toBe('board-1');
        return jsonResponse({ id: 'pin-1' }, 201);
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('pin-1');

    await fs.unlink(path.join(uploadDir, filename)).catch(() => {});
  });

  it('fails a Pinterest post with no image attached', async () => {
    const userId = await createUser('pin-noimage@example.com');
    const res = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, metadata)
       VALUES ($1, 'pinterest', 'alice', 'alice', 'valid-token', $2) RETURNING id`,
      [userId, JSON.stringify({ board_id: 'board-1', board_name: 'My Board' })]
    );
    const postId = await createScheduledPost(userId, res.rows[0].id, 'text only');

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error_message).toMatch(/need an image/);
  });

  it('renews an expired Pinterest token with its refresh token before pinning', async () => {
    const userId = await createUser('pi-refresh@example.com');
    const { rows: acc } = await pool.query(
      `INSERT INTO social_accounts
         (user_id, platform, display_name, external_account_id, access_token, refresh_token, token_expires_at, metadata)
       VALUES ($1, 'pinterest', 'alice', 'alice', 'old-token', 'rt-1', now() - interval '1 day', $2) RETURNING id`,
      [userId, { board_id: 'board-1' }]
    );
    const postId = await createScheduledPost(userId, acc[0].id, 'a pin');
    await createPostMedia(postId, { url: 'http://example.test/uploads/pin.jpg' });

    let pinAuth;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        const u = String(url);
        if (u === 'https://api.pinterest.com/v5/oauth/token') {
          expect(options.headers.Authorization).toMatch(/^Basic /);
          expect(String(options.body)).toContain('grant_type=refresh_token');
          return jsonResponse({ access_token: 'new-token', expires_in: 2592000 });
        }
        if (u === 'https://api.pinterest.com/v5/pins') {
          pinAuth = options.headers.Authorization;
          return jsonResponse({ id: 'pin-9' });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    await processDuePosts();

    expect(pinAuth).toBe('Bearer new-token');
    const { rows } = await pool.query('SELECT access_token, refresh_token FROM social_accounts WHERE id = $1', [acc[0].id]);
    expect(rows[0]).toEqual({ access_token: 'new-token', refresh_token: 'rt-1' });
  });

  it('publishes a due TikTok video and polls until complete', async () => {
    const userId = await createUser('tk-sched@example.com');
    const accountId = await createVideoAccount(userId, 'tiktok');
    const filename = `test-${crypto.randomUUID()}.mp4`;
    await fs.writeFile(path.join(uploadDir, filename), 'fake-video-bytes');
    const postId = await createScheduledPost(userId, accountId, 'tiktok clip');
    await createPostMedia(postId, { url: `${process.env.BASE_URL}/uploads/${filename}`, mediaType: 'video' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const u = String(url);
        if (u === 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/') {
          return jsonResponse({
            error: { code: 'ok' },
            data: { privacy_level_options: ['SELF_ONLY'], comment_disabled: false, duet_disabled: false, stitch_disabled: false },
          });
        }
        if (u === 'https://open.tiktokapis.com/v2/post/publish/video/init/') {
          return jsonResponse({ error: { code: 'ok' }, data: { publish_id: 'pub-1', upload_url: 'https://up.tiktok/xyz' } });
        }
        if (u === 'https://up.tiktok/xyz') {
          return jsonResponse({});
        }
        if (u === 'https://open.tiktokapis.com/v2/post/publish/status/fetch/') {
          return jsonResponse({ error: { code: 'ok' }, data: { status: 'PUBLISH_COMPLETE' } });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('pub-1');

    await fs.unlink(path.join(uploadDir, filename)).catch(() => {});
  });

  describe('TikTok post settings', () => {
    function stubTikTok(creatorInfo, captured) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url, options) => {
          const u = String(url);
          if (u === 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/') {
            return jsonResponse({ error: { code: 'ok' }, data: creatorInfo });
          }
          if (u === 'https://open.tiktokapis.com/v2/post/publish/video/init/') {
            captured.init = JSON.parse(options.body);
            return jsonResponse({ error: { code: 'ok' }, data: { publish_id: 'pub-2', upload_url: 'https://up.tiktok/abc' } });
          }
          if (u === 'https://up.tiktok/abc') return jsonResponse({});
          if (u === 'https://open.tiktokapis.com/v2/post/publish/status/fetch/') {
            return jsonResponse({ error: { code: 'ok' }, data: { status: 'PUBLISH_COMPLETE' } });
          }
          throw new Error(`unexpected fetch: ${u}`);
        })
      );
    }

    async function createTikTokVideoPost(email, platformOptions) {
      const userId = await createUser(email);
      const accountId = await createVideoAccount(userId, 'tiktok');
      const filename = `test-${crypto.randomUUID()}.mp4`;
      await fs.writeFile(path.join(uploadDir, filename), 'fake-video-bytes');
      const postId = await createScheduledPost(userId, accountId, 'tiktok clip');
      await createPostMedia(postId, { url: `${process.env.BASE_URL}/uploads/${filename}`, mediaType: 'video' });
      if (platformOptions) {
        await pool.query('UPDATE posts SET platform_options = $2 WHERE id = $1', [postId, platformOptions]);
      }
      return { postId, filename };
    }

    const openCreator = {
      privacy_level_options: ['PUBLIC_TO_EVERYONE', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
      comment_disabled: false,
      duet_disabled: true,
      stitch_disabled: false,
    };

    it("sends the user's chosen privacy, interactions and disclosure", async () => {
      const { postId, filename } = await createTikTokVideoPost('tk-opts@example.com', {
        tiktok: {
          privacy_level: 'FOLLOWER_OF_CREATOR',
          allow_comment: true,
          allow_duet: true,
          allow_stitch: false,
          brand_organic: true,
          brand_content: false,
        },
      });
      const captured = {};
      stubTikTok(openCreator, captured);

      await processDuePosts();

      const { rows } = await pool.query('SELECT status FROM posts WHERE id = $1', [postId]);
      expect(rows[0].status).toBe('posted');
      expect(captured.init.post_info).toEqual({
        title: 'tiktok clip',
        privacy_level: 'FOLLOWER_OF_CREATOR',
        disable_comment: false,
        // The creator disabled duets account-wide, which wins over the post's choice.
        disable_duet: true,
        disable_stitch: true,
        brand_organic_toggle: true,
        brand_content_toggle: false,
      });
      await fs.unlink(path.join(uploadDir, filename)).catch(() => {});
    });

    it('publishes privately with interactions off when no settings were chosen', async () => {
      const { filename } = await createTikTokVideoPost('tk-noopts@example.com', null);
      const captured = {};
      stubTikTok(openCreator, captured);

      await processDuePosts();

      expect(captured.init.post_info).toMatchObject({
        privacy_level: 'SELF_ONLY',
        disable_comment: true,
        disable_duet: true,
        disable_stitch: true,
        brand_organic_toggle: false,
        brand_content_toggle: false,
      });
      await fs.unlink(path.join(uploadDir, filename)).catch(() => {});
    });

    it('fails rather than silently changing a privacy level TikTok no longer offers', async () => {
      const { postId, filename } = await createTikTokVideoPost('tk-gone@example.com', {
        tiktok: { privacy_level: 'PUBLIC_TO_EVERYONE' },
      });
      const captured = {};
      stubTikTok({ ...openCreator, privacy_level_options: ['SELF_ONLY'] }, captured);

      await processDuePosts();

      const { rows } = await pool.query('SELECT status, error_message FROM posts WHERE id = $1', [postId]);
      expect(rows[0].status).toBe('failed');
      expect(rows[0].error_message).toMatch(/no longer offers/);
      expect(captured.init).toBeUndefined();
      await fs.unlink(path.join(uploadDir, filename)).catch(() => {});
    });
  });

  it('publishes a due Bluesky post with an image', async () => {
    const userId = await createUser('bs-sched@example.com');
    const account = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'bluesky', '@alice.bsky.social', 'did:plc:abc123', 'abcd-efgh-ijkl-mnop') RETURNING id`,
      [userId]
    );
    const filename = `test-${crypto.randomUUID()}.jpg`;
    await fs.writeFile(path.join(uploadDir, filename), 'fake-image-bytes');
    const postId = await createScheduledPost(userId, account.rows[0].id, 'hello bluesky');
    await createPostMedia(postId, { url: `${process.env.BASE_URL}/uploads/${filename}`, altText: 'a nice photo' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        const u = String(url);
        if (u === 'https://bsky.social/xrpc/com.atproto.server.createSession') {
          const body = JSON.parse(options.body);
          expect(body).toEqual({ identifier: 'did:plc:abc123', password: 'abcd-efgh-ijkl-mnop' });
          return jsonResponse({ did: 'did:plc:abc123', handle: 'alice.bsky.social', accessJwt: 'jwt-1' });
        }
        if (u === 'https://bsky.social/xrpc/com.atproto.repo.uploadBlob') {
          expect(options.headers.Authorization).toBe('Bearer jwt-1');
          return jsonResponse({ blob: { $type: 'blob', ref: { $link: 'bafy1' }, mimeType: 'image/jpeg' } });
        }
        if (u === 'https://bsky.social/xrpc/com.atproto.repo.createRecord') {
          const body = JSON.parse(options.body);
          expect(body.repo).toBe('did:plc:abc123');
          expect(body.record.text).toBe('hello bluesky');
          expect(body.record.embed.images[0].alt).toBe('a nice photo');
          return jsonResponse({ uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz', cid: 'cid1' });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('at://did:plc:abc123/app.bsky.feed.post/xyz');

    await fs.unlink(path.join(uploadDir, filename)).catch(() => {});
  });

  it('fails a Bluesky post that has a video attached', async () => {
    const userId = await createUser('bs-video@example.com');
    const account = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'bluesky', '@alice.bsky.social', 'did:plc:abc123', 'abcd-efgh-ijkl-mnop') RETURNING id`,
      [userId]
    );
    const postId = await createScheduledPost(userId, account.rows[0].id, 'video post');
    await createPostMedia(postId, { url: 'http://example.test/uploads/clip.mp4', mediaType: 'video' });

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error_message).toMatch(/video posting is not supported/);
  });

  it('publishes a due text-only Threads post and polls until complete', async () => {
    const userId = await createUser('th-sched@example.com');
    const account = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, token_expires_at)
       VALUES ($1, 'threads', '@alice', 'th-123', 'long-token', now() + interval '30 days') RETURNING id`,
      [userId]
    );
    const postId = await createScheduledPost(userId, account.rows[0].id, 'hello threads');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        const u = String(url);
        if (u === 'https://graph.threads.net/v1.0/th-123/threads') {
          const body = JSON.parse(options.body);
          expect(body).toMatchObject({ media_type: 'TEXT', text: 'hello threads', access_token: 'long-token' });
          return jsonResponse({ id: 'container-1' });
        }
        if (u.startsWith('https://graph.threads.net/v1.0/container-1?')) {
          return jsonResponse({ status: 'FINISHED' });
        }
        if (u === 'https://graph.threads.net/v1.0/th-123/threads_publish') {
          const body = JSON.parse(options.body);
          expect(body.creation_id).toBe('container-1');
          return jsonResponse({ id: 'threads-post-1' });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    await processDuePosts();

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('threads-post-1');
  });

  it('refreshes an expiring Threads token before publishing', async () => {
    const userId = await createUser('th-refresh@example.com');
    const account = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, token_expires_at)
       VALUES ($1, 'threads', '@alice', 'th-123', 'stale-token', now() + interval '1 day') RETURNING id`,
      [userId]
    );
    const postId = await createScheduledPost(userId, account.rows[0].id, 'refreshed post');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const u = String(url);
        if (u.startsWith('https://graph.threads.net/refresh_access_token')) {
          expect(u).toContain('access_token=stale-token');
          return jsonResponse({ access_token: 'fresh-token', expires_in: 5184000 });
        }
        if (u === 'https://graph.threads.net/v1.0/th-123/threads') {
          return jsonResponse({ id: 'container-2' });
        }
        if (u.startsWith('https://graph.threads.net/v1.0/container-2?')) {
          return jsonResponse({ status: 'FINISHED' });
        }
        if (u === 'https://graph.threads.net/v1.0/th-123/threads_publish') {
          return jsonResponse({ id: 'threads-post-2' });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    await processDuePosts();

    const { rows } = await pool.query(
      'SELECT posts.status, posts.platform_post_id, social_accounts.access_token FROM posts JOIN social_accounts ON social_accounts.id = posts.social_account_id WHERE posts.id = $1',
      [postId]
    );
    expect(rows[0].status).toBe('posted');
    expect(rows[0].platform_post_id).toBe('threads-post-2');
    expect(rows[0].access_token).toBe('fresh-token');
  });

  describe('webhooks', () => {
    // The scheduler fires webhooks without awaiting them (a slow endpoint must not stall the
    // publish loop), so tests wait for the delivery to land rather than assuming it's done.
    async function waitFor(predicate, { timeout = 2000, interval = 20 } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((r) => setTimeout(r, interval));
      }
      throw new Error('waitFor: condition not met before timeout');
    }

    async function addWebhook(userId, events = ['post.published', 'post.failed']) {
      const res = await pool.query(
        `INSERT INTO webhooks (user_id, url, secret, events) VALUES ($1, 'https://hook.test/in', 'whsec_abc', $2) RETURNING id`,
        [userId, events]
      );
      return res.rows[0].id;
    }

    it('delivers a signed post.published webhook after a post goes out', async () => {
      const userId = await createUser('wh-published@example.com');
      const accountId = await createMastodonAccount(userId);
      const postId = await createScheduledPost(userId, accountId);
      await addWebhook(userId);

      const calls = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url, options) => {
          const u = String(url);
          if (u === 'https://example.social/api/v1/statuses') return jsonResponse({ id: 'remote-1' });
          if (u === 'https://hook.test/in') {
            calls.push(options);
            return jsonResponse({ ok: true });
          }
          throw new Error(`unexpected fetch: ${u}`);
        })
      );

      await processDuePosts();
      await waitFor(() => calls.length === 1);

      expect(calls[0].headers['X-Postfalcon-Event']).toBe('post.published');
      expect(calls[0].headers['X-Postfalcon-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
      const body = JSON.parse(calls[0].body);
      expect(body.event).toBe('post.published');
      expect(body.data).toMatchObject({ post_id: postId, platform: 'mastodon', platform_post_id: 'remote-1' });

      await waitFor(async () => {
        const { rows } = await pool.query('SELECT last_delivery_status FROM webhooks WHERE user_id = $1', [userId]);
        return rows[0].last_delivery_status === 200;
      });
    });

    it('delivers a post.failed webhook when publishing fails', async () => {
      const userId = await createUser('wh-failed@example.com');
      const accountId = await createMastodonAccount(userId);
      await createScheduledPost(userId, accountId);
      await addWebhook(userId);

      const calls = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url, options) => {
          const u = String(url);
          if (u === 'https://example.social/api/v1/statuses') return jsonResponse({ error: 'nope' }, 422);
          if (u === 'https://hook.test/in') {
            calls.push(JSON.parse(options.body));
            return jsonResponse({ ok: true });
          }
          throw new Error(`unexpected fetch: ${u}`);
        })
      );

      await processDuePosts();
      await waitFor(() => calls.length === 1);

      expect(calls[0].event).toBe('post.failed');
      expect(calls[0].data.error).toMatch(/422/);
    });

    it('does not call an endpoint not subscribed to the event', async () => {
      const userId = await createUser('wh-partial@example.com');
      const accountId = await createMastodonAccount(userId);
      await createScheduledPost(userId, accountId);
      await addWebhook(userId, ['post.failed']); // only failures

      const hookCalls = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url) => {
          const u = String(url);
          if (u === 'https://example.social/api/v1/statuses') return jsonResponse({ id: 'remote-2' });
          if (u === 'https://hook.test/in') {
            hookCalls.push(u);
            return jsonResponse({ ok: true });
          }
          throw new Error(`unexpected fetch: ${u}`);
        })
      );

      await processDuePosts();
      await new Promise((r) => setTimeout(r, 100)); // give any (wrongly) fired delivery a chance to land
      expect(hookCalls).toHaveLength(0);
    });
  });

  describe('recurring posts', () => {
    it('queues the next occurrence with copied media after a recurring post publishes', async () => {
      const userId = await createUser('repeat1@example.com');
      const accountId = await createMastodonAccount(userId);

      const filename = `test-${crypto.randomUUID()}.jpg`;
      await fs.writeFile(path.join(uploadDir, filename), 'fake-image-bytes');

      const { rows: made } = await pool.query(
        `INSERT INTO posts (user_id, social_account_id, content, status, scheduled_for, repeat_interval)
         VALUES ($1, $2, 'daily digest', 'scheduled', now() - interval '1 minute', 'daily')
         RETURNING id`,
        [userId, accountId]
      );
      const postId = made[0].id;
      await createPostMedia(postId, { url: `${process.env.BASE_URL}/uploads/${filename}`, altText: 'chart' });

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url, options) => {
          const u = String(url);
          if (u === 'https://example.social/api/v2/media') return jsonResponse({ id: 'm-1' });
          if (u === 'https://example.social/api/v1/statuses') return jsonResponse({ id: 'remote-1' });
          throw new Error(`unexpected fetch: ${u}`);
        })
      );

      await processDuePosts();

      const { rows: next } = await pool.query(
        `SELECT * FROM posts WHERE user_id = $1 AND status = 'scheduled' AND repeat_parent_id = $2`,
        [userId, postId]
      );
      expect(next).toHaveLength(1);
      expect(next[0].content).toBe('daily digest');
      expect(next[0].repeat_interval).toBe('daily');
      expect(new Date(next[0].scheduled_for).getTime()).toBeGreaterThan(Date.now());

      const { rows: media } = await pool.query('SELECT * FROM post_media WHERE post_id = $1', [next[0].id]);
      expect(media).toHaveLength(1);
      const copiedName = path.basename(media[0].url);
      expect(copiedName).not.toBe(filename);
      expect((await fs.stat(path.join(uploadDir, copiedName))).isFile()).toBe(true);

      await fs.unlink(path.join(uploadDir, filename)).catch(() => {});
      await fs.unlink(path.join(uploadDir, copiedName)).catch(() => {});
    });

    it('stops recurring once past repeat_until', async () => {
      const userId = await createUser('repeat2@example.com');
      const accountId = await createMastodonAccount(userId);

      const { rows: made } = await pool.query(
        `INSERT INTO posts (user_id, social_account_id, content, status, scheduled_for, repeat_interval, repeat_until)
         VALUES ($1, $2, 'last one', 'scheduled', now() - interval '1 minute', 'daily', now())
         RETURNING id`,
        [userId, accountId]
      );

      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ id: 'remote-1' })));
      await processDuePosts();

      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM posts WHERE user_id = $1 AND status = 'scheduled'`,
        [userId]
      );
      expect(rows[0].n).toBe(0);
    });
  });
});

async function createPostedPost(userId, accountId, { platformPostId, postedAt = new Date(), content = 'posted content' }) {
  const res = await pool.query(
    `INSERT INTO posts (user_id, social_account_id, content, status, posted_at, platform_post_id)
     VALUES ($1, $2, $3, 'posted', $4, $5)
     RETURNING id`,
    [userId, accountId, content, postedAt, platformPostId]
  );
  return res.rows[0].id;
}

describe('post metrics refresh', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches and stores metrics for a posted Mastodon post', async () => {
    const userId = await createUser('metrics-mastodon@example.com');
    const accountId = await createMastodonAccount(userId);
    const postId = await createPostedPost(userId, accountId, { platformPostId: 'remote-status-1' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        expect(String(url)).toBe('https://example.social/api/v1/statuses/remote-status-1');
        return jsonResponse({ favourites_count: 5, replies_count: 2, reblogs_count: 1 });
      })
    );

    const result = await refreshPostMetrics();
    expect(result.refreshed).toBe(1);

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].metric_likes).toBe(5);
    expect(rows[0].metric_comments).toBe(2);
    expect(rows[0].metric_shares).toBe(1);
    expect(rows[0].metric_views).toBeNull();
    expect(rows[0].metrics_updated_at).not.toBeNull();
  });

  it('fetches and stores metrics for a posted Threads post (media insights `values` shape)', async () => {
    const userId = await createUser('metrics-threads@example.com');
    const { rows: acct } = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, token_expires_at)
       VALUES ($1, 'threads', '@me', 'th-user-1', 'th-token', now() + interval '50 days') RETURNING id`,
      [userId]
    );
    const postId = await createPostedPost(userId, acct[0].id, { platformPostId: 'th-media-1' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        expect(String(url)).toContain('https://graph.threads.net/v1.0/th-media-1/insights');
        return jsonResponse({
          data: [
            { name: 'views', period: 'lifetime', values: [{ value: 42 }] },
            { name: 'likes', period: 'lifetime', values: [{ value: 3 }] },
            { name: 'replies', period: 'lifetime', values: [{ value: 1 }] },
            { name: 'reposts', period: 'lifetime', values: [{ value: 0 }] },
          ],
        });
      })
    );

    const result = await refreshPostMetrics();
    expect(result.refreshed).toBe(1);

    const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
    expect(rows[0].metric_views).toBe(42);
    expect(rows[0].metric_likes).toBe(3);
    expect(rows[0].metric_comments).toBe(1);
    expect(rows[0].metric_shares).toBe(0);
  });

  it("doesn't ask for `shares` on a Facebook video (a Video node has no such field)", async () => {
    const userId = await createUser('metrics-fb-video@example.com');
    const { rows: acct } = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'facebook', 'My Page', 'page-1', 'page-token') RETURNING id`,
      [userId]
    );
    const videoPostId = await createPostedPost(userId, acct[0].id, { platformPostId: '987654321', content: 'video' });
    const feedPostId = await createPostedPost(userId, acct[0].id, { platformPostId: 'page-1_555', content: 'text' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const fields = new URL(String(url)).searchParams.get('fields');
        if (String(url).includes('987654321')) {
          expect(fields).not.toContain('shares');
          return jsonResponse({ likes: { summary: { total_count: 4 } }, comments: { summary: { total_count: 1 } } });
        }
        expect(fields).toContain('shares');
        // A Page post with no shares omits the field entirely.
        return jsonResponse({ likes: { summary: { total_count: 2 } }, comments: { summary: { total_count: 0 } } });
      })
    );

    const result = await refreshPostMetrics();
    expect(result.refreshed).toBe(2);

    const { rows } = await pool.query(
      'SELECT id, metric_likes, metric_comments, metric_shares FROM posts WHERE id = ANY($1)',
      [[videoPostId, feedPostId]]
    );
    const video = rows.find((r) => r.id === videoPostId);
    const feed = rows.find((r) => r.id === feedPostId);
    expect(video).toMatchObject({ metric_likes: 4, metric_comments: 1, metric_shares: null });
    expect(feed).toMatchObject({ metric_likes: 2, metric_comments: 0, metric_shares: 0 });
  });

  it('skips a platform with no metrics adapter (Telegram) without touching its metric columns', async () => {
    const userId = await createUser('metrics-telegram@example.com');
    const { rows: acct } = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'telegram', 'My channel', '12345', 'bot-token') RETURNING id`,
      [userId]
    );
    const postId = await createPostedPost(userId, acct[0].id, { platformPostId: '99' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch should not be called for a platform with no fetchMetrics adapter');
      })
    );

    const result = await refreshPostMetrics();
    expect(result.refreshed).toBe(0);

    const { rows } = await pool.query('SELECT metric_likes, metrics_updated_at FROM posts WHERE id = $1', [postId]);
    expect(rows[0].metric_likes).toBeNull();
    expect(rows[0].metrics_updated_at).toBeNull();
  });

  it('isolates a metrics-fetch failure on one post from the rest of the run', async () => {
    const userId = await createUser('metrics-partial-fail@example.com');
    const accountId = await createMastodonAccount(userId);
    const failingPostId = await createPostedPost(userId, accountId, { platformPostId: 'bad-status', content: 'a' });
    const okPostId = await createPostedPost(userId, accountId, { platformPostId: 'good-status', content: 'b' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url).includes('bad-status')) {
          return { ok: false, status: 500, text: async () => 'boom' };
        }
        return jsonResponse({ favourites_count: 9, replies_count: 0, reblogs_count: 0 });
      })
    );

    const result = await refreshPostMetrics();
    expect(result.checked).toBe(2);
    expect(result.refreshed).toBe(1);

    const { rows } = await pool.query(
      'SELECT id, metric_likes FROM posts WHERE id = ANY($1) ORDER BY id',
      [[failingPostId, okPostId]]
    );
    const failing = rows.find((r) => r.id === failingPostId);
    const ok = rows.find((r) => r.id === okPostId);
    expect(failing.metric_likes).toBeNull();
    expect(ok.metric_likes).toBe(9);
  });

  it('only considers posts from the last 30 days', async () => {
    const userId = await createUser('metrics-old@example.com');
    const accountId = await createMastodonAccount(userId);
    await createPostedPost(userId, accountId, {
      platformPostId: 'ancient-status',
      postedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch should not be called for a post older than the lookback window');
      })
    );

    const result = await refreshPostMetrics();
    expect(result.checked).toBe(0);
  });
});

describe('stored platform data refresh', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function youtubeAccountWithPosts(email, { expired = false } = {}) {
    const userId = await createUser(email);
    const account = await pool.query(
      `INSERT INTO social_accounts
         (user_id, platform, display_name, external_account_id, access_token, refresh_token, token_expires_at, avatar_url)
       VALUES ($1, 'youtube', 'Old Name', 'UC-x', 'valid-token', 'refresh-token', $2, 'https://yt3.ggpht.com/old.jpg')
       RETURNING id`,
      [userId, expired ? new Date(Date.now() - 60_000) : new Date(Date.now() + 3600_000)]
    );
    const accountId = account.rows[0].id;
    const ids = [];
    for (const [videoId, daysAgo] of [['vid-old', 90], ['vid-gone', 60]]) {
      const { rows } = await pool.query(
        `INSERT INTO posts (user_id, social_account_id, content, status, posted_at, platform_post_id, metric_views)
         VALUES ($1, $2, 'p', 'posted', now() - make_interval(days => $3), $4, 5) RETURNING id`,
        [userId, accountId, daysAgo, videoId]
      );
      ids.push(rows[0].id);
    }
    return { accountId, oldPostId: ids[0], gonePostId: ids[1] };
  }

  it('refreshes the YouTube channel and every published video, dropping deleted ones', async () => {
    const { accountId, oldPostId, gonePostId } = await youtubeAccountWithPosts('yt-refresh@example.com');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const u = new URL(String(url));
        if (u.pathname === '/youtube/v3/channels') {
          return jsonResponse({
            items: [{ snippet: { title: 'New Name', thumbnails: { default: { url: 'https://yt3.ggpht.com/new.jpg' } } } }],
          });
        }
        if (u.pathname === '/youtube/v3/videos') {
          expect(u.searchParams.get('id').split(',').sort()).toEqual(['vid-gone', 'vid-old']);
          return jsonResponse({ items: [{ id: 'vid-old', statistics: { viewCount: '42', likeCount: '3', commentCount: '1' } }] });
        }
        throw new Error(`unexpected fetch: ${u}`);
      })
    );

    const result = await refreshStoredPlatformData();
    expect(result).toEqual({ checked: 1, revoked: 0 });

    const acct = await pool.query('SELECT display_name, avatar_url FROM social_accounts WHERE id = $1', [accountId]);
    expect(acct.rows[0]).toEqual({ display_name: 'New Name', avatar_url: 'https://yt3.ggpht.com/new.jpg' });
    const posts = await pool.query('SELECT id, metric_views, metric_likes FROM posts WHERE id = ANY($1)', [
      [oldPostId, gonePostId],
    ]);
    const byId = Object.fromEntries(posts.rows.map((r) => [r.id, r]));
    expect(byId[oldPostId]).toMatchObject({ metric_views: 42, metric_likes: 3 });
    expect(byId[gonePostId]).toMatchObject({ metric_views: null, metric_likes: null });
  });

  it('deletes stored YouTube data when Google says access was revoked', async () => {
    const { accountId, oldPostId } = await youtubeAccountWithPosts('yt-revoked@example.com', { expired: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        expect(String(url)).toBe('https://oauth2.googleapis.com/token');
        return jsonResponse({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
      })
    );

    const result = await refreshStoredPlatformData();
    expect(result).toEqual({ checked: 1, revoked: 1 });

    const acct = await pool.query('SELECT avatar_url FROM social_accounts WHERE id = $1', [accountId]);
    expect(acct.rows[0].avatar_url).toBeNull();
    const post = await pool.query('SELECT metric_views FROM posts WHERE id = $1', [oldPostId]);
    expect(post.rows[0].metric_views).toBeNull();
  });
});

describe('reconnect flagging', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function linkedinPost(email) {
    const userId = await createUser(email);
    const account = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'linkedin', 'Alice', 'li-1', 'tok') RETURNING id`,
      [userId]
    );
    const accountId = account.rows[0].id;
    const postId = await createScheduledPost(userId, accountId, 'hello');
    return { accountId, postId };
  }

  function stubLinkedIn(status, body) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: status < 300,
        status,
        text: async () => body,
        json: async () => ({}),
        headers: { get: (h) => (h === 'x-restli-id' ? 'urn:li:share:1' : null) },
      }))
    );
  }

  it('flags the account and emails the owner once when the platform rejects its token', async () => {
    const { sendMail } = await import('../lib/mailer.js');
    sendMail.mockClear();
    const { accountId } = await linkedinPost('li-401@example.com');
    const second = await createScheduledPost(
      (await pool.query('SELECT user_id FROM social_accounts WHERE id = $1', [accountId])).rows[0].user_id,
      accountId,
      'again'
    );
    stubLinkedIn(401, '{"message":"Invalid access token"}');

    await processDuePosts();

    const { rows } = await pool.query('SELECT needs_reconnect_at, reconnect_reason FROM social_accounts WHERE id = $1', [
      accountId,
    ]);
    expect(rows[0].needs_reconnect_at).toBeInstanceOf(Date);
    expect(rows[0].reconnect_reason).toMatch(/401/);
    // Two posts failed for the same account, but only one email goes out.
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe('li-401@example.com');
    expect(second).toBeTruthy();
  });

  it("tells Meta's expired-token errors apart from its other OAuthException-typed errors", async () => {
    const { looksLikeAuthFailure } = await import('../lib/reconnect.js');
    const meta = (error) => new Error(`Instagram media creation failed (400): ${JSON.stringify({ error })}`);
    expect(
      looksLikeAuthFailure(
        meta({ message: 'The submitted image with aspect ratio () cannot be published.', type: 'OAuthException', code: 36003 })
      )
    ).toBe(false);
    expect(looksLikeAuthFailure(meta({ message: 'Error validating access token', type: 'OAuthException', code: 190 }))).toBe(true);
    expect(looksLikeAuthFailure(meta({ message: 'Session expired', type: 'OAuthException', code: 102 }))).toBe(true);
  });

  it('does not flag the account for an ordinary failure', async () => {
    const { accountId } = await linkedinPost('li-500@example.com');
    stubLinkedIn(500, 'internal error');

    await processDuePosts();

    const { rows } = await pool.query('SELECT needs_reconnect_at FROM social_accounts WHERE id = $1', [accountId]);
    expect(rows[0].needs_reconnect_at).toBeNull();
  });

  it('clears the flag after a successful publish', async () => {
    const { accountId } = await linkedinPost('li-ok@example.com');
    await pool.query(`UPDATE social_accounts SET needs_reconnect_at = now(), reconnect_reason = 'x' WHERE id = $1`, [
      accountId,
    ]);
    stubLinkedIn(201, '');

    await processDuePosts();

    const { rows } = await pool.query('SELECT needs_reconnect_at FROM social_accounts WHERE id = $1', [accountId]);
    expect(rows[0].needs_reconnect_at).toBeNull();
  });
});
