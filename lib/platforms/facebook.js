import path from 'node:path';
import { GRAPH_VERSION, readMediaFile } from './shared.js';

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

export async function publish(post) {
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

// Reaction/comment/share counts via the generic Graph node fields — works for both a /feed
// post id and a /videos id. No "views" here: that needs the Page Insights permission, which
// Postfalcon doesn't currently request.
export async function fetchMetrics(post) {
  if (!post.platform_post_id) return null;

  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${post.platform_post_id}`);
  url.searchParams.set('fields', 'likes.summary(true).limit(0),comments.summary(true).limit(0),shares');
  url.searchParams.set('access_token', post.access_token);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Facebook post lookup failed (${res.status})`);
  }
  const data = await res.json();
  return {
    views: null,
    likes: data.likes?.summary?.total_count ?? null,
    comments: data.comments?.summary?.total_count ?? null,
    shares: data.shares?.count ?? null,
  };
}
