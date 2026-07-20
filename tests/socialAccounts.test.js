import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import app from '../app.js';
import { pool } from '../db/pool.js';
import { uploadDir } from '../middleware/upload.js';

async function loginNewUser() {
  const client = request.agent(app);
  const email = `sa${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

describe('social account deletion', () => {
  it('requires authentication', async () => {
    const res = await request(app).delete('/api/v1/social-accounts/1');
    expect(res.status).toBe(401);
  });

  it('404s for a nonexistent account', async () => {
    const client = await loginNewUser();
    const res = await client.delete('/api/v1/social-accounts/999999');
    expect(res.status).toBe(404);
  });

  it("does not allow deleting another user's account", async () => {
    const clientA = await loginNewUser();
    const clientB = await loginNewUser();
    const account = await clientA.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@a' });

    const res = await clientB.delete(`/api/v1/social-accounts/${account.body.id}`);
    expect(res.status).toBe(404);

    const stillThere = await clientA.get('/api/v1/social-accounts');
    expect(stillThere.body).toHaveLength(1);
  });

  it('deletes the account, cascades its posts, and cleans up uploaded media', async () => {
    const client = await loginNewUser();
    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });

    const textPost = await client
      .post('/api/v1/posts')
      .send({ social_account_id: account.body.id, content: 'no media here' });
    const mediaPost = await client
      .post('/api/v1/posts')
      .field('social_account_id', String(account.body.id))
      .field('content', 'a post with a photo')
      .attach('media', Buffer.from('fake-image-bytes'), 'photo.jpg');
    const filePath = path.join(uploadDir, path.basename(mediaPost.body.media[0].url));
    expect(fs.existsSync(filePath)).toBe(true);

    const del = await client.delete(`/api/v1/social-accounts/${account.body.id}`);
    expect(del.status).toBe(204);

    const accounts = await client.get('/api/v1/social-accounts');
    expect(accounts.body).toHaveLength(0);

    const { rows } = await pool.query('SELECT id FROM posts WHERE id = ANY($1)', [
      [textPost.body.id, mediaPost.body.id],
    ]);
    expect(rows).toHaveLength(0);

    expect(fs.existsSync(filePath)).toBe(false);
  });
});
