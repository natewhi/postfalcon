import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logProductEvent } from '../lib/activityLog.js';
import { atAccountLimit } from '../middleware/planLimit.js';

const router = Router();
const PDS = 'https://bsky.social';

// Bluesky app passwords look like "xxxx-xxxx-xxxx-xxxx" (lowercase letters/digits).
const connectSchema = z.object({
  handle: z.string().trim().min(1).max(255),
  app_password: z
    .string()
    .trim()
    .regex(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/i, 'that does not look like a Bluesky app password'),
});

// Bluesky has no OAuth for third-party apps yet: the user generates an app password in their
// own Settings -> App Passwords and hands it to us alongside their handle. We verify both by
// logging in immediately before storing anything.
router.post(
  '/connect',
  validate(connectSchema),
  asyncHandler(async (req, res) => {
    const { handle, app_password: appPassword } = req.body;

    const sessionRes = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: handle, password: appPassword }),
    });
    const session = await sessionRes.json().catch(() => ({}));
    if (!sessionRes.ok || !session.did) {
      return res.status(400).json({
        error: 'invalid_credentials',
        message: 'Bluesky did not accept that handle and app password.',
      });
    }

    const externalId = session.did;
    const displayName = session.handle ? `@${session.handle}` : handle;

    const existing = await pool.query(
      `SELECT 1 FROM social_accounts WHERE user_id = $1 AND platform = 'bluesky' AND external_account_id = $2`,
      [req.user.id, externalId]
    );
    if (existing.rows.length === 0 && (await atAccountLimit(req.user, 'bluesky'))) {
      return res.status(402).json({
        error: 'plan_limit',
        message: 'Your plan is at its connected-account limit. Upgrade at /pricing to add more.',
      });
    }

    const result = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token)
       VALUES ($1, 'bluesky', $2, $3, $4)
       ON CONFLICT (user_id, platform, external_account_id)
       DO UPDATE SET display_name = EXCLUDED.display_name, access_token = EXCLUDED.access_token
       RETURNING id, (xmax = 0) AS inserted`,
      [req.user.id, displayName, externalId, appPassword]
    );
    if (result.rows[0].inserted) {
      await logProductEvent(req.user.id, 'social_account_connected', {
        platform: 'bluesky',
        socialAccountId: result.rows[0].id,
      }).catch((err) => req.log.error({ err }, 'failed to record product event'));
    }

    res.status(201).json({ id: result.rows[0].id, display_name: displayName });
  })
);

export default router;
