import path from 'node:path';
import { readMediaFile } from './shared.js';

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

export async function publish(post) {
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

// Mastodon has no "views" concept for a status — likes/replies/boosts only.
export async function fetchMetrics(post) {
  const instance = post.metadata?.instance;
  if (!instance || !post.platform_post_id) return null;

  const res = await fetch(`https://${instance}/api/v1/statuses/${post.platform_post_id}`, {
    headers: { Authorization: `Bearer ${post.access_token}` },
  });
  if (!res.ok) {
    throw new Error(`Mastodon status lookup failed (${res.status})`);
  }
  const data = await res.json();
  return {
    views: null,
    likes: data.favourites_count ?? null,
    comments: data.replies_count ?? null,
    shares: data.reblogs_count ?? null,
  };
}
