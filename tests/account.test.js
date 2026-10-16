import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import app from '../app.js';
import { pool } from '../db/pool.js';
import { sendMail } from '../lib/mailer.js';
import { uploadDir } from '../middleware/upload.js';

beforeEach(() => {
  sendMail.mockClear();
});

function extractToken(mailCall) {
  const [{ text }] = mailCall;
  const url = new URL(text.match(/https?:\/\/\S+/)[0]);
  return url.searchParams.get('token');
}

describe('password reset', () => {
  it('sends a reset email and lets the user set a new password', async () => {
    const email = 'reset1@example.com';
    await request(app).post('/api/users').send({ email, password: 'password123' });
    sendMail.mockClear();

    const forgotRes = await request(app).post('/api/auth/forgot-password').send({ email });
    expect(forgotRes.status).toBe(204);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const token = extractToken(sendMail.mock.calls[0]);
    expect(token).toBeTruthy();

    const resetRes = await request(app).post('/api/auth/reset-password').send({ token, password: 'newpassword456' });
    expect(resetRes.status).toBe(204);

    const loginOk = await request(app).post('/api/auth/login').send({ email, password: 'newpassword456' });
    expect(loginOk.status).toBe(200);

    const loginOld = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
    expect(loginOld.status).toBe(401);
  });

  it('does not reveal whether an email is registered', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'nonexistent@example.com' });
    expect(res.status).toBe(204);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('rejects an invalid reset token', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({ token: 'not-a-real-token', password: 'password123' });
    expect(res.status).toBe(400);
  });

  it('rejects reusing an already-consumed reset token', async () => {
    const email = 'reset2@example.com';
    await request(app).post('/api/users').send({ email, password: 'password123' });
    sendMail.mockClear();
    await request(app).post('/api/auth/forgot-password').send({ email });
    const token = extractToken(sendMail.mock.calls[0]);

    const first = await request(app).post('/api/auth/reset-password').send({ token, password: 'newpassword456' });
    expect(first.status).toBe(204);

    const second = await request(app).post('/api/auth/reset-password').send({ token, password: 'anotherpassword789' });
    expect(second.status).toBe(400);
  });
});

