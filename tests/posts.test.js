import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import app from '../app.js';
import { uploadDir } from '../middleware/upload.js';

async function loginNewUser() {
  const client = request.agent(app);
  const email = `user${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

describe('posts', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/posts');
    expect(res.status).toBe(401);
  });

  it('creates a draft post when no schedule is given, and lists it', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    expect(account.status).toBe(201);

    const post = await client.post('/api/posts').send({
      social_account_id: account.body.id,
      content: 'hello world',
    });
    expect(post.status).toBe(201);
    expect(post.body.status).toBe('draft');

    const list = await client.get('/api/posts');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
  });

  it('creates a scheduled post when scheduled_for is given', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    const scheduledFor = new Date(Date.now() + 60_000).toISOString();

    const post = await client.post('/api/posts').send({
      social_account_id: account.body.id,
      content: 'hello world',
      scheduled_for: scheduledFor,
    });
    expect(post.status).toBe(201);
    expect(post.body.status).toBe('scheduled');
  });

  it('rejects a post with empty content', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/social-accounts').send({ platform: 'twitter', display_name: '@me' });

    const res = await client.post('/api/posts').send({ social_account_id: account.body.id, content: '' });
    expect(res.status).toBe(400);
  });

  it('rejects posting against a social account owned by another user', async () => {
    const clientA = await loginNewUser();
    const clientB = await loginNewUser();
    const accountA = await clientA.post('/api/social-accounts').send({ platform: 'twitter', display_name: '@a' });

    const res = await clientB.post('/api/posts').send({ social_account_id: accountA.body.id, content: 'sneaky' });
    expect(res.status).toBe(400);
  });

  it('does not allow reading another user\'s post by id', async () => {
    const clientA = await loginNewUser();
    const clientB = await loginNewUser();
    const account = await clientA.post('/api/social-accounts').send({ platform: 'twitter', display_name: '@a' });
    const post = await clientA.post('/api/posts').send({ social_account_id: account.body.id, content: 'private' });

    const res = await clientB.get(`/api/posts/${post.body.id}`);
    expect(res.status).toBe(404);
  });

  it('deletes a post', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    const post = await client.post('/api/posts').send({ social_account_id: account.body.id, content: 'bye' });

    const del = await client.delete(`/api/posts/${post.body.id}`);
    expect(del.status).toBe(204);

    const get = await client.get(`/api/posts/${post.body.id}`);
    expect(get.status).toBe(404);
  });

  it('accepts an image upload and stores media_url/media_type', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/social-accounts').send({ platform: 'twitter', display_name: '@me' });

    const post = await client
      .post('/api/posts')
      .field('social_account_id', String(account.body.id))
      .field('content', 'post with image')
      .attach('media', Buffer.from('fake-image-bytes'), 'photo.jpg');

    expect(post.status).toBe(201);
    expect(post.body.media_type).toBe('image');
    expect(post.body.media_url).toMatch(/\/uploads\//);
  });

  it('rejects a disallowed file type', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/social-accounts').send({ platform: 'twitter', display_name: '@me' });

    const res = await client
      .post('/api/posts')
      .field('social_account_id', String(account.body.id))
      .field('content', 'post with bad file')
      .attach('media', Buffer.from('not a real file'), 'malware.exe');

    expect(res.status).toBe(400);
  });

  it('deletes the uploaded file from disk when the post is deleted', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/social-accounts').send({ platform: 'twitter', display_name: '@me' });

    const post = await client
      .post('/api/posts')
      .field('social_account_id', String(account.body.id))
      .field('content', 'post with image to delete')
      .attach('media', Buffer.from('fake-image-bytes'), 'photo2.jpg');

    const filePath = path.join(uploadDir, path.basename(post.body.media_url));
    expect(fs.existsSync(filePath)).toBe(true);

    await client.delete(`/api/posts/${post.body.id}`);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
