import { readMediaFile } from './shared.js';
import { refreshedAccessToken } from './oauthRefresh.js';

const API = 'https://open.tiktokapis.com';
const STATUS_POLL_INTERVAL_MS = 3000;
const STATUS_POLL_MAX_ATTEMPTS = 20;

// Per TikTok's Content Posting API media transfer guide: a chunk must be 5-64MB (the
// final chunk may run over, up to 128MB, to absorb the remainder), max 1000 chunks, and
// chunks must be uploaded sequentially. A video under this threshold is sent as a single
// chunk (chunk_size == video_size) rather than split.
const MULTI_CHUNK_THRESHOLD = 64 * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024 * 1024;

// video_size / chunk_size floored, per TikTok's own documented example (a 50,000,123-byte
// file with a 10,000,000-byte chunk_size yields 5 chunks, with the trailing 123 bytes
// merged into the last one rather than becoming a short extra chunk).
function planChunks(size) {
  if (size <= MULTI_CHUNK_THRESHOLD) {
    return { chunkSize: size, totalChunkCount: 1 };
  }
  return { chunkSize: CHUNK_SIZE, totalChunkCount: Math.floor(size / CHUNK_SIZE) };
}

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

// Required by TikTok before every publish attempt (Content Sharing Guidelines) — an app
// that calls video/init/ without first querying creator_info gets a generic 403 "review
// our integration guidelines" error, regardless of how the init request itself is shaped.
async function queryCreatorInfo(token) {
  const res = await fetch(`${API}/v2/post/publish/creator_info/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error?.code !== 'ok') {
    throw new Error(`TikTok creator_info query failed (${res.status}): ${data.error?.message || 'unknown'}`);
  }
  return data.data;
}

// For the composer's TikTok panel (routes/tiktok.js GET /creator-info): the guidelines also
// require showing the creator's identity, privacy options and interaction settings *before*
// the user posts, not just checking them at publish time. `account` is a social_accounts row.
export async function getCreatorInfo(account) {
  const token = await accessToken({ ...account, social_account_id: account.id });
  return queryCreatorInfo(token);
}

// The user's own choices from the composer (posts.platform_options.tiktok). A post created
// without them (e.g. via the API without tiktok_options, or a draft dragged onto the
// calendar) publishes as the most conservative option: private, all interactions off, no
// commercial disclosure — never more public than the user explicitly asked for.
function resolvePostInfo(post, creatorInfo) {
  const opts = post.platform_options?.tiktok || {};
  const offered = creatorInfo.privacy_level_options;

  let privacyLevel = opts.privacy_level;
  if (privacyLevel && !offered.includes(privacyLevel)) {
    throw new Error(
      `TikTok no longer offers the privacy level chosen for this post (${privacyLevel}) — edit the post and pick another`
    );
  }
  if (!privacyLevel) {
    if (!offered.includes('SELF_ONLY')) {
      throw new Error('No TikTok privacy level was chosen for this post — edit it and pick who can view it');
    }
    privacyLevel = 'SELF_ONLY';
  }
  if (opts.brand_content && privacyLevel === 'SELF_ONLY') {
    throw new Error('Branded content on TikTok cannot be private — edit the post and pick another privacy level');
  }

  return {
    title: (post.content || '').slice(0, 2200),
    privacy_level: privacyLevel,
    // The creator's account-level settings win: an interaction they've disabled stays off
    // even if the post asked for it.
    disable_comment: !!creatorInfo.comment_disabled || !opts.allow_comment,
    disable_duet: !!creatorInfo.duet_disabled || !opts.allow_duet,
    disable_stitch: !!creatorInfo.stitch_disabled || !opts.allow_stitch,
    brand_organic_toggle: !!opts.brand_organic,
    brand_content_toggle: !!opts.brand_content,
  };
}

// TikTok is video only, via the Content Posting API: init a publish, PUT the file to the
// upload URL it returns, then poll for completion. Note: an app that hasn't passed TikTok's
// Direct Post audit can only post privately (postfalcon.co's passed on 2026-10-20; a
// self-hoster's own app starts unaudited).
export async function publish(post) {
  const video = (post.media || []).find((m) => m.media_type === 'video');
  if (!video) {
    throw new Error('TikTok posts need a video attached');
  }

  const token = await accessToken(post);
  const creatorInfo = await queryCreatorInfo(token);
  if (!creatorInfo.privacy_level_options?.length) {
    throw new Error('TikTok creator cannot post right now (no privacy level options available)');
  }

  const postInfo = resolvePostInfo(post, creatorInfo);

  const buffer = await readMediaFile(video);
  const size = buffer.length;
  const { chunkSize, totalChunkCount } = planChunks(size);

  const initRes = await fetch(`${API}/v2/post/publish/video/init/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      post_info: postInfo,
      source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: totalChunkCount },
    }),
  });
  const initData = await initRes.json().catch(() => ({}));
  if (!initRes.ok || initData.error?.code !== 'ok') {
    throw new Error(`TikTok publish init failed (${initRes.status}): ${initData.error?.message || 'unknown'}`);
  }
  const { publish_id: publishId, upload_url: uploadUrl } = initData.data;

  // Chunks must be uploaded sequentially (not in parallel) per TikTok's own guide.
  for (let i = 0; i < totalChunkCount; i++) {
    const firstByte = i * chunkSize;
    const isLastChunk = i === totalChunkCount - 1;
    const lastByte = isLastChunk ? size - 1 : firstByte + chunkSize - 1;
    const chunk = buffer.subarray(firstByte, lastByte + 1);

    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${firstByte}-${lastByte}/${size}`,
      },
      body: chunk,
    });
    if (!uploadRes.ok) {
      const body = await uploadRes.text();
      throw new Error(`TikTok video upload failed on chunk ${i + 1}/${totalChunkCount} (${uploadRes.status}): ${body}`);
    }
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
