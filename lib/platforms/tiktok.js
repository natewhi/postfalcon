import { readMediaFile } from './shared.js';
import { refreshedAccessToken } from './oauthRefresh.js';

const API = 'https://open.tiktokapis.com';
const STATUS_POLL_INTERVAL_MS = 3000;
const STATUS_POLL_MAX_ATTEMPTS = 20;

function accessToken(post) {
  return refreshedAccessToken(post, {
    tokenUrl: `${API}/v2/oauth/token/`,
    form: {
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: post.refresh_token,
    },
  });
}

// TikTok is video only, via the Content Posting API: init a publish, PUT the file to the
// upload URL it returns, then poll for completion. Note: until a TikTok app passes audit,
// posts are restricted to the developer's own account and default to a private audience.
export async function publish(post) {
  const video = (post.media || []).find((m) => m.media_type === 'video');
  if (!video) {
    throw new Error('TikTok posts need a video attached');
  }

  const token = await accessToken(post);
  const buffer = await readMediaFile(video);
  const size = buffer.length;
  const privacyLevel = post.metadata?.tiktokPrivacy || 'SELF_ONLY';

  const initRes = await fetch(`${API}/v2/post/publish/video/init/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      post_info: { title: (post.content || '').slice(0, 2200), privacy_level: privacyLevel },
      source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: size, total_chunk_count: 1 },
    }),
  });
  const initData = await initRes.json().catch(() => ({}));
  if (!initRes.ok || initData.error?.code !== 'ok') {
    throw new Error(`TikTok publish init failed (${initRes.status}): ${initData.error?.message || 'unknown'}`);
  }
  const { publish_id: publishId, upload_url: uploadUrl } = initData.data;

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(size),
      'Content-Range': `bytes 0-${size - 1}/${size}`,
    },
    body: buffer,
  });
  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    throw new Error(`TikTok video upload failed (${uploadRes.status}): ${body}`);
  }

  for (let attempt = 0; attempt < STATUS_POLL_MAX_ATTEMPTS; attempt++) {
    const statusRes = await fetch(`${API}/v2/post/publish/status/fetch/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const statusData = await statusRes.json().catch(() => ({}));
    const status = statusData.data?.status;
    if (status === 'PUBLISH_COMPLETE') {
      return publishId;
    }
    if (status === 'FAILED') {
      throw new Error(`TikTok publish failed: ${statusData.data?.fail_reason || 'unknown reason'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
  }
  throw new Error('Timed out waiting for TikTok to finish publishing');
}
