import cron from 'node-cron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from './db/pool.js';
import { uploadDir } from './middleware/upload.js';
import { cleanupOldMedia } from './lib/mediaCleanup.js';
import { logger } from './lib/logger.js';

const GRAPH_VERSION = 'v19.0';

async function readMediaFile(media) {
  const filePath = path.join(uploadDir, path.basename(media.url));
  return fs.readFile(filePath);
}

async function uploadMastodonMedia(instance, token, media) {
  const buffer = await readMediaFile(media);
  const form = new FormData();
  form.append('file', new Blob([buffer]), path.basename(media.url));
  if (media.alt_text) {
    form.append('description', media.alt_text);
  }
  const res = await fetch(`https://${instance}/api/v2/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mastodon media upload failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return data.id;
}

async function postToMastodon(post) {
  const instance = post.metadata?.instance;
  if (!instance) {
    throw new Error('Mastodon account is missing its instance metadata');
  }

  const mediaIds = [];
  for (const media of (post.media || []).slice(0, 4)) {
    mediaIds.push(await uploadMastodonMedia(instance, post.access_token, media));
  }

  const res = await fetch(`https://${instance}/api/v1/statuses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${post.access_token}`,
    },
    body: JSON.stringify({ status: post.content, media_ids: mediaIds.length ? mediaIds : undefined }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mastodon post failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return data.id;
}

async function uploadFacebookPhoto(pageId, pageToken, media, published) {
  const buffer = await readMediaFile(media);
  const form = new FormData();
  form.append('source', new Blob([buffer]), path.basename(media.url));
  form.append('published', String(published));
  if (media.alt_text) {
    form.append('alt_text_custom', media.alt_text);
  }
  form.append('access_token', pageToken);

  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/photos`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Facebook photo upload failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return data.id;
}

async function postToFacebook(post) {
  const pageId = post.external_account_id;
  const pageToken = post.access_token;
  const media = post.media || [];
  const video = media.find((m) => m.media_type === 'video');

  // Facebook feed posts don't support multiple videos, so if one is attached, post
  // just that (matches the common case of a single video post).
  if (video) {
    const buffer = await readMediaFile(video);
    const form = new FormData();
    form.append('source', new Blob([buffer]), path.basename(video.url));
    form.append('description', post.content);
    form.append('access_token', pageToken);

    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/videos`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Facebook post failed (${res.status}): ${body}`);
    }
    const data = await res.json();
    return data.id;
  }

  if (media.length > 0) {
    const photoIds = [];
    for (const item of media) {
      photoIds.push(await uploadFacebookPhoto(pageId, pageToken, item, false));
    }
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/feed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: post.content,
        attached_media: photoIds.map((id) => ({ media_fbid: id })),
        access_token: pageToken,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Facebook post failed (${res.status}): ${body}`);
    }
    const data = await res.json();
    return data.id;
  }

  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: post.content, access_token: pageToken }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Facebook post failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return data.id;
}

async function createInstagramContainer(igUserId, token, media, extra) {
  const mediaField = media.media_type === 'video' ? 'video_url' : 'image_url';
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [mediaField]: media.url, access_token: token, ...extra }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Instagram media creation failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return data.id;
}

const IG_CONTAINER_POLL_INTERVAL_MS = 2000;
const IG_CONTAINER_POLL_MAX_ATTEMPTS = 15;

// Instagram processes an uploaded container asynchronously — images are usually near-instant,
// but video (including carousel video items) can take real time. Publishing before the
// container reaches FINISHED fails with Graph error 9007, so every container must be polled
// here before it's referenced by a carousel or passed to media_publish.
async function waitForInstagramContainer(containerId, token) {
  for (let attempt = 0; attempt < IG_CONTAINER_POLL_MAX_ATTEMPTS; attempt++) {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${containerId}?fields=status_code&access_token=${encodeURIComponent(token)}`
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Instagram container status check failed (${res.status}): ${body}`);
    }
    const { status_code: status } = await res.json();
    if (status === 'FINISHED') return;
    if (status === 'ERROR') {
      throw new Error('Instagram failed to process the uploaded media');
    }
    await new Promise((resolve) => setTimeout(resolve, IG_CONTAINER_POLL_INTERVAL_MS));
  }
  throw new Error('Timed out waiting for Instagram to finish processing media');
}

async function postToInstagram(post) {
  const media = post.media || [];
  if (media.length === 0) {
    throw new Error('Instagram requires an image or video attached to the post');
  }
  const igUserId = post.external_account_id;
  const token = post.access_token;

  let creationId;
  if (media.length === 1) {
    const extra = { caption: post.content };
    if (media[0].alt_text) extra.alt_text = media[0].alt_text;
    creationId = await createInstagramContainer(igUserId, token, media[0], extra);
    await waitForInstagramContainer(creationId, token);
  } else {
    const childIds = [];
    for (const item of media) {
      const childId = await createInstagramContainer(igUserId, token, item, { is_carousel_item: true });
      await waitForInstagramContainer(childId, token);
      childIds.push(childId);
    }
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: 'CAROUSEL',
        children: childIds,
        caption: post.content,
        access_token: token,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Instagram carousel creation failed (${res.status}): ${body}`);
    }
    const data = await res.json();
    creationId = data.id;
    await waitForInstagramContainer(creationId, token);
  }

  const publishRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: creationId, access_token: token }),
  });
  if (!publishRes.ok) {
    const body = await publishRes.text();
    throw new Error(`Instagram publish failed (${publishRes.status}): ${body}`);
  }
  const published = await publishRes.json();
  return published.id;
}

async function sendPost(post) {
  if (post.platform === 'mastodon') {
    return postToMastodon(post);
  }
  if (post.platform === 'facebook') {
    return postToFacebook(post);
  }
  if (post.platform === 'instagram') {
    return postToInstagram(post);
  }
  logger.info({ socialAccountId: post.social_account_id, platform: post.platform }, '[stub] posting to account');
  return null;
}

export async function processDuePosts() {
  const { rows: due } = await pool.query(`
    SELECT posts.*, social_accounts.platform, social_accounts.access_token, social_accounts.metadata,
           social_accounts.external_account_id
    FROM posts
    JOIN social_accounts ON social_accounts.id = posts.social_account_id
    WHERE posts.status = 'scheduled' AND posts.scheduled_for <= now()
    ORDER BY posts.scheduled_for
  `);

  if (due.length > 0) {
    const mediaResult = await pool.query('SELECT * FROM post_media WHERE post_id = ANY($1) ORDER BY position', [
      due.map((p) => p.id),
    ]);
    const mediaByPost = new Map();
    for (const row of mediaResult.rows) {
      if (!mediaByPost.has(row.post_id)) mediaByPost.set(row.post_id, []);
      mediaByPost.get(row.post_id).push(row);
    }
    for (const post of due) {
      post.media = mediaByPost.get(post.id) || [];
    }
  }

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
    processDuePosts().catch((err) => logger.error({ err }, 'scheduler error'));
  });

  cron.schedule('0 3 * * *', () => {
    cleanupOldMedia()
      .then(({ postsCleaned, filesRemoved }) => {
        if (postsCleaned > 0) {
          logger.info({ postsCleaned, filesRemoved }, 'media cleanup');
        }
      })
      .catch((err) => logger.error({ err }, 'media cleanup error'));
  });

  logger.info('Scheduler started (runs every minute); media cleanup runs daily at 03:00.');
}
