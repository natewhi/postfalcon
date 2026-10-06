import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { uploadDir } from '../middleware/upload.js';
import { logProductEvent } from '../lib/activityLog.js';
import { PLATFORMS, PLATFORM_IDS, getAdapter } from '../lib/platforms.js';
import { enforceAccountLimit } from '../middleware/planLimit.js';

const router = Router();

// Platforms with a real connect flow (OAuth, or Telegram's token form) are rejected here:
// manually inserting a row with an arbitrary access_token would bypass that verification and
// let a caller plant a forged/stolen token. Only `connect: 'manual'` stub platforms are
// allowed through. The check is skipped in tests (same NODE_ENV=test pattern
// csrfProtection/apiLimiter use) since the suite seeds OAuth-backed accounts through here.
const createAccountSchema = z.object({
  platform: z.enum(PLATFORM_IDS),
  display_name: z.string().trim().min(1).max(255),
  external_account_id: z.string().trim().max(255).optional(),
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      'SELECT id, platform, display_name, external_account_id, avatar_url, created_at FROM social_accounts WHERE user_id = $1 ORDER BY created_at',
      [req.user.id]
    );
    res.json(result.rows);
  })
);

router.post(
  '/',
  validate(createAccountSchema),
  enforceAccountLimit,
  asyncHandler(async (req, res) => {
    const { platform, display_name, external_account_id, access_token, refresh_token } = req.body;
    const { connect } = PLATFORMS[platform];
    if (connect === 'none') {
      return res.status(400).json({ error: `${platform} isn't available to connect yet` });
    }
    if (connect !== 'manual' && process.env.NODE_ENV !== 'test') {
      return res.status(400).json({ error: `${platform} must be connected through its own flow, not created manually` });
    }
    const result = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, refresh_token)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, platform, display_name, external_account_id, avatar_url, created_at`,
      [req.user.id, platform, display_name, external_account_id ?? null, access_token ?? null, refresh_token ?? null]
    );
    await logProductEvent(req.user.id, 'social_account_connected', {
      platform,
      socialAccountId: result.rows[0].id,
    }).catch((err) => req.log.error({ err }, 'failed to record product event'));
    res.status(201).json(result.rows[0]);
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }

    // posts.social_account_id has ON DELETE CASCADE (which in turn cascades to
    // post_media via posts), so the DELETE below removes this account's posts and
    // their media rows automatically. The uploaded files still need manual
    // cleanup, since a DB cascade can't touch the filesystem.
    const mediaRows = await pool.query(
      `SELECT pm.url FROM post_media pm
       JOIN posts p ON p.id = pm.post_id
       WHERE p.social_account_id = $1 AND p.user_id = $2`,
      [id, req.user.id]
    );

    const result = await pool.query(
      'DELETE FROM social_accounts WHERE id = $1 AND user_id = $2 RETURNING id, platform, access_token, refresh_token',
      [id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not found' });
    }

    await Promise.all(
      mediaRows.rows.map((row) => fs.unlink(path.join(uploadDir, path.basename(row.url))).catch(() => {}))
    );

    // Platforms that support it (currently YouTube) also get the grant withdrawn on their
    // side, not just forgotten here. Best effort: the account is already gone locally.
    const adapter = getAdapter(result.rows[0].platform);
    if (adapter?.revoke) {
      await adapter
        .revoke(result.rows[0])
        .catch((err) => req.log.warn({ err, socialAccountId: id }, 'failed to revoke platform token'));
    }

    await logProductEvent(req.user.id, 'social_account_disconnected', {
      platform: result.rows[0].platform,
      socialAccountId: id,
    }).catch((err) => req.log.error({ err }, 'failed to record product event'));

    res.status(204).end();
  })
);

export default router;
