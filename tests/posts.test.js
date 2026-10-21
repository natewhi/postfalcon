import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import app from '../app.js';
import { uploadDir } from '../middleware/upload.js';
import { pool } from '../db/pool.js';

async function loginNewUser() {
  const client = request.agent(app);
  const email = `user${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

describe('posts', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/posts');
    expect(res.status).toBe(401);
  });

  it('creates a draft post when no schedule is given, and lists it', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    expect(account.status).toBe(201);

    const post = await client.post('/api/v1/posts').send({
      social_account_id: account.body.id,
      content: 'hello world',
    });
    expect(post.status).toBe(201);
    expect(post.body.status).toBe('draft');

    const list = await client.get('/api/v1/posts');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].platform).toBe('twitter');
    expect(list.body[0].account_display_name).toBe('@me');
  });

  it('creates a scheduled post when scheduled_for is given', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    const scheduledFor = new Date(Date.now() + 60_000).toISOString();

    const post = await client.post('/api/v1/posts').send({
      social_account_id: account.body.id,
      content: 'hello world',
      scheduled_for: scheduledFor,
    });
    expect(post.status).toBe(201);
    expect(post.body.status).toBe('scheduled');
  });

  it('rejects creating a post scheduled in the past', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    const scheduledFor = new Date(Date.now() - 60_000).toISOString();

    const res = await client.post('/api/v1/posts').send({
      social_account_id: account.body.id,
      content: 'too late',
      scheduled_for: scheduledFor,
    });
    expect(res.status).toBe(400);
  });

  it('rejects rescheduling a post to the past', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    const post = await client.post('/api/v1/posts').send({ social_account_id: account.body.id, content: 'hello' });

    const res = await client
      .patch(`/api/v1/posts/${post.body.id}`)
      .send({ status: 'scheduled', scheduled_for: new Date(Date.now() - 60_000).toISOString() });
    expect(res.status).toBe(400);
  });

  it('rejects a post with empty content', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });

    const res = await client.post('/api/v1/posts').send({ social_account_id: account.body.id, content: '' });
    expect(res.status).toBe(400);
  });

  it('rejects posting against a social account owned by another user', async () => {
    const clientA = await loginNewUser();
    const clientB = await loginNewUser();
    const accountA = await clientA.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@a' });

    const res = await clientB.post('/api/v1/posts').send({ social_account_id: accountA.body.id, content: 'sneaky' });
    expect(res.status).toBe(400);
  });

  it('does not allow reading another user\'s post by id', async () => {
    const clientA = await loginNewUser();
    const clientB = await loginNewUser();
    const account = await clientA.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@a' });
    const post = await clientA.post('/api/v1/posts').send({ social_account_id: account.body.id, content: 'private' });

    const res = await clientB.get(`/api/v1/posts/${post.body.id}`);
    expect(res.status).toBe(404);
  });

  it('deletes a post', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    const post = await client.post('/api/v1/posts').send({ social_account_id: account.body.id, content: 'bye' });

    const del = await client.delete(`/api/v1/posts/${post.body.id}`);
    expect(del.status).toBe(204);

    const get = await client.get(`/api/v1/posts/${post.body.id}`);
    expect(get.status).toBe(404);
  });

  it('filters posts by social_account_id', async () => {
    const client = await loginNewUser();
    const accountA = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@a' });
    const accountB = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@b' });
    await client.post('/api/v1/posts').send({ social_account_id: accountA.body.id, content: 'from account a' });
    await client.post('/api/v1/posts').send({ social_account_id: accountB.body.id, content: 'from account b' });

    const filtered = await client.get(`/api/v1/posts?social_account_id=${accountA.body.id}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body).toHaveLength(1);
    expect(filtered.body[0].content).toBe('from account a');
  });

  it('filters posts by a single status and by comma-separated multiple statuses', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    const draft = await client.post('/api/v1/posts').send({ social_account_id: account.body.id, content: 'a draft' });
    const scheduledFor = new Date(Date.now() + 60_000).toISOString();
    const scheduled = await client
      .post('/api/v1/posts')
      .send({ social_account_id: account.body.id, content: 'a scheduled post', scheduled_for: scheduledFor });
    const canceled = await client.patch(`/api/v1/posts/${scheduled.body.id}`).send({ status: 'canceled' });
    expect(canceled.status).toBe(200);

    const draftOnly = await client.get('/api/v1/posts?status=draft');
    expect(draftOnly.status).toBe(200);
    expect(draftOnly.body).toHaveLength(1);
    expect(draftOnly.body[0].id).toBe(draft.body.id);

    const multi = await client.get('/api/v1/posts?status=draft,canceled');
    expect(multi.status).toBe(200);
    expect(multi.body.map((p) => p.id).sort()).toEqual([draft.body.id, canceled.body.id].sort());
  });

  it('accepts an image upload and stores it in the media array', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });

    const post = await client
      .post('/api/v1/posts')
      .field('social_account_id', String(account.body.id))
      .field('content', 'post with image')
      .field('alt_texts', JSON.stringify(['a cat wearing a hat']))
      .attach('media', Buffer.from('fake-image-bytes'), 'photo.jpg');

    expect(post.status).toBe(201);
    expect(post.body.media).toHaveLength(1);
    expect(post.body.media[0].media_type).toBe('image');
    expect(post.body.media[0].url).toMatch(/\/uploads\//);
    expect(post.body.media[0].alt_text).toBe('a cat wearing a hat');
    expect(post.body.media[0].position).toBe(0);
  });

  it('accepts multiple images in order with per-image alt text', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });

    const post = await client
      .post('/api/v1/posts')
      .field('social_account_id', String(account.body.id))
      .field('content', 'a carousel post')
      .field('alt_texts', JSON.stringify(['first image', 'second image', '']))
      .attach('media', Buffer.from('fake-image-bytes-1'), 'one.jpg')
      .attach('media', Buffer.from('fake-image-bytes-2'), 'two.jpg')
      .attach('media', Buffer.from('fake-image-bytes-3'), 'three.jpg');

    expect(post.status).toBe(201);
    expect(post.body.media).toHaveLength(3);
    expect(post.body.media.map((m) => m.position)).toEqual([0, 1, 2]);
    expect(post.body.media[0].alt_text).toBe('first image');
    expect(post.body.media[1].alt_text).toBe('second image');
    expect(post.body.media[2].alt_text).toBeNull();

    const fetched = await client.get(`/api/v1/posts/${post.body.id}`);
    expect(fetched.body.media).toHaveLength(3);
  });

  it('rejects a disallowed file type', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });

    const res = await client
      .post('/api/v1/posts')
      .field('social_account_id', String(account.body.id))
      .field('content', 'post with bad file')
      .attach('media', Buffer.from('not a real file'), 'malware.exe');

    expect(res.status).toBe(400);
  });

  it('deletes the uploaded file from disk when the post is deleted', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });

    const post = await client
      .post('/api/v1/posts')
      .field('social_account_id', String(account.body.id))
      .field('content', 'post with image to delete')
      .attach('media', Buffer.from('fake-image-bytes'), 'photo2.jpg');

    const filePath = path.join(uploadDir, path.basename(post.body.media[0].url));
    expect(fs.existsSync(filePath)).toBe(true);

    await client.delete(`/api/v1/posts/${post.body.id}`);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe('post now', () => {
  const isAboutNow = (iso) => Math.abs(new Date(iso).getTime() - Date.now()) < 10_000;

  it('queues a new post for the next scheduler run', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });

    // Multipart, as the composer sends it (publish_now arrives as the string "true").
    const post = await client
      .post('/api/v1/posts')
      .field('social_account_id', String(account.body.id))
      .field('content', 'right now')
      .field('publish_now', 'true');
    expect(post.status).toBe(201);
    expect(post.body.status).toBe('scheduled');
    expect(isAboutNow(post.body.scheduled_for)).toBe(true);
  });

  it('turns an existing draft into a post-now', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    const draft = await client.post('/api/v1/posts').send({ social_account_id: account.body.id, content: 'later' });

    const res = await client.patch(`/api/v1/posts/${draft.body.id}`).send({ publish_now: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('scheduled');
    expect(isAboutNow(res.body.scheduled_for)).toBe(true);
  });

  it('rejects publish_now together with a scheduled_for', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    const res = await client.post('/api/v1/posts').send({
      social_account_id: account.body.id,
      content: 'which one?',
      publish_now: true,
      scheduled_for: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(res.status).toBe(400);
  });

  it('leaves a post a draft when publish_now is false', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    const post = await client
      .post('/api/v1/posts')
      .send({ social_account_id: account.body.id, content: 'not yet', publish_now: false });
    expect(post.body.status).toBe('draft');
  });
});

