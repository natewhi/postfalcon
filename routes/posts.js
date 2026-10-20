import { Router } from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { uploadMedia } from '../middleware/upload.js';
import { storeUploadedFile, copyMedia, deleteMedia, mediaUrl } from '../lib/storage.js';
import { logProductEvent } from '../lib/activityLog.js';
import { enforceScheduledPostLimit } from '../middleware/planLimit.js';
import { planHasCapability } from '../lib/billing.js';

const router = Router();

const STATUSES = ['draft', 'scheduled', 'posting', 'posted', 'failed', 'canceled'];
const REPEAT_INTERVALS = ['daily', 'weekly', 'monthly'];
const MAX_MEDIA_PER_POST = 10;

const futureDateRefinement = (val) => !val || new Date(val).getTime() > Date.now();
const futureDateMessage = { message: 'must be in the future' };

// social_account_ids accepts a JSON array, a repeated multipart field, or a single value.
const accountIds = z
  .union([
    z.array(z.coerce.number().int().positive()).min(1).max(30),
    z.coerce.number().int().positive().transform((n) => [n]),
  ])
  .optional();

// Per-platform post settings arrive as a JSON string in multipart creates, or as an object
// in JSON bodies.
function jsonOptions(schema) {
  return z
    .preprocess((v) => {
      if (typeof v !== 'string') return v;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }, schema)
    .optional();
}

const TIKTOK_PRIVACY_LEVELS = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];

// TikTok's Content Sharing Guidelines make these the user's explicit choice per post (see
// lib/platforms/tiktok.js resolvePostInfo).
const tiktokOptions = jsonOptions(
  z
    .object({
      privacy_level: z.enum(TIKTOK_PRIVACY_LEVELS).optional(),
      allow_comment: z.boolean().default(false),
      allow_duet: z.boolean().default(false),
      allow_stitch: z.boolean().default(false),
      brand_organic: z.boolean().default(false),
      brand_content: z.boolean().default(false),
    })
    .refine((o) => !(o.brand_content && o.privacy_level === 'SELF_ONLY'), {
      message: 'branded content cannot be private',
    })
);

// YouTube's upload settings, chosen per post in the composer (see lib/platforms/youtube.js).
const youtubeOptions = jsonOptions(
  z.object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((t) => !/[<>]/.test(t), { message: "can't contain < or >" })
      .optional(),
    privacy_status: z.enum(['public', 'unlisted', 'private']).optional(),
    made_for_kids: z.boolean().default(false),
  })
);

// Which request field carries each platform's per-post settings. A cross-post stores each
// platform's settings only on that platform's posts.
const PLATFORM_OPTION_FIELDS = { tiktok: 'tiktok_options', youtube: 'youtube_options' };

function platformOptionsFor(platform, body) {
  const field = PLATFORM_OPTION_FIELDS[platform];
  return field && body[field] ? { [platform]: body[field] } : {};
}

const createPostSchema = z
  .object({
    social_account_id: z.coerce.number().int().positive().optional(),
    social_account_ids: accountIds,
    content: z.string().trim().min(1).max(10000),
    scheduled_for: z.string().datetime().optional().refine(futureDateRefinement, futureDateMessage),
    repeat_interval: z.enum(REPEAT_INTERVALS).optional(),
    repeat_until: z.string().datetime().optional().refine(futureDateRefinement, futureDateMessage),
    alt_texts: z.string().optional(),
    tiktok_options: tiktokOptions,
    youtube_options: youtubeOptions,
  })
  .refine((d) => d.social_account_id || (d.social_account_ids && d.social_account_ids.length), {
    message: 'social_account_id or social_account_ids is required',
  })
  .refine((d) => !d.repeat_interval || d.scheduled_for, {
    message: 'repeat_interval needs a scheduled_for',
  });

const updatePostSchema = z
  .object({
    content: z.string().trim().min(1).max(10000).optional(),
    scheduled_for: z.string().datetime().nullable().optional().refine(futureDateRefinement, futureDateMessage),
    status: z.enum(STATUSES).optional(),
    repeat_interval: z.enum(REPEAT_INTERVALS).nullable().optional(),
    repeat_until: z.string().datetime().nullable().optional().refine(futureDateRefinement, futureDateMessage),
    tiktok_options: tiktokOptions,
    youtube_options: youtubeOptions,
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'no fields to update' });

