import { readMediaFile } from './shared.js';
import { refreshedAccessToken } from './oauthRefresh.js';
import { pool } from '../../db/pool.js';
import { sanitizeUrl } from '../url.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';
const VIDEOS_PER_LOOKUP = 50;

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

// YouTube rejects '<' and '>' in titles and caps them at 100 characters.
function cleanTitle(text) {
  return (text || '').replace(/[<>]/g, '').trim().slice(0, 100) || 'Untitled';
}

// YouTube is video only. Uploads go through the Data API v3 resumable protocol:
// POST an init request with the video metadata, then PUT the bytes to the URL it returns.
// Title, privacy and the made-for-kids declaration are the user's choices from the composer
// (posts.platform_options.youtube). Without them — an API caller that didn't pass
// youtube_options — the title comes from the post text and the video uploads as private, so
// nothing goes public that the user didn't explicitly choose to publish. Note that until the
// Google Cloud project passes YouTube's API audit, YouTube itself forces every upload to
// private regardless of what's requested here.
export async function publish(post) {
  const video = (post.media || []).find((m) => m.media_type === 'video');
  if (!video) {
    throw new Error('YouTube posts need a video attached');
  }

  const opts = post.platform_options?.youtube || {};
  const token = await accessToken(post);
  const buffer = await readMediaFile(video);

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
        snippet: { title: cleanTitle(opts.title || post.content), description: post.content || '' },
        status: { privacyStatus: opts.privacy_status || 'private', selfDeclaredMadeForKids: !!opts.made_for_kids },
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

function toMetrics(stats) {
  return {
    views: stats.viewCount != null ? Number(stats.viewCount) : null,
    likes: stats.likeCount != null ? Number(stats.likeCount) : null,
    comments: stats.commentCount != null ? Number(stats.commentCount) : null,
    shares: null,
  };
}

// The Data API's statistics part is the most complete metrics source of any adapter here —
// real view/like/comment counts, no separate insights permission needed.
export async function fetchMetrics(post) {
  if (!post.platform_post_id) return null;
  const token = await accessToken(post);

  const url = new URL(`${API}/videos`);
  url.searchParams.set('part', 'statistics');
  url.searchParams.set('id', post.platform_post_id);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`YouTube video lookup failed (${res.status})`);
  }
  const data = await res.json();
  const stats = data.items?.[0]?.statistics;
  if (!stats) return null;
  return toMetrics(stats);
}

// Daily job (scheduler.js refreshStoredPlatformData). YouTube's Developer Policies don't let
// an app keep API data it isn't refreshing, and require deleting it once the user withdraws
// access. refreshPostMetrics() only covers the last 30 days of posts, so this refreshes the
// rest: the channel's name/avatar, and the statistics of every published video (50 per
// call, 1 quota unit each). If Google says access was revoked (invalid_grant), the stored
// avatar and statistics are cleared instead; the account row itself stays so the user can
// see it needs reconnecting (or remove it, which deletes everything).
export async function refreshStoredData(account) {
  let token;
  try {
    token = await accessToken({ ...account, social_account_id: account.id });
  } catch (err) {
    if (err.oauthError !== 'invalid_grant') throw err;
    await pool.query('UPDATE social_accounts SET avatar_url = NULL WHERE id = $1', [account.id]);
    await pool.query(
      `UPDATE posts SET metric_views = NULL, metric_likes = NULL, metric_comments = NULL, metric_shares = NULL,
         metrics_updated_at = NULL
       WHERE social_account_id = $1`,
      [account.id]
    );
    return { revoked: true };
  }
  const headers = { Authorization: `Bearer ${token}` };

  const chanRes = await fetch(`${API}/channels?mine=true&part=snippet`, { headers });
  if (!chanRes.ok) throw new Error(`YouTube channel lookup failed (${chanRes.status})`);
  const channel = (await chanRes.json()).items?.[0];
  if (channel) {
    await pool.query('UPDATE social_accounts SET display_name = $2, avatar_url = $3 WHERE id = $1', [
      account.id,
      channel.snippet?.title || 'YouTube channel',
      sanitizeUrl(channel.snippet?.thumbnails?.default?.url),
    ]);
  }

  const { rows: posts } = await pool.query(
    `SELECT id, platform_post_id FROM posts
     WHERE social_account_id = $1 AND status = 'posted' AND platform_post_id IS NOT NULL`,
    [account.id]
  );
  for (let i = 0; i < posts.length; i += VIDEOS_PER_LOOKUP) {
    const batch = posts.slice(i, i + VIDEOS_PER_LOOKUP);
    const url = new URL(`${API}/videos`);
    url.searchParams.set('part', 'statistics');
    url.searchParams.set('id', batch.map((p) => p.platform_post_id).join(','));
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`YouTube video lookup failed (${res.status})`);
    const byId = new Map(((await res.json()).items || []).map((v) => [v.id, v.statistics]));
    for (const post of batch) {
      // A video missing from the response was deleted on YouTube — drop its stored counts.
      const stats = byId.get(post.platform_post_id);
      const m = stats ? toMetrics(stats) : { views: null, likes: null, comments: null, shares: null };
      await pool.query(
        `UPDATE posts SET metric_views = $2, metric_likes = $3, metric_comments = $4, metric_shares = $5,
           metrics_updated_at = ${stats ? 'now()' : 'NULL'}
         WHERE id = $1`,
        [post.id, m.views, m.likes, m.comments, m.shares]
      );
    }
  }
  return { revoked: false, videos: posts.length };
}

// Called when the user disconnects the channel in Postfalcon, so the grant is withdrawn on
// Google's side too rather than just forgotten here. Best effort — the local delete has
// already happened either way.
export async function revoke(account) {
  const token = account.refresh_token || account.access_token;
  if (!token) return;
  await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  });
}