describe('editing posts', () => {
  it('updates content on a draft post', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    const post = await client.post('/api/v1/posts').send({ social_account_id: account.body.id, content: 'original' });

    const res = await client.patch(`/api/v1/posts/${post.body.id}`).send({ content: 'updated' });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('updated');
    expect(res.body.media).toEqual([]);
  });

  it('moves a draft to scheduled and back to draft', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    const post = await client.post('/api/v1/posts').send({ social_account_id: account.body.id, content: 'hello' });
    expect(post.body.status).toBe('draft');

    const scheduledFor = new Date(Date.now() + 60_000).toISOString();
    const scheduled = await client
      .patch(`/api/v1/posts/${post.body.id}`)
      .send({ status: 'scheduled', scheduled_for: scheduledFor });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.status).toBe('scheduled');
    expect(scheduled.body.scheduled_for).toBeTruthy();

    const backToDraft = await client
      .patch(`/api/v1/posts/${post.body.id}`)
      .send({ status: 'draft', scheduled_for: null });
    expect(backToDraft.status).toBe(200);
    expect(backToDraft.body.status).toBe('draft');
    expect(backToDraft.body.scheduled_for).toBeNull();
  });

  it('rejects an update with no fields', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    const post = await client.post('/api/v1/posts').send({ social_account_id: account.body.id, content: 'hello' });

    const res = await client.patch(`/api/v1/posts/${post.body.id}`).send({});
    expect(res.status).toBe(400);
  });

  it('404s updating a nonexistent post', async () => {
    const client = await loginNewUser();
    const res = await client.patch('/api/v1/posts/999999').send({ content: 'x' });
    expect(res.status).toBe(404);
  });

  it("does not allow editing another user's post", async () => {
    const clientA = await loginNewUser();
    const clientB = await loginNewUser();
    const account = await clientA.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@a' });
    const post = await clientA.post('/api/v1/posts').send({ social_account_id: account.body.id, content: 'mine' });

    const res = await clientB.patch(`/api/v1/posts/${post.body.id}`).send({ content: 'hijacked' });
    expect(res.status).toBe(404);

    const stillOriginal = await clientA.get(`/api/v1/posts/${post.body.id}`);
    expect(stillOriginal.body.content).toBe('mine');
  });
});

