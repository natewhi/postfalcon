import { pool } from '../../db/pool.js';

// YouTube and TikTok issue short-lived access tokens (~1h / ~24h) plus a refresh token.
// This refreshes the access token when it's expired (or about to be), persists the new
// token — and a rotated refresh token, if the provider returns one — on the social_accounts
// row, updates the in-memory `post` object, and returns a usable access token.
export async function refreshedAccessToken(post, { tokenUrl, form }) {
  const expiresAt = post.token_expires_at ? new Date(post.token_expires_at).getTime() : 0;
  if (post.access_token && expiresAt - Date.now() > 120000) {
    return post.access_token;
  }
  if (!post.refresh_token) {
    throw new Error('this account has no refresh token — reconnect it');
  }

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(
      `token refresh failed (${res.status}): ${data.error_description || data.error?.message || data.error || 'unknown'}`
    );
  }

  const newExpiry = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;
  const newRefresh = data.refresh_token || post.refresh_token;
  await pool.query(
    'UPDATE social_accounts SET access_token = $1, refresh_token = $2, token_expires_at = $3 WHERE id = $4',
    [data.access_token, newRefresh, newExpiry, post.social_account_id]
  );
  post.access_token = data.access_token;
  post.refresh_token = newRefresh;
  post.token_expires_at = newExpiry;
  return data.access_token;
}
