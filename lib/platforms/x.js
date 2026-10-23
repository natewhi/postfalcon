import { readMediaFile } from './shared.js';
import { refreshedAccessToken } from './oauthRefresh.js';

// X (formerly Twitter) via the v2 API, with OAuth 2.0 user tokens from routes/x.js. Posting
// needs a paid API plan, which is why the registry entry is unlisted until that's in place.
// Text plus up to 4 images; video needs X's chunked upload flow (INIT/APPEND/FINALIZE), not
// built yet.
export const X_API = 'https://api.x.com';
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// X authenticates a confidential client's token requests with HTTP Basic auth. Shared with
// routes/x.js's code exchange.
export function basicAuthHeader() {
  return `Basic ${Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString('base64')}`;
}

// Access tokens last 2 hours; the refresh token (offline.access scope) is single-use and
// rotates on every refresh, which oauthRefresh.js persists.
function accessToken(post) {
  return refreshedAccessToken(post, {
    tokenUrl: `${X_API}/2/oauth2/token`,
    headers: { Authorization: basicAuthHeader() },
    form: { grant_type: 'refresh_token', refresh_token: post.refresh_token, client_id: process.env.X_CLIENT_ID },
  });
}

async function uploadImage(token, media) {
  const buffer = await readMediaFile(media);
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error('X images must be 5MB or smaller.');
  }
  const form = new FormData();
  form.append('media', new Blob([buffer]), 'image');
  form.append('media_category', 'tweet_image');
  const res = await fetch(`${X_API}/2/media/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`X media upload failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  const id = data.data?.id ?? data.media_id_string;
  if (!id) throw new Error('X media upload returned no media id');
  return id;
}

export async function publish(post) {
  const media = post.media || [];
  if (media.some((m) => m.media_type === 'video')) {
    throw new Error('X video posting is not supported yet — attach images, or post text only.');
  }
  if (media.length > MAX_IMAGES) {
    throw new Error(`X allows up to ${MAX_IMAGES} images per post.`);
  }

  const token = await accessToken(post);
  const mediaIds = [];
  for (const item of media) {
    mediaIds.push(await uploadImage(token, item));
  }

  const body = { text: post.content };
  if (mediaIds.length) body.media = { media_ids: mediaIds };
  const res = await fetch(`${X_API}/2/tweets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`X post failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.data?.id ?? null;
}

// Public engagement counts on the post. Reposts and quotes both count as shares.
export async function fetchMetrics(post) {
  if (!post.platform_post_id) return null;
  const token = await accessToken(post);
  const url = new URL(`${X_API}/2/tweets/${encodeURIComponent(post.platform_post_id)}`);
  url.searchParams.set('tweet.fields', 'public_metrics');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`X post lookup failed (${res.status}): ${await res.text()}`);
  }
  const metrics = (await res.json()).data?.public_metrics;
  if (!metrics) return null;
  return {
    views: metrics.impression_count ?? null,
    likes: metrics.like_count ?? null,
    comments: metrics.reply_count ?? null,
    shares: metrics.retweet_count != null ? metrics.retweet_count + (metrics.quote_count ?? 0) : null,
  };
}