describe('cross-posting', () => {
  it('creates one grouped post per channel when social_account_ids is an array', async () => {
    const client = await loginNewUser();
    const a = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@a' });
    const b = await client.post('/api/v1/social-accounts').send({ platform: 'mastodon', display_name: '@b' });

    const res = await client.post('/api/v1/posts').send({
      social_account_ids: [a.body.id, b.body.id],
      content: 'shared everywhere',
    });
    expect(res.status).toBe(201);
    expect(res.body.crosspost_group_id).toBeTruthy();
    expect(res.body.posts).toHaveLength(2);
    const groups = new Set(res.body.posts.map((p) => p.crosspost_group_id));
    expect(groups).toEqual(new Set([res.body.crosspost_group_id]));
    expect(res.body.posts.map((p) => p.social_account_id).sort()).toEqual([a.body.id, b.body.id].sort());
  });

  it('returns a bare post object (no group) for a single-channel array', async () => {
    const client = await loginNewUser();
    const a = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@a' });

    const res = await client.post('/api/v1/posts').send({
      social_account_ids: [a.body.id],
      content: 'just one',
    });
    expect(res.status).toBe(201);
    expect(res.body.crosspost_group_id).toBeNull();
    expect(res.body.posts).toBeUndefined();
  });

  it('copies media to a separate file for each channel', async () => {
    const client = await loginNewUser();
    const a = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@a' });
    const b = await client.post('/api/v1/social-accounts').send({ platform: 'mastodon', display_name: '@b' });

    const res = await client
      .post('/api/v1/posts')
      .field('social_account_ids', String(a.body.id))
      .field('social_account_ids', String(b.body.id))
      .field('content', 'carousel everywhere')
      .attach('media', Buffer.from('img-bytes'), 'shared.jpg');

    expect(res.status).toBe(201);
    const urls = res.body.posts.map((p) => p.media[0].url);
    expect(urls[0]).not.toBe(urls[1]);
    for (const url of urls) {
      expect(fs.existsSync(path.join(uploadDir, path.basename(url)))).toBe(true);
    }
  });

  it('rejects an unknown channel in the array', async () => {
    const client = await loginNewUser();
    const a = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@a' });
    const other = await loginNewUser();
    const foreign = await other.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@x' });

    const res = await client.post('/api/v1/posts').send({
      social_account_ids: [a.body.id, foreign.body.id],
      content: 'partly sneaky',
    });
    // The foreign id is silently dropped; the owned one still goes through.
    expect(res.status).toBe(201);
    expect(res.body.social_account_id).toBe(a.body.id);
  });
});

