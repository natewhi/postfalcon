import { readMediaFile } from './shared.js';
import { refreshedAccessToken } from './oauthRefresh.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function accessToken(post) {
  return refreshedAccessToken(post, {
    tokenUrl: TOKEN_URL,
    form: {
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: post.refresh_token,
    },
  });
}

// YouTube is video only. Uploads go through the Data API v3 resumable protocol:
// POST an init request with the video metadata, then PUT the bytes to the URL it returns.
export async function publish(post) {
  const video = (post.media || []).find((m) => m.media_type === 'video');
  if (!video) {
    throw new Error('YouTube posts need a video attached');
  }

  const token = await accessToken(post);
  const buffer = await readMediaFile(video);
  const title = (post.content || 'Untitled').replace(/[<>]/g, '').slice(0, 95) || 'Untitled';

  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/*',
        'X-Upload-Content-Length': String(buffer.length),
      },
      body: JSON.stringify({
        snippet: { title, description: post.content || '' },
        status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
      }),
    }
  );
  if (!initRes.ok) {
    const body = await initRes.text();
    throw new Error(`YouTube upload init failed (${initRes.status}): ${body}`);
  }
  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) {
    throw new Error('YouTube did not return a resumable upload URL');
  }

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/*', 'Content-Length': String(buffer.length) },
    body: buffer,
  });
  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    throw new Error(`YouTube video upload failed (${uploadRes.status}): ${body}`);
  }
  const data = await uploadRes.json();
  return data.id;
}

// The Data API's statistics part is the most complete metrics source of any adapter here —
// real view/like/comment counts, no separate insights permission needed.
export async function fetchMetrics(post) {
  if (!post.platform_post_id) return null;
  const token = await accessToken(post);

  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'statistics');
  url.searchParams.set('id', post.platform_post_id);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`YouTube video lookup failed (${res.status})`);
  }
  const data = await res.json();
  const stats = data.items?.[0]?.statistics;
  if (!stats) return null;
  return {
    views: stats.viewCount != null ? Number(stats.viewCount) : null,
    likes: stats.likeCount != null ? Number(stats.likeCount) : null,
    comments: stats.commentCount != null ? Number(stats.commentCount) : null,
    shares: null,
  };
}
