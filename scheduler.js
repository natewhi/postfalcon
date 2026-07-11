import cron from 'node-cron';
import { pool } from './db/pool.js';

async function postToMastodon(post) {
  const instance = post.metadata?.instance;
  if (!instance) {
    throw new Error('Mastodon account is missing its instance metadata');
  }
  const res = await fetch(`https://${instance}/api/v1/statuses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${post.access_token}`,
    },
    body: JSON.stringify({ status: post.content }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mastodon post failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return data.id;
}

async function sendPost(post) {
  if (post.platform === 'mastodon') {
    return postToMastodon(post);
  }
  console.log(`[stub] posting to account ${post.social_account_id} (${post.platform}): ${post.content}`);
  return null;
}

export async function processDuePosts() {
  const { rows: due } = await pool.query(`
    SELECT posts.*, social_accounts.platform, social_accounts.access_token, social_accounts.metadata
    FROM posts
    JOIN social_accounts ON social_accounts.id = posts.social_account_id
    WHERE posts.status = 'scheduled' AND posts.scheduled_for <= now()
    ORDER BY posts.scheduled_for
  `);

  for (const post of due) {
    await pool.query(`UPDATE posts SET status = 'posting' WHERE id = $1`, [post.id]);
    try {
      const platformPostId = await sendPost(post);
      await pool.query(`UPDATE posts SET status = 'posted', posted_at = now(), platform_post_id = $2 WHERE id = $1`, [
        post.id,
        platformPostId,
      ]);
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