describe('repeated posts', () => {
  it('stores repeat_interval and repeat_until on a scheduled post', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });

    const res = await client.post('/api/v1/posts').send({
      social_account_id: account.body.id,
      content: 'every day',
      scheduled_for: new Date(Date.now() + 60_000).toISOString(),
      repeat_interval: 'daily',
      repeat_until: new Date(Date.now() + 30 * 86400000).toISOString(),
    });
    expect(res.status).toBe(201);
    expect(res.body.repeat_interval).toBe('daily');
    expect(res.body.repeat_until).toBeTruthy();
  });

  it('rejects repeat_interval without a scheduled_for', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });

    const res = await client.post('/api/v1/posts').send({
      social_account_id: account.body.id,
      content: 'no schedule',
      repeat_interval: 'weekly',
    });
    expect(res.status).toBe(400);
  });

  it('clears repeat_interval via PATCH with null', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    const post = await client.post('/api/v1/posts').send({
      social_account_id: account.body.id,
      content: 'stop repeating',
      scheduled_for: new Date(Date.now() + 60_000).toISOString(),
      repeat_interval: 'daily',
    });

    const res = await client.patch(`/api/v1/posts/${post.body.id}`).send({ repeat_interval: null });
    expect(res.status).toBe(200);
    expect(res.body.repeat_interval).toBeNull();
  });
});

