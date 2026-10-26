import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logProductEvent } from '../lib/activityLog.js';
import { atAccountLimit } from '../middleware/planLimit.js';

const router = Router();
const API_BASE = 'https://api.telegram.org';

// Bot tokens look like "123456789:AA...<35 url-safe chars>".
const connectSchema = z.object({
  token: z.string().trim().regex(/^\d{6,}:[\w-]{30,}$/, 'that does not look like a Telegram bot token'),
  chat_id: z.string().trim().min(1).max(255),
});

async function callTelegram(token, method, params) {
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.ok === true, result: data.result, description: data.description };
}

// Telegram has no OAuth: the user creates a bot, makes it a channel admin, and hands us its
// token + the channel. We verify both with getMe/getChat before storing anything.
router.post(
  '/connect',
  validate(connectSchema),
  asyncHandler(async (req, res) => {
    const { token, chat_id: chatId } = req.body;

    const me = await callTelegram(token, 'getMe');
    if (!me.ok) {
      return res.status(400).json({ error: 'invalid_token', message: 'Telegram did not accept that bot token.' });
    }

    const chat = await callTelegram(token, 'getChat', { chat_id: chatId });
    if (!chat.ok) {
      return res.status(400).json({
        error: 'chat_unreachable',
        message: `The bot can't see ${chatId}. Add @${me.result.username} to the channel as an admin and try again.`,
      });
    }

    const externalId = String(chat.result.id);
    const displayName = chat.result.title || (chat.result.username ? `@${chat.result.username}` : chatId);

    const existing = await pool.query(
      `SELECT 1 FROM social_accounts WHERE user_id = $1 AND platform = 'telegram' AND external_account_id = $2`,
      [req.user.id, externalId]
    );
    if (existing.rows.length === 0 && (await atAccountLimit(req.user, 'telegram'))) {
      return res.status(402).json({
        error: 'plan_limit',
        message: 'Your plan is at its connected-account limit. Upgrade at /pricing to add more.',
      });
    }

    const result = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, metadata)
       VALUES ($1, 'telegram', $2, $3, $4, $5)
       ON CONFLICT (user_id, platform, external_account_id)
       DO UPDATE SET display_name = EXCLUDED.display_name, access_token = EXCLUDED.access_token, metadata = EXCLUDED.metadata
       RETURNING id, (xmax = 0) AS inserted`,
      [
        req.user.id,
        displayName,
        externalId,
        token,
        JSON.stringify({ botUsername: me.result.username, chatType: chat.result.type }),
      ]
    );
    if (result.rows[0].inserted) {
      await logProductEvent(req.user.id, 'social_account_connected', {
        platform: 'telegram',
        socialAccountId: result.rows[0].id,
      }).catch((err) => req.log.error({ err }, 'failed to record product event'));
    }

    res.status(201).json({ id: result.rows[0].id, display_name: displayName });
  })
);

export default router;
