// Pinterest Pins are inherently image/video objects — there's no text-only Pin type, so unlike
// every other adapter here a Pin always needs media. The image just needs to be a public URL
// (uploaded media already is one — BASE_URL/uploads/<file>), so no upload dance is needed, only
// a single API call. Video pins need Pinterest's separate media-upload flow — not built yet.
// Pins always post to one board, chosen at connect time and stored in social_accounts.metadata
// (same place Mastodon stores its instance domain).
import { refreshedAccessToken } from './oauthRefresh.js';

const TOKEN_URL = 'https://api.pinterest.com/v5/oauth/token';

// Where boards and Pins are written. An app on Pinterest's Trial access tier may not create
// Pins in production, only in the API sandbox (PINTEREST_API_BASE=https://api-sandbox.pinterest.com),
// which is also where Pinterest expects the Standard-access demo to be recorded. Sandbox
// boards and Pins are separate from the real ones, so an account connected while this pointed
// elsewhere has to reconnect after it changes (its stored board id belongs to the other one).
export function pinterestApiBase() {
  return (process.env.PINTEREST_API_BASE || 'https://api.pinterest.com').replace(/\/+$/, '');
}

// Pinterest authenticates the app with HTTP Basic auth on its token endpoint, not with client
// credentials in the body. Shared with routes/pinterest.js's code exchange.
export function basicAuthHeader() {
  return `Basic ${Buffer.from(`${process.env.PINTEREST_APP_ID}:${process.env.PINTEREST_APP_SECRET}`).toString('base64')}`;
}

// Pinterest access tokens last 30 days; the refresh token (stored since the connect flow asked
// for it) renews them. An account with no expiry on file predates that, so its token is used
// as-is until Pinterest rejects it and the account gets flagged for reconnect.
function accessToken(post) {
  if (!post.token_expires_at) return post.access_token;
  return refreshedAccessToken(post, {
    tokenUrl: TOKEN_URL,
    headers: { Authorization: basicAuthHeader() },
    form: { grant_type: 'refresh_token', refresh_token: post.refresh_token },
  });
}

export async function publish(post) {
  const media = post.media || [];
  const image = media.find((m) => m.media_type === 'image');
  if (!image) {
    throw new Error('Pinterest pins need an image attached — video pins are not supported yet.');
  }

  const boardId = post.metadata?.board_id;
  if (!boardId) {
    throw new Error('This Pinterest account has no board on file — reconnect it.');
  }

  const token = await accessToken(post);
  const res = await fetch(`${pinterestApiBase()}/v5/pins`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      board_id: boardId,
      description: post.content,
      media_source: { source_type: 'image_url', url: image.url },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Pinterest pin failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data.id;
}