async function copyMediaFile(url) {
  return mediaUrl(await copyMedia(path.basename(url)));
}

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
  enforceScheduledPostLimit,
  asyncHandler(async (req, res) => {
    const {
      social_account_id,
      social_account_ids,
      content,
      scheduled_for,
      repeat_interval,
      repeat_until,
      alt_texts,
    } = req.body;

    const requestedIds = [...new Set(social_account_ids ?? [social_account_id])];
    if (requestedIds.length > 1 && !planHasCapability(req.user.plan, 'crossPosting')) {
      return res.status(402).json({ error: 'plan_capability', message: 'Cross-posting is not available on your plan.' });
    }

    const owned = await pool.query(
      'SELECT id, platform FROM social_accounts WHERE id = ANY($1) AND user_id = $2',
      [requestedIds, req.user.id]
    );
    const targetIds = owned.rows.map((r) => r.id);
    const platformById = new Map(owned.rows.map((r) => [r.id, r.platform]));
    if (targetIds.length === 0) {
      return res.status(400).json({ error: 'invalid social_account_id' });
    }

    if (repeat_interval && !planHasCapability(req.user.plan, 'repeatedPosts')) {
      return res.status(402).json({ error: 'plan_capability', message: 'Recurring posts are not available on your plan.' });
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
    const groupId = targetIds.length > 1 ? crypto.randomUUID() : null;
    const files = req.files || [];
    await Promise.all(files.map(storeUploadedFile));
    const baseMedia = files.map((file, i) => ({
      url: mediaUrl(file.filename),
      media_type: file.mimetype.startsWith('video/') ? 'video' : 'image',
      alt_text:
        typeof altTextList[i] === 'string' && altTextList[i].trim() ? altTextList[i].trim().slice(0, 1000) : null,
      position: i,
    }));

    const created = [];
    for (let n = 0; n < targetIds.length; n++) {
      const accId = targetIds[n];
      const platformOptions = platformOptionsFor(platformById.get(accId), req.body);
      const { rows } = await pool.query(
        `INSERT INTO posts
           (user_id, social_account_id, content, status, scheduled_for, repeat_interval, repeat_until, crosspost_group_id,
            platform_options)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          req.user.id,
          accId,
          content,
          status,
          scheduled_for ?? null,
          repeat_interval ?? null,
          repeat_until ?? null,
          groupId,
          platformOptions,
        ]
      );
      const post = rows[0];
      for (const m of baseMedia) {
        // The first post keeps the uploaded files; the rest get their own copies so media
        // cleanup on one post can't delete a file another still references.
        const url = n === 0 ? m.url : await copyMediaFile(m.url);
        await pool.query(
          'INSERT INTO post_media (post_id, url, media_type, alt_text, position) VALUES ($1, $2, $3, $4, $5)',
          [post.id, url, m.media_type, m.alt_text, m.position]
        );
      }
      created.push(post);
    }

    await logProductEvent(req.user.id, 'post_created', {
      postId: created[0].id,
      status,
      channels: targetIds.length,
      hasMedia: files.length > 0,
      repeating: Boolean(repeat_interval),
    }).catch((err) => req.log.error({ err }, 'failed to record product event'));

    const full = await attachMedia(created);
    if (groupId) {
      return res.status(201).json({ crosspost_group_id: groupId, posts: full });
    }
    res.status(201).json(full[0]);
  })
);

router.patch(
  '/:id',
  validate(updatePostSchema),
  enforceScheduledPostLimit,
  asyncHandler(async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const { content, scheduled_for, status, repeat_interval, repeat_until } = req.body;
    if (repeat_interval && !planHasCapability(req.user.plan, 'repeatedPosts')) {
      return res.status(402).json({ error: 'plan_capability', message: 'Recurring posts are not available on your plan.' });
    }
    const fields = [];
    const values = [];
    let i = 1;
    if (content !== undefined) { fields.push(`content = $${i++}`); values.push(content); }
    if (scheduled_for !== undefined) { fields.push(`scheduled_for = $${i++}`); values.push(scheduled_for); }
    if (status !== undefined) { fields.push(`status = $${i++}`); values.push(status); }
    if (repeat_interval !== undefined) { fields.push(`repeat_interval = $${i++}`); values.push(repeat_interval); }
    if (repeat_until !== undefined) { fields.push(`repeat_until = $${i++}`); values.push(repeat_until); }
    const optionUpdates = Object.assign(
      {},
      ...Object.keys(PLATFORM_OPTION_FIELDS).map((platform) => platformOptionsFor(platform, req.body))
    );
    if (Object.keys(optionUpdates).length > 0) {
      fields.push(`platform_options = platform_options || $${i++}::jsonb`);
      values.push(optionUpdates);
    }
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
      mediaRows.rows.map((row) => deleteMedia(path.basename(row.url)))
    );

    await logProductEvent(req.user.id, 'post_deleted', { postId: id }).catch((err) =>
      req.log.error({ err }, 'failed to record product event')
    );

    res.status(204).end();
  })
);

export default router;
