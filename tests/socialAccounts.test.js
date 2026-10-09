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

describe('social account creation — platform registry', () => {
  it('accepts a platform that is connected manually', async () => {
    const client = await loginNewUser();
    const res = await client
      .post('/api/v1/social-accounts')
      .send({ platform: 'reddit', display_name: 'My Page' });
    expect(res.status).toBe(201);
    expect(res.body.platform).toBe('reddit');
  });

  it('rejects a platform that must be connected via OAuth', async () => {
    const client = await loginNewUser();
    // NODE_ENV=test bypasses the OAuth guard so the suite can seed accounts, so assert the
    // registry entry directly instead.
    const { PLATFORMS } = await import('../lib/platforms.js');
    expect(PLATFORMS.youtube.connect).toBe('oauth');
    expect(PLATFORMS.tiktok.connect).toBe('oauth');
  });

  // The registry currently has no `connect: 'none'` entry (the chat apps that used to be the
  // only example — whatsapp/wechat/messenger/snapchat/douyin — were removed; see
  // lib/platforms.js), so there's no live fixture for the "no way to connect" 400 branch in
  // routes/socialAccounts.js right now. The code path stays in place for the next platform
  // that turns out to have no public API.

  it('rejects an unknown platform', async () => {
    const client = await loginNewUser();
    const res = await client
      .post('/api/v1/social-accounts')
      .send({ platform: 'myspace', display_name: 'tom' });
    expect(res.status).toBe(400);
  });
});

describe('social account connection status', () => {
  async function loginWithAccount(columns) {
    const client = request.agent(app);
    const email = `sacs${Date.now()}${Math.random()}@example.com`;
    await client.post('/api/users').send({ email, password: 'password123' });
    await client.post('/api/auth/login').send({ email, password: 'password123' });
    const { rows } = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, refresh_token, token_expires_at)
       SELECT id, 'linkedin', 'Alice', 'li-x', 'tok', $2, $3 FROM users WHERE email = $1 RETURNING id`,
      [email, columns.refresh_token ?? null, columns.token_expires_at ?? null]
    );
    return { client, accountId: rows[0].id };
  }

  it('reports needs_reconnect and expires_soon on the list', async () => {
    const { client, accountId } = await loginWithAccount({ token_expires_at: new Date(Date.now() + 2 * 86400000) });
    await pool.query(`UPDATE social_accounts SET needs_reconnect_at = now(), reconnect_reason = 'revoked' WHERE id = $1`, [
      accountId,
    ]);

    const res = await client.get('/api/v1/social-accounts');
    expect(res.body[0].needs_reconnect_at).toBeTruthy();
    expect(res.body[0].reconnect_reason).toBe('revoked');
    expect(res.body[0].expires_soon).toBe(true);
  });

  it('does not mark a refreshable token as expiring', async () => {
    const { client } = await loginWithAccount({
      refresh_token: 'rt',
      token_expires_at: new Date(Date.now() + 3600000),
    });
    const res = await client.get('/api/v1/social-accounts');
    expect(res.body[0].expires_soon).toBe(false);
  });

  it('clears the reconnect flag when the account gets a new token', async () => {
    const { accountId } = await loginWithAccount({});
    await pool.query(`UPDATE social_accounts SET needs_reconnect_at = now(), reconnect_reason = 'x' WHERE id = $1`, [
      accountId,
    ]);
    await pool.query(`UPDATE social_accounts SET access_token = 'fresh' WHERE id = $1`, [accountId]);
    const { rows } = await pool.query('SELECT needs_reconnect_at, reconnect_reason FROM social_accounts WHERE id = $1', [
      accountId,
    ]);
    expect(rows[0]).toEqual({ needs_reconnect_at: null, reconnect_reason: null });
  });
});
