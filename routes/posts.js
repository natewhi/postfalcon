import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { uploadMedia, uploadDir } from '../middleware/upload.js';
import { logProductEvent } from '../lib/activityLog.js';

const router = Router();

const STATUSES = ['draft', 'scheduled', 'posting', 'posted', 'failed', 'canceled'];
const MAX_MEDIA_PER_POST = 10;

const futureDateRefinement = (val) => !val || new Date(val).getTime() > Date.now();
const futureDateMessage = { message: 'must be in the future' };

const createPostSchema = z.object({
  social_account_id: z.coerce.number().int().positive(),
  content: z.string().trim().min(1).max(10000),
  scheduled_for: z.string().datetime().optional().refine(futureDateRefinement, futureDateMessage),
  alt_texts: z.string().optional(),
});

const updatePostSchema = z
  .object({
    content: z.string().trim().min(1).max(10000).optional(),
    scheduled_for: z.string().datetime().nullable().optional().refine(futureDateRefinement, futureDateMessage),
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

async function attachMedia(posts) {
  if (posts.length === 0) return posts;
  const mediaResult = await pool.query('SELECT * FROM post_media WHERE post_id = ANY($1) ORDER BY position', [
    posts.map((p) => p.id),
  ]);
  const byPost = new Map();
  for (const row of mediaResult.rows) {
    if (!byPost.has(row.post_id)) byPost.set(row.post_id, []);
    byPost.get(row.post_id).push(row);
  }
  for (const post of posts) {
    post.media = byPost.get(post.id) || [];
  }
  return posts;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { status, social_account_id } = req.query;
    const params = [req.user.id];
    let query = `
      SELECT posts.*, social_accounts.platform, social_accounts.display_name AS account_display_name
      FROM posts
      JOIN social_accounts ON social_accounts.id = posts.social_account_id
      WHERE posts.user_id = $1
    `;
    if (status) {
      const statuses = String(status)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (statuses.length === 1) {
        params.push(statuses[0]);
        query += ` AND posts.status = $${params.length}`;
      } else if (statuses.length > 1) {
        params.push(statuses);
        query += ` AND posts.status = ANY($${params.length})`;
      }
    }
    if (social_account_id) {
      params.push(social_account_id);
      query += ` AND posts.social_account_id = $${params.length}`;
    }
    query += ' ORDER BY posts.scheduled_for NULLS LAST, posts.created_at DESC';
    const result = await pool.query(query, params);
    res.json(await attachMedia(result.rows));
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const result = await pool.query('SELECT * FROM posts WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
    const [post] = await attachMedia(result.rows);
    res.json(post);
  })
);

router.post(
  '/',
  uploadMedia.array('media', MAX_MEDIA_PER_POST),
  validate(createPostSchema),
  asyncHandler(async (req, res) => {
    const { social_account_id, content, scheduled_for, alt_texts } = req.body;
    const account = await pool.query('SELECT id FROM social_accounts WHERE id = $1 AND user_id = $2', [
      social_account_id,
      req.user.id,
    ]);
    if (account.rows.length === 0) {
      return res.status(400).json({ error: 'invalid social_account_id' });
    }

    let altTextList = [];
    if (alt_texts) {
      try {
        const parsed = JSON.parse(alt_texts);
        if (Array.isArray(parsed)) altTextList = parsed;
      } catch {
        // malformed alt text payload — post still goes through, just without alt text
      }
    }

    const status = scheduled_for ? 'scheduled' : 'draft';
    const result = await pool.query(
      `INSERT INTO posts (user_id, social_account_id, content, status, scheduled_for)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.id, social_account_id, content, status, scheduled_for ?? null]
    );
    const post = result.rows[0];

    const files = req.files || [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const mediaType = file.mimetype.startsWith('video/') ? 'video' : 'image';
      const url = `${process.env.BASE_URL}/uploads/${file.filename}`;
      const altText = typeof altTextList[i] === 'string' && altTextList[i].trim() ? altTextList[i].trim().slice(0, 1000) : null;
      await pool.query(
        'INSERT INTO post_media (post_id, url, media_type, alt_text, position) VALUES ($1, $2, $3, $4, $5)',
        [post.id, url, mediaType, altText, i]
      );
    }

    await logProductEvent(req.user.id, 'post_created', {
      postId: post.id,
      socialAccountId: post.social_account_id,
      status: post.status,
      hasMedia: files.length > 0,
    }).catch((err) => req.log.error({ err }, 'failed to record product event'));

    const [full] = await attachMedia([post]);
    res.status(201).json(full);
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
    values.push(id, req.user.id);

    const result = await pool.query(
      `UPDATE posts SET ${fields.join(', ')} WHERE id = $${i} AND user_id = $${i + 1} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
    const [post] = await attachMedia(result.rows);

    // Only fires when the client explicitly set status to 'scheduled' in this request —
    // not on every edit of an already-scheduled post's content.
    if (status === 'scheduled') {
      await logProductEvent(req.user.id, 'post_scheduled', {
        postId: post.id,
        socialAccountId: post.social_account_id,
      }).catch((err) => req.log.error({ err }, 'failed to record product event'));
    }

    res.json(post);
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;

    const mediaRows = await pool.query('SELECT url FROM post_media WHERE post_id = $1', [id]);

    const result = await pool.query('DELETE FROM posts WHERE id = $1 AND user_id = $2 RETURNING id', [
      id,
      req.user.id,
    ]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });

    await Promise.all(
      mediaRows.rows.map((row) => fs.unlink(path.join(uploadDir, path.basename(row.url))).catch(() => {}))
    );

    await logProductEvent(req.user.id, 'post_deleted', { postId: id }).catch((err) =>
      req.log.error({ err }, 'failed to record product event')
    );

    res.status(204).end();
  })
);

export default router;