describe('email verification', () => {
  it('sends a verification email on signup and verifies via the link', async () => {
    const email = 'verify1@example.com';
    await request(app).post('/api/users').send({ email, password: 'password123' });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const token = extractToken(sendMail.mock.calls[0]);

    const res = await request(app).get(`/api/auth/verify-email?token=${token}`);
    expect(res.status).toBe(302);

    const { rows } = await pool.query('SELECT email_verified_at FROM users WHERE email = $1', [email]);
    expect(rows[0].email_verified_at).not.toBeNull();
  });

  it('still creates the account when the verification email fails to send', async () => {
    const email = 'verify-smtp-down@example.com';
    sendMail.mockRejectedValueOnce(new Error('SMTP connection refused'));
    const res = await request(app).post('/api/users').send({ email, password: 'password123' });
    expect(res.status).toBe(201);

    const { rows } = await pool.query('SELECT email_verified_at FROM users WHERE email = $1', [email]);
    expect(rows).toHaveLength(1);
    expect(rows[0].email_verified_at).toBeNull();
  });

  it('rejects an invalid verification token', async () => {
    const res = await request(app).get('/api/auth/verify-email?token=not-real');
    expect(res.status).toBe(400);
  });

  it('lets a logged-in user resend their verification email', async () => {
    const client = request.agent(app);
    const email = 'verify2@example.com';
    await client.post('/api/users').send({ email, password: 'password123' });
    await client.post('/api/auth/login').send({ email, password: 'password123' });
    sendMail.mockClear();

    const res = await client.post('/api/auth/resend-verification');
    expect(res.status).toBe(204);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('requires authentication to resend verification', async () => {
    const res = await request(app).post('/api/auth/resend-verification');
    expect(res.status).toBe(401);
  });
});

describe('change password', () => {
  it('changes the password when the current one is correct', async () => {
    const client = request.agent(app);
    const email = 'changepw1@example.com';
    await client.post('/api/users').send({ email, password: 'password123' });
    await client.post('/api/auth/login').send({ email, password: 'password123' });

    const res = await client
      .post('/api/auth/change-password')
      .send({ currentPassword: 'password123', newPassword: 'newpassword456' });
    expect(res.status).toBe(204);

    const loginOld = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
    expect(loginOld.status).toBe(401);

    const loginNew = await request(app).post('/api/auth/login').send({ email, password: 'newpassword456' });
    expect(loginNew.status).toBe(200);
  });

  it('rejects the wrong current password', async () => {
    const client = request.agent(app);
    const email = 'changepw2@example.com';
    await client.post('/api/users').send({ email, password: 'password123' });
    await client.post('/api/auth/login').send({ email, password: 'password123' });

    const res = await client
      .post('/api/auth/change-password')
      .send({ currentPassword: 'wrongpassword', newPassword: 'newpassword456' });
    expect(res.status).toBe(401);
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: 'x', newPassword: 'newpassword456' });
    expect(res.status).toBe(401);
  });

  it('invalidates other sessions but keeps the current one', async () => {
    const email = 'changepw3@example.com';
    await request(app).post('/api/users').send({ email, password: 'password123' });

    const clientA = request.agent(app);
    await clientA.post('/api/auth/login').send({ email, password: 'password123' });
    const clientB = request.agent(app);
    await clientB.post('/api/auth/login').send({ email, password: 'password123' });

    expect((await clientA.get('/api/auth/me')).status).toBe(200);
    expect((await clientB.get('/api/auth/me')).status).toBe(200);

    const res = await clientA
      .post('/api/auth/change-password')
      .send({ currentPassword: 'password123', newPassword: 'newpassword456' });
    expect(res.status).toBe(204);

    expect((await clientA.get('/api/auth/me')).status).toBe(200);
    expect((await clientB.get('/api/auth/me')).status).toBe(401);
  });

  it('sends a notification email', async () => {
    const client = request.agent(app);
    const email = 'changepw4@example.com';
    await client.post('/api/users').send({ email, password: 'password123' });
    await client.post('/api/auth/login').send({ email, password: 'password123' });
    sendMail.mockClear();

    await client
      .post('/api/auth/change-password')
      .send({ currentPassword: 'password123', newPassword: 'newpassword456' });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe(email);
  });
});

describe('delete account', () => {
  it('rejects the wrong password', async () => {
    const client = request.agent(app);
    const email = 'delete1@example.com';
    await client.post('/api/users').send({ email, password: 'password123' });
    await client.post('/api/auth/login').send({ email, password: 'password123' });

    const res = await client.post('/api/auth/delete-account').send({ password: 'wrongpassword' });
    expect(res.status).toBe(401);
  });

  it('deletes the user, their data, and uploaded media, then logs them out', async () => {
    const client = request.agent(app);
    const email = 'delete2@example.com';
    await client.post('/api/users').send({ email, password: 'password123' });
    await client.post('/api/auth/login').send({ email, password: 'password123' });

    const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });
    const post = await client
      .post('/api/v1/posts')
      .field('social_account_id', String(account.body.id))
      .field('content', 'a post with a photo')
      .attach('media', Buffer.from('fake-image-bytes'), 'photo.jpg');
    const filePath = path.join(uploadDir, path.basename(post.body.media[0].url));
    await expect(fs.access(filePath)).resolves.toBeUndefined();

    const res = await client.post('/api/auth/delete-account').send({ password: 'password123' });
    expect(res.status).toBe(204);

    const { rows: userRows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    expect(userRows).toHaveLength(0);

    const { rows: accountRows } = await pool.query('SELECT id FROM social_accounts WHERE id = $1', [account.body.id]);
    expect(accountRows).toHaveLength(0);

    await expect(fs.access(filePath)).rejects.toThrow();

    const me = await client.get('/api/auth/me');
    expect(me.status).toBe(401);
  });

  it('sends a notification email', async () => {
    const client = request.agent(app);
    const email = 'delete3@example.com';
    await client.post('/api/users').send({ email, password: 'password123' });
    await client.post('/api/auth/login').send({ email, password: 'password123' });
    sendMail.mockClear();

    const res = await client.post('/api/auth/delete-account').send({ password: 'password123' });
    expect(res.status).toBe(204);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe(email);
  });
});
