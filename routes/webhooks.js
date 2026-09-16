import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { newWebhookSecret } from '../lib/webhooks.js';

const router = Router();

const EVENTS = ['post.published', 'post.failed'];

const createSchema = z.object({
  url: z.string().trim().url().refine((u) => u.startsWith('https://'), 'url must be https'),
  events: z.array(z.enum(EVENTS)).min(1).optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, url, events, active, created_at, last_delivery_at, last_delivery_status
       FROM webhooks WHERE user_id = $1 ORDER BY created_at`,
      [req.user.id]
    );
    res.json(rows);
  })
);

router.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const { url, events } = req.body;
    const secret = newWebhookSecret();
    const result = await pool.query(
      `INSERT INTO webhooks (user_id, url, secret, events)
       VALUES ($1, $2, $3, $4)
       RETURNING id, url, events, active, created_at`,
      [req.user.id, url, secret, events ?? EVENTS]
    );
    // The signing secret is returned only here, on creation.
    res.status(201).json({ ...result.rows[0], secret });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }
    const result = await pool.query('DELETE FROM webhooks WHERE id = $1 AND user_id = $2 RETURNING id', [
      id,
      req.user.id,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not found' });
    }
    res.status(204).end();
  })
);

export default router;
