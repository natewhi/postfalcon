import { readMediaFile } from './shared.js';

const PDS = 'https://bsky.social';
const MAX_IMAGES = 4;

const IMAGE_MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function imageMimeType(url) {
  const ext = url.slice(url.lastIndexOf('.')).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] || 'image/jpeg';
}

// Bluesky has no third-party OAuth yet — the durable credential is an "app password" the
// user generates in their own settings. Access tokens (accessJwt) are short-lived (~2h), so
// rather than persist and refresh a session, we just log in fresh for every publish;
// scheduled posts go out at most a few times an hour per account, so the extra round trip is
// cheap and this sidesteps token-expiry bookkeeping entirely. `identifier` accepts a handle,
// email, or DID — we pass the DID stored at connect time.
async function createSession(did, appPassword) {
  const res = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: did, password: appPassword }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.accessJwt) {
    throw new Error(`Bluesky login failed (${res.status}): ${data.message || 'check the stored app password'}`);
  }
  return data;
}

async function uploadImageBlob(accessJwt, media) {
  const buffer = await readMediaFile(media);
  const res = await fetch(`${PDS}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessJwt}`, 'Content-Type': imageMimeType(media.url) },
    body: buffer,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.blob) {
    throw new Error(`Bluesky media upload failed (${res.status}): ${data.message || 'unknown error'}`);
  }
  return data.blob;
}

export async function publish(post) {
  const media = post.media || [];
  if (media.some((m) => m.media_type === 'video')) {
    throw new Error('Bluesky video posting is not supported yet — attach images or remove the video.');
  }

  const { accessJwt, did } = await createSession(post.external_account_id, post.access_token);

  let embed;
  if (media.length > 0) {
    const images = [];
    for (const item of media.slice(0, MAX_IMAGES)) {
      const blob = await uploadImageBlob(accessJwt, item);
      images.push({ image: blob, alt: item.alt_text || '' });
    }
    embed = { $type: 'app.bsky.embed.images', images };
  }

  const record = {
    $type: 'app.bsky.feed.post',
    text: post.content,
    createdAt: new Date().toISOString(),
    ...(embed ? { embed } : {}),
  };

  const res = await fetch(`${PDS}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessJwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: did, collection: 'app.bsky.feed.post', record }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.uri) {
    throw new Error(`Bluesky post failed (${res.status}): ${data.message || 'unknown error'}`);
  }
  return data.uri;
}

// Bluesky's public AppView serves post engagement counts unauthenticated — no need to spend
// an app-password login just to read stats. `platform_post_id` is the at:// URI returned by
// createRecord above. No "views" concept, same as most AT Proto apps.
const PUBLIC_APPVIEW = 'https://public.api.bsky.app';

export async function fetchMetrics(post) {
  if (!post.platform_post_id) return null;

  const url = new URL(`${PUBLIC_APPVIEW}/xrpc/app.bsky.feed.getPosts`);
  url.searchParams.set('uris', post.platform_post_id);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Bluesky post lookup failed (${res.status})`);
  }
  const data = await res.json();
  const found = data.posts?.[0];
  if (!found) return null;
  return {
    views: null,
    likes: found.likeCount ?? null,
    comments: found.replyCount ?? null,
    shares: found.repostCount ?? null,
  };
}
