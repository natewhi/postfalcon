import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

const PLATFORMS = ['twitter', 'instagram', 'facebook', 'linkedin', 'tiktok', 'threads', 'mastodon'];

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
      'SELECT id, platform, display_name, external_account_id, created_at FROM social_accounts WHERE user_id = $1 ORDER BY created_at',
      [req.session.userId]
    );
    res.json(result.rows);
  })
);

router.post(
  '/',
  validate(createAccountSchema),
  asyncHandler(async (req, res) => {
    const { platform, display_name, external_account_id, access_token, refresh_token } = req.body;
    const result = await pool.query(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, refresh_token)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, platform, display_name, external_account_id, created_at`,
      [req.session.userId, platform, display_name, external_account_id ?? null, access_token ?? null, refresh_token ?? null]
    );
    res.status(201).json(result.rows[0]);
  })
);

export default router;
