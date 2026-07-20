import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { uploadDir } from '../middleware/upload.js';

const router = Router();

const PLATFORMS = ['twitter', 'instagram', 'facebook', 'linkedin', 'tiktok', 'threads', 'mastodon'];

// facebook/instagram (routes/facebook.js) and mastodon (routes/mastodon.js) all have real OAuth
// connect flows now — this generic endpoint manually inserting a row with an arbitrary
// access_token would let a client (or a public API caller) bypass that OAuth entirely and plant
// a forged/stolen token. Left open for the platforms that don't have an OAuth flow yet. Skipped
// in tests (same NODE_ENV=test pattern csrfProtection/apiLimiter already use) since the test
// suite creates OAuth-backed accounts directly through this endpoint as fixture setup.
const OAUTH_PLATFORMS = ['facebook', 'instagram', 'mastodon'];

const createAccountSchema = z.object({
  platform: z.enum(PLATFORMS),
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
  asyncHandler(async (req, res) => {
    const { platform, display_name, external_account_id, access_token, refresh_token } = req.body;
    if (OAUTH_PLATFORMS.includes(platform) && process.env.NODE_ENV !== 'test') {
      return res.status(400).json({ error: `${platform} accounts must be connected via OAuth, not created manually` });
    }
    const result = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, refresh_token)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, platform, display_name, external_account_id, avatar_url, created_at`,
      [req.user.id, platform, display_name, external_account_id ?? null, access_token ?? null, refresh_token ?? null]
    );
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

    const result = await pool.query('DELETE FROM social_accounts WHERE id = $1 AND user_id = $2 RETURNING id', [
      id,
      req.user.id,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not found' });
    }

    await Promise.all(
      mediaRows.rows.map((row) => fs.unlink(path.join(uploadDir, path.basename(row.url))).catch(() => {}))
    );

    res.status(204).end();
  })
);

export default router;
