import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import app from '../app.js';
import { pool } from '../db/pool.js';

const SECRET = 'threads-test-secret';

function signedRequest(payload, secret = SECRET) {
  const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const encoded = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(crypto.createHmac('sha256', secret).update(encoded).digest());
  return `${sig}.${encoded}`;
}

async function threadsAccount(externalId) {
  const user = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
    [`meta${Date.now()}${Math.random()}@example.com`]
  );
  const account = await pool.query(
    `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
     VALUES ($1, 'threads', '@me', $2, 'tok') RETURNING id`,
    [user.rows[0].id, externalId]
  );
  return account.rows[0].id;
}

beforeAll(() => {
  process.env.THREADS_CLIENT_SECRET = SECRET;
});

describe('meta threads callbacks', () => {
  it('rejects a signed_request with a bad signature', async () => {
    await threadsAccount('th-1');
    const res = await request(app)
      .post('/api/meta/threads/uninstall')
      .type('form')
      .send({ signed_request: signedRequest({ user_id: 'th-1' }, 'wrong-secret') });
    expect(res.status).toBe(400);
    const { rows } = await pool.query("SELECT access_token FROM social_accounts WHERE external_account_id = 'th-1'");
    expect(rows[0].access_token).toBe('tok');
  });

  it('uninstall drops the token and flags the account for reconnect', async () => {
    const id = await threadsAccount('th-2');
    const res = await request(app)
      .post('/api/meta/threads/uninstall')
      .type('form')
      .send({ signed_request: signedRequest({ user_id: 'th-2', algorithm: 'HMAC-SHA256' }) });
    expect(res.status).toBe(200);
    const { rows } = await pool.query(
      'SELECT access_token, needs_reconnect_at, reconnect_reason FROM social_accounts WHERE id = $1',
      [id]
    );
    expect(rows[0].access_token).toBe('');
    expect(rows[0].needs_reconnect_at).toBeInstanceOf(Date);
    expect(rows[0].reconnect_reason).toMatch(/removed/);
  });

  it('data deletion deletes the account and returns a confirmation code + status URL', async () => {
    const id = await threadsAccount('th-3');
    const res = await request(app)
      .post('/api/meta/threads/delete')
      .type('form')
      .send({ signed_request: signedRequest({ user_id: 'th-3' }) });
    expect(res.status).toBe(200);
    expect(res.body.confirmation_code).toMatch(/^[0-9a-f]{16}$/);
    expect(res.body.url).toContain(`/api/meta/deletion-status?code=${res.body.confirmation_code}`);
    const { rows } = await pool.query('SELECT 1 FROM social_accounts WHERE id = $1', [id]);
    expect(rows).toHaveLength(0);

    const status = await request(app).get(`/api/meta/deletion-status?code=${res.body.confirmation_code}`);
    expect(status.status).toBe(200);
    expect(status.text).toMatch(/completed/);
  });

  it('400s without a signed_request', async () => {
    const res = await request(app).post('/api/meta/threads/delete').type('form').send({});
    expect(res.status).toBe(400);
  });
});
