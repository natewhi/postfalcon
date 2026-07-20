// Used for avatar URLs pulled from third-party OAuth responses (Mastodon instances chosen by
// the user, Facebook/Instagram Graph API) before persisting — those values are attacker-
// controllable (a user can point Postfox at any Mastodon instance) and get rendered back into
// an HTML attribute client-side, so anything that isn't a well-formed http(s) URL is dropped
// rather than stored.
export function sanitizeUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