describe('tiktok options', () => {
  async function loginWithTikTok() {
    const client = request.agent(app);
    const email = `tko${Date.now()}${Math.random()}@example.com`;
    await client.post('/api/users').send({ email, password: 'password123' });
    await client.post('/api/auth/login').send({ email, password: 'password123' });
    const { rows } = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       SELECT id, 'tiktok', '@tk', 'open-tk', 'tok' FROM users WHERE email = $1 RETURNING id`,
      [email]
    );
    return { client, tiktokId: rows[0].id };
  }

  const options = {
    privacy_level: 'FOLLOWER_OF_CREATOR',
    allow_comment: true,
    allow_duet: false,
    allow_stitch: true,
    brand_organic: true,
    brand_content: false,
  };

  it('stores tiktok_options on the TikTok post only, not on other cross-posted channels', async () => {
    const { client, tiktokId } = await loginWithTikTok();
    const other = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@a' });

    const res = await client
      .post('/api/v1/posts')
      .field('social_account_ids', String(tiktokId))
      .field('social_account_ids', String(other.body.id))
      .field('content', 'video time')
      .field('tiktok_options', JSON.stringify(options));
    expect(res.status).toBe(201);

    const tk = res.body.posts.find((p) => p.social_account_id === tiktokId);
    const tw = res.body.posts.find((p) => p.social_account_id === other.body.id);
    expect(tk.platform_options).toEqual({ tiktok: options });
    expect(tw.platform_options).toEqual({});
  });

  it('defaults the interaction and disclosure flags to off', async () => {
    const { client, tiktokId } = await loginWithTikTok();
    const res = await client.post('/api/v1/posts').send({
      social_account_id: tiktokId,
      content: 'minimal',
      tiktok_options: { privacy_level: 'SELF_ONLY' },
    });
    expect(res.status).toBe(201);
    expect(res.body.platform_options.tiktok).toEqual({
      privacy_level: 'SELF_ONLY',
      allow_comment: false,
      allow_duet: false,
      allow_stitch: false,
      brand_organic: false,
      brand_content: false,
    });
  });

  it('rejects branded content with a private audience, and an unknown privacy level', async () => {
    const { client, tiktokId } = await loginWithTikTok();
    const branded = await client.post('/api/v1/posts').send({
      social_account_id: tiktokId,
      content: 'sponsored',
      tiktok_options: { privacy_level: 'SELF_ONLY', brand_content: true },
    });
    expect(branded.status).toBe(400);

    const bogus = await client.post('/api/v1/posts').send({
      social_account_id: tiktokId,
      content: 'bogus',
      tiktok_options: { privacy_level: 'EVERYONE_EVERYWHERE' },
    });
    expect(bogus.status).toBe(400);
  });

  it('updates tiktok_options via PATCH', async () => {
    const { client, tiktokId } = await loginWithTikTok();
    const post = await client.post('/api/v1/posts').send({ social_account_id: tiktokId, content: 'draft' });
    expect(post.body.platform_options).toEqual({});

    const res = await client.patch(`/api/v1/posts/${post.body.id}`).send({ tiktok_options: options });
    expect(res.status).toBe(200);
    expect(res.body.platform_options).toEqual({ tiktok: options });
  });
});

describe('youtube options', () => {
  async function loginWithYouTube() {
    const client = request.agent(app);
    const email = `yto${Date.now()}${Math.random()}@example.com`;
    await client.post('/api/users').send({ email, password: 'password123' });
    await client.post('/api/auth/login').send({ email, password: 'password123' });
    const { rows } = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       SELECT id, 'youtube', 'My Channel', 'UC-1', 'tok' FROM users WHERE email = $1 RETURNING id`,
      [email]
    );
    return { client, youtubeId: rows[0].id };
  }

  it('stores youtube_options on the YouTube post only', async () => {
    const { client, youtubeId } = await loginWithYouTube();
    const other = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@a' });
    const options = { title: 'My first upload', privacy_status: 'unlisted', made_for_kids: false };

    const res = await client.post('/api/v1/posts').send({
      social_account_ids: [youtubeId, other.body.id],
      content: 'a longer description',
      youtube_options: options,
      tiktok_options: { privacy_level: 'SELF_ONLY' },
    });
    expect(res.status).toBe(201);
    const yt = res.body.posts.find((p) => p.social_account_id === youtubeId);
    const tw = res.body.posts.find((p) => p.social_account_id === other.body.id);
    // No TikTok channel was targeted, so the TikTok settings are stored nowhere.
    expect(yt.platform_options).toEqual({ youtube: options });
    expect(tw.platform_options).toEqual({});
  });

  it('rejects an invalid title or privacy status', async () => {
    const { client, youtubeId } = await loginWithYouTube();
    const badTitle = await client.post('/api/v1/posts').send({
      social_account_id: youtubeId,
      content: 'x',
      youtube_options: { title: '<b>nope</b>' },
    });
    expect(badTitle.status).toBe(400);

    const longTitle = await client.post('/api/v1/posts').send({
      social_account_id: youtubeId,
      content: 'x',
      youtube_options: { title: 'a'.repeat(101) },
    });
    expect(longTitle.status).toBe(400);

    const badPrivacy = await client.post('/api/v1/posts').send({
      social_account_id: youtubeId,
      content: 'x',
      youtube_options: { privacy_status: 'friends' },
    });
    expect(badPrivacy.status).toBe(400);
  });

  it('merges youtube_options via PATCH without dropping other platform settings', async () => {
    const { client, youtubeId } = await loginWithYouTube();
    const post = await client.post('/api/v1/posts').send({
      social_account_id: youtubeId,
      content: 'draft',
      youtube_options: { title: 'Old title', privacy_status: 'private' },
    });
    await pool.query(`UPDATE posts SET platform_options = platform_options || '{"other": {"x": 1}}' WHERE id = $1`, [
      post.body.id,
    ]);

    const res = await client
      .patch(`/api/v1/posts/${post.body.id}`)
      .send({ youtube_options: { title: 'New title', privacy_status: 'public', made_for_kids: true } });
    expect(res.status).toBe(200);
    expect(res.body.platform_options).toEqual({
      other: { x: 1 },
      youtube: { title: 'New title', privacy_status: 'public', made_for_kids: true },
    });
  });
});
