import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { pool } from '../db/pool.js';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function loginNewUser() {
  const client = request.agent(app);
  const email = `tg${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

const VALID_TOKEN = '123456789:AAHy-Telegram-Bot-Token-abcdefghijklmnop';

// Stubs the two Telegram calls the connect route makes, keyed by method name in the URL.
function mockTelegram({ getMe = { ok: true, result: { username: 'postfalconbot' } }, getChat } = {}) {
  const chat = getChat ?? { ok: true, result: { id: -1001234567890, title: 'My Channel', type: 'channel' } };
  return vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/getMe')) return jsonResponse(getMe, getMe.ok ? 200 : 401);
    if (u.includes('/getChat')) return jsonResponse(chat, chat.ok ? 200 : 400);
    throw new Error(`Unexpected fetch: ${u}`);
  });
}

describe('telegram connect', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/telegram/connect').send({ token: VALID_TOKEN, chat_id: '@x' });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed bot token before calling Telegram', async () => {
    const client = await loginNewUser();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await client.post('/api/telegram/connect').send({ token: 'not-a-token', chat_id: '@x' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stores the channel after verifying the token and chat', async () => {
    const client = await loginNewUser();
    vi.stubGlobal('fetch', mockTelegram());

    const res = await client
      .post('/api/telegram/connect')
      .send({ token: VALID_TOKEN, chat_id: '@mychannel' });
    expect(res.status).toBe(201);
    expect(res.body.display_name).toBe('My Channel');

    const { rows } = await pool.query(
      "SELECT platform, display_name, external_account_id, access_token FROM social_accounts WHERE id = $1",
      [res.body.id]
    );
    expect(rows[0]).toMatchObject({
      platform: 'telegram',
      display_name: 'My Channel',
      external_account_id: '-1001234567890',
      access_token: VALID_TOKEN,
    });
  });

  it('rejects an invalid bot token', async () => {
    const client = await loginNewUser();
    vi.stubGlobal('fetch', mockTelegram({ getMe: { ok: false, description: 'Unauthorized' } }));
    const res = await client.post('/api/telegram/connect').send({ token: VALID_TOKEN, chat_id: '@x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_token');
  });

  it('reports when the bot cannot see the channel', async () => {
    const client = await loginNewUser();
    vi.stubGlobal('fetch', mockTelegram({ getChat: { ok: false, description: 'chat not found' } }));
    const res = await client.post('/api/telegram/connect').send({ token: VALID_TOKEN, chat_id: '@missing' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('chat_unreachable');
  });

  it('reconnecting the same channel updates the token in place', async () => {
    const client = await loginNewUser();
    vi.stubGlobal('fetch', mockTelegram());
    const first = await client.post('/api/telegram/connect').send({ token: VALID_TOKEN, chat_id: '@mychannel' });

    const newToken = '987654321:BBreplacementtokenzzzzzzzzzzzzzzzzzzzz';
    const second = await client.post('/api/telegram/connect').send({ token: newToken, chat_id: '@mychannel' });
    expect(second.body.id).toBe(first.body.id);

    const { rows } = await pool.query('SELECT access_token FROM social_accounts WHERE user_id IS NOT NULL');
    expect(rows).toHaveLength(1);
    expect(rows[0].access_token).toBe(newToken);
  });
});
