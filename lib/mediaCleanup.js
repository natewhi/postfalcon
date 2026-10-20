import path from 'node:path';
import { pool } from '../db/pool.js';
import { deleteMedia } from './storage.js';

const RETENTION_DAYS = Number(process.env.MEDIA_RETENTION_DAYS) || 30;
const TERMINAL_STATUSES = ['posted', 'failed', 'canceled'];

// Media for draft/scheduled posts is left alone — those represent active intent.
// For posts that reached a terminal state, the file isn't functionally needed once
// it's past the retention window (platforms already have their own copy by the time
// a post is "posted"); it only exists to back the thumbnail in our own history view.
export async function cleanupOldMedia() {
  const { rows: posts } = await pool.query(
    `SELECT posts.id FROM posts
     WHERE posts.status = ANY($1)
       AND COALESCE(posts.posted_at, posts.updated_at) < now() - ($2 || ' days')::interval
       AND EXISTS (SELECT 1 FROM post_media WHERE post_media.post_id = posts.id)`,
    [TERMINAL_STATUSES, RETENTION_DAYS]
  );

  if (posts.length === 0) {
    return { postsCleaned: 0, filesRemoved: 0 };
  }

  const postIds = posts.map((p) => p.id);
  const { rows: mediaRows } = await pool.query('SELECT url FROM post_media WHERE post_id = ANY($1)', [postIds]);

  await Promise.all(mediaRows.map((row) => deleteMedia(path.basename(row.url))));
  await pool.query('DELETE FROM post_media WHERE post_id = ANY($1)', [postIds]);

  return { postsCleaned: postIds.length, filesRemoved: mediaRows.length };
}
