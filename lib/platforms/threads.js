import { pool } from '../../db/pool.js';

const GRAPH_BASE = 'https://graph.threads.net/v1.0';
const CONTAINER_POLL_INTERVAL_MS = 2000;
const CONTAINER_POLL_MAX_ATTEMPTS = 15;
// Threads' long-lived token lasts ~60 days with no separate refresh_token — you refresh the
// access_token itself, authenticating the refresh call with its own current validity. Refresh
// with a week of runway left rather than waiting until the last moment.
const REFRESH_SAFETY_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

async function refreshedAccessToken(post) {
  const expiresAt = post.token_expires_at ? new Date(post.token_expires_at).getTime() : 0;
  if (post.access_token && expiresAt - Date.now() > REFRESH_SAFETY_MARGIN_MS) {
    return post.access_token;
  }
  if (!post.access_token) {
    throw new Error('this Threads account has no access token — reconnect it');
  }

  const url = new URL('https://graph.threads.net/refresh_access_token');
  url.searchParams.set('grant_type', 'th_refresh_token');
  url.searchParams.set('access_token', post.access_token);
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Threads token refresh failed (${res.status}): ${data.error?.message || 'reconnect this account'}`);
  }

  const newExpiry = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;
  await pool.query('UPDATE social_accounts SET access_token = $1, token_expires_at = $2 WHERE id = $3', [
    data.access_token,
    newExpiry,
    post.social_account_id,
  ]);
  post.access_token = data.access_token;
  post.token_expires_at = newExpiry;
  return data.access_token;
}

async function createThreadsContainer(userId, token, extra) {
  const res = await fetch(`${GRAPH_BASE}/${userId}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: token, ...extra }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    throw new Error(`Threads media creation failed (${res.status}): ${data.error?.message || 'unknown error'}`);
  }
  return data.id;
}

// Threads processes a container asynchronously (especially video), same shape as Instagram's
// container polling — publishing before it reaches FINISHED fails.
async function waitForThreadsContainer(containerId, token) {
  for (let attempt = 0; attempt < CONTAINER_POLL_MAX_ATTEMPTS; attempt++) {
    const url = new URL(`${GRAPH_BASE}/${containerId}`);
    url.searchParams.set('fields', 'status,error_message');
    url.searchParams.set('access_token', token);
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Threads container status check failed (${res.status}): ${data.error?.message || 'unknown error'}`);
    }
    if (data.status === 'FINISHED') return;
    if (data.status === 'ERROR' || data.status === 'EXPIRED') {
      throw new Error(`Threads failed to process the post: ${data.error_message || data.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, CONTAINER_POLL_INTERVAL_MS));
  }
  throw new Error('Timed out waiting for Threads to finish processing the post');
}

function mediaFields(item) {
  const fields =
    item.media_type === 'video' ? { media_type: 'VIDEO', video_url: item.url } : { media_type: 'IMAGE', image_url: item.url };
  if (item.alt_text) fields.alt_text = item.alt_text;
  return fields;
}

export async function publish(post) {
  const token = await refreshedAccessToken(post);
  const userId = post.external_account_id;
  const media = post.media || [];

  let creationId;
  if (media.length === 0) {
    creationId = await createThreadsContainer(userId, token, { media_type: 'TEXT', text: post.content });
  } else if (media.length === 1) {
    creationId = await createThreadsContainer(userId, token, { ...mediaFields(media[0]), text: post.content });
  } else {
    const childIds = [];
    for (const item of media) {
      childIds.push(await createThreadsContainer(userId, token, { ...mediaFields(item), is_carousel_item: true }));
    }
    creationId = await createThreadsContainer(userId, token, {
      media_type: 'CAROUSEL',
      children: childIds,
      text: post.content,
    });
  }

  await waitForThreadsContainer(creationId, token);

  const publishRes = await fetch(`${GRAPH_BASE}/${userId}/threads_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: creationId, access_token: token }),
  });
  const published = await publishRes.json().catch(() => ({}));
  if (!publishRes.ok || !published.id) {
    throw new Error(`Threads publish failed (${publishRes.status}): ${published.error?.message || 'unknown error'}`);
  }
  return published.id;
}

// Threads' insights endpoint is unusually generous — it reports "views" even for text-only
// posts, unlike Facebook/Instagram which need extra permissions for that.
export async function fetchMetrics(post) {
  if (!post.platform_post_id) return null;
  const token = await refreshedAccessToken(post);

  const url = new URL(`${GRAPH_BASE}/${post.platform_post_id}/insights`);
  url.searchParams.set('metric', 'views,likes,replies,reposts');
  url.searchParams.set('access_token', token);
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Threads insights lookup failed (${res.status}): ${data.error?.message || 'unknown error'}`);
  }
  const metric = (name) => data.data?.find((m) => m.name === name)?.total_value?.value ?? null;
  return { views: metric('views'), likes: metric('likes'), comments: metric('replies'), shares: metric('reposts') };
}
