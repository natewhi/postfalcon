import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { uploadMedia, uploadDir } from '../middleware/upload.js';

const router = Router();

const STATUSES = ['draft', 'scheduled', 'posting', 'posted', 'failed', 'canceled'];

const createPostSchema = z.object({
  social_account_id: z.coerce.number().int().positive(),
  content: z.string().trim().min(1).max(10000),
  scheduled_for: z.string().datetime().optional(),
});

const updatePostSchema = z
  .object({
    content: z.string().trim().min(1).max(10000).optional(),
    scheduled_for: z.string().datetime().nullable().optional(),
    status: z.enum(STATUSES).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'no fields to update' });

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return null;
  }
  return id;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { status } = req.query;
    const params = [req.session.userId];
    let query = 'SELECT * FROM posts WHERE user_id = $1';
    if (status) {
      params.push(status);
      query += ' AND status = $2';
    }
    query += ' ORDER BY scheduled_for NULLS LAST, created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const result = await pool.query('SELECT * FROM posts WHERE id = $1 AND user_id = $2', [id, req.session.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(result.rows[0]);
  })
);

router.post(
  '/',
  uploadMedia.single('media'),
  validate(createPostSchema),
  asyncHandler(async (req, res) => {
    const { social_account_id, content, scheduled_for } = req.body;
    const account = await pool.query('SELECT id FROM social_accounts WHERE id = $1 AND user_id = $2', [
      social_account_id,
      req.session.userId,
    ]);
    if (account.rows.length === 0) {
      return res.status(400).json({ error: 'invalid social_account_id' });
    }
    const status = scheduled_for ? 'scheduled' : 'draft';
    const mediaUrl = req.file ? `${process.env.BASE_URL}/uploads/${req.file.filename}` : null;
    const mediaType = req.file ? (req.file.mimetype.startsWith('video/') ? 'video' : 'image') : null;
    const result = await pool.query(
      `INSERT INTO posts (user_id, social_account_id, content, status, scheduled_for, media_url, media_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.session.userId, social_account_id, content, status, scheduled_for ?? null, mediaUrl, mediaType]
    );
    res.status(201).json(result.rows[0]);
  })
);

router.patch(
  '/:id',
  validate(updatePostSchema),
  asyncHandler(async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const { content, scheduled_for, status } = req.body;
    const fields = [];
    const values = [];
    let i = 1;
    if (content !== undefined) { fields.push(`content = $${i++}`); values.push(content); }
    if (scheduled_for !== undefined) { fields.push(`scheduled_for = $${i++}`); values.push(scheduled_for); }
    if (status !== undefined) { fields.push(`status = $${i++}`); values.push(status); }
    values.push(id, req.session.userId);

    const result = await pool.query(
      `UPDATE posts SET ${fields.join(', ')} WHERE id = $${i} AND user_id = $${i + 1} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(result.rows[0]);
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const result = await pool.query('DELETE FROM posts WHERE id = $1 AND user_id = $2 RETURNING id, media_url', [
      id,
      req.session.userId,
    ]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });

    const { media_url } = result.rows[0];
    if (media_url) {
      await fs.unlink(path.join(uploadDir, path.basename(media_url))).catch(() => {});
    }
    res.status(204).end();
  })
);

export default router;
