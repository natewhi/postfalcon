import cron from 'node-cron';
import { pool } from './db/pool.js';

async function sendPost(post) {
  console.log(`[stub] posting to account ${post.social_account_id}: ${post.content}`);
}

async function processDuePosts() {
  const { rows: due } = await pool.query(
    `SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_for <= now() ORDER BY scheduled_for`
  );

  for (const post of due) {
    await pool.query(`UPDATE posts SET status = 'posting' WHERE id = $1`, [post.id]);
    try {
      await sendPost(post);
      await pool.query(`UPDATE posts SET status = 'posted', posted_at = now() WHERE id = $1`, [post.id]);
    } catch (err) {
      await pool.query(`UPDATE posts SET status = 'failed', error_message = $2 WHERE id = $1`, [
        post.id,
        err.message,
      ]);
    }
  }
}

export function startScheduler() {
  cron.schedule('* * * * *', () => {
    processDuePosts().catch((err) => console.error('scheduler error', err));
  });
  console.log('Scheduler started (runs every minute)');
}
