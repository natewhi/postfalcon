import crypto from 'node:crypto';
import { GRAPH_VERSION, readMediaFile } from './shared.js';
import { fitForInstagram } from '../imageFit.js';
import { saveMedia, deleteMedia, mediaUrl } from '../storage.js';
import { logger } from '../logger.js';

// The URL Instagram should fetch for this media item. A photo Instagram would reject (wrong
// shape, or not a JPEG) gets a fitted JPEG copy saved alongside it, named in `tempNames` so
// publish() can delete it once Instagram has its own copy. Anything that can't be read here
// (a video, a missing file, a format sharp doesn't decode) goes to Instagram as-is.
async function instagramMediaUrl(media, tempNames) {
  if (media.media_type === 'video') return media.url;
  let fitted;
  try {
    fitted = await fitForInstagram(await readMediaFile(media));
  } catch (err) {
    // Expected for a format sharp can't decode, but also how a missing/broken sharp install
    // would show up, so say so rather than silently sending a photo Instagram may reject.
    logger.warn({ err, url: media.url }, 'could not fit image for Instagram; sending the original');
    return media.url;
  }
  if (!fitted) return media.url;
  const name = `${crypto.randomUUID()}.jpg`;
  await saveMedia(name, fitted, 'image/jpeg');
  tempNames.push(name);
  return mediaUrl(name);
}

async function createInstagramContainer(igUserId, token, media, extra, tempNames) {
  const mediaField = media.media_type === 'video' ? 'video_url' : 'image_url';
  const url = await instagramMediaUrl(media, tempNames);
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [mediaField]: url, access_token: token, ...extra }),
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

export async function publish(post) {
  const media = post.media || [];
  if (media.length === 0) {
    throw new Error('Instagram requires an image or video attached to the post');
  }
  const tempNames = [];
  try {
    return await publishMedia(post, media, tempNames);
  } finally {
    // Every container is FINISHED (or the publish failed) by now, so Instagram no longer
    // needs the fitted copies.
    await Promise.all(tempNames.map((name) => deleteMedia(name)));
  }
}

async function publishMedia(post, media, tempNames) {
  const igUserId = post.external_account_id;
  const token = post.access_token;

  let creationId;
  if (media.length === 1) {
    const extra = { caption: post.content };
    if (media[0].alt_text) extra.alt_text = media[0].alt_text;
    creationId = await createInstagramContainer(igUserId, token, media[0], extra, tempNames);
    await waitForInstagramContainer(creationId, token);
  } else {
    const childIds = [];
    for (const item of media) {
      const childId = await createInstagramContainer(igUserId, token, item, { is_carousel_item: true }, tempNames);
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

// Likes/comments only via these public fields — impressions/reach need the separate
// /insights endpoint (business-account-only, extra permission we don't request).
export async function fetchMetrics(post) {
  if (!post.platform_post_id) return null;

  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${post.platform_post_id}`);
  url.searchParams.set('fields', 'like_count,comments_count');
  url.searchParams.set('access_token', post.access_token);
  const res = await fetch(url);
  if (!res.ok) {
    // Include Meta's error body: an expired/revoked token comes back as a 400 with
    // OAuthException / code 190 in it, which lib/reconnect.js needs to see to flag the account.
    throw new Error(`Instagram media lookup failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return {
    views: null,
    likes: data.like_count ?? null,
    comments: data.comments_count ?? null,
    shares: null,
  };
}
