import * as mastodonAdapter from './platforms/mastodon.js';
import * as facebookAdapter from './platforms/facebook.js';
import * as instagramAdapter from './platforms/instagram.js';
import * as telegramAdapter from './platforms/telegram.js';
import * as youtubeAdapter from './platforms/youtube.js';
import * as tiktokAdapter from './platforms/tiktok.js';
import * as blueskyAdapter from './platforms/bluesky.js';
import * as threadsAdapter from './platforms/threads.js';
import * as pinterestAdapter from './platforms/pinterest.js';
import * as linkedinAdapter from './platforms/linkedin.js';

// The single source of truth for every social platform Postfalcon knows about. Adding a
// platform means adding an entry here — plus, for a 'live' one, an adapter module under
// lib/platforms/ exporting `publish(post) -> platformPostId`.
//
//   status:
//     'live'        - real publishing is wired up; the scheduler calls `adapter.publish`
//     'stub'        - connectable as a placeholder account; the scheduler no-ops on it
//                     (real posting is planned)
//     'unsupported' - no usable public content-publishing API exists; shown on the connect
//                     page as unavailable and cannot be added
//
//   connect:
//     'oauth'          - dedicated OAuth flow, linked from `connectPath`
//     'oauth-instance' - OAuth flow that first needs an instance domain (Mastodon)
//     'token'          - user supplies a credential (e.g. a bot token) to `connectPath`
//     'manual'         - created directly via POST /api/v1/social-accounts (stubs / testing)
//     'none'           - not connectable at all
//
//   hidden:   no connect button of its own (e.g. Instagram rides the Facebook flow)
//   unlisted: adapter is built but not offered anywhere yet — dropped from the connect page
//             AND the marketing site's platform row. Remove the flag to launch it.
//
// `badge` / `color` are mirrored by public/common.js's PLATFORM_META (avatar badges) —
// keep the two in sync when editing.
export const PLATFORMS = {
  facebook: {
    label: 'Facebook',
    badge: 'f',
    color: '#1877F2',
    status: 'live',
    connect: 'oauth',
    connectPath: '/api/facebook/connect',
    adapter: facebookAdapter,
  },
  instagram: {
    label: 'Instagram',
    badge: 'IG',
    color: '#E1306C',
    status: 'live',
    // Connected through the same Facebook OAuth flow (a Page's linked IG business account),
    // so it has no connect button of its own.
    connect: 'oauth',
    connectPath: '/api/facebook/connect',
    hidden: true,
    adapter: instagramAdapter,
  },
  mastodon: {
    label: 'Mastodon',
    badge: 'M',
    color: '#6364FF',
    status: 'live',
    connect: 'oauth-instance',
    connectPath: '/api/mastodon/connect',
    adapter: mastodonAdapter,
  },
  youtube: {
    label: 'YouTube',
    badge: 'YT',
    color: '#FF0000',
    status: 'live',
    connect: 'oauth',
    connectPath: '/api/youtube/connect',
    hint: 'Connect a Google account. YouTube posts must have a video attached.',
    adapter: youtubeAdapter,
  },
  tiktok: {
    label: 'TikTok',
    badge: 'TT',
    color: '#111111',
    status: 'live',
    connect: 'oauth',
    connectPath: '/api/tiktok/connect',
    hint: 'Connect via TikTok. Posts must have a video attached.',
    adapter: tiktokAdapter,
  },
  telegram: {
    label: 'Telegram',
    badge: 'TG',
    color: '#26A5E4',
    status: 'live',
    connect: 'token',
    connectPath: '/api/telegram/connect',
    adapter: telegramAdapter,
  },
  bluesky: {
    label: 'Bluesky',
    badge: 'BS',
    color: '#1185FE',
    status: 'live',
    // No third-party OAuth yet — the user hands us a handle + an "app password" (generated
    // in Bluesky Settings -> App Passwords, not their real account password). Has its own
    // hardcoded form in views/accounts.ejs, like Telegram's, rather than the generic OAuth loop.
    connect: 'token',
    connectPath: '/api/bluesky/connect',
    adapter: blueskyAdapter,
  },
  threads: {
    label: 'Threads',
    badge: '@',
    color: '#111111',
    status: 'live',
    connect: 'oauth',
    connectPath: '/api/threads/connect',
    hint: 'Connect via Threads. Image and video posts must be reachable at a public URL, which Postfalcon handles for you.',
    adapter: threadsAdapter,
  },

  pinterest: {
    label: 'Pinterest',
    badge: 'P',
    color: '#E60023',
    status: 'live',
    connect: 'oauth',
    connectPath: '/api/pinterest/connect',
    hint: 'Connect via Pinterest. Pins always need an image (no text-only posts) and go to your first board.',
    adapter: pinterestAdapter,
  },
  linkedin: {
    label: 'LinkedIn',
    badge: 'in',
    color: '#0A66C2',
    status: 'live',
    connect: 'oauth',
    connectPath: '/api/linkedin/connect',
    hint: 'Connect your personal LinkedIn profile. Text posts only for now — no image/video yet.',
    // Unlisted until a LinkedIn developer app exists: registering one needs a Company Page,
    // which LinkedIn won't let a low-connection profile create.
    unlisted: true,
    adapter: linkedinAdapter,
  },

  reddit: {
    label: 'Reddit',
    badge: 'R',
    color: '#FF4500',
    status: 'stub',
    connect: 'manual',
    hidden: true,
  },
  // Google's Business Profile API (posting "local posts" to a verified business location) sits
  // behind a manual access-request review from Google that's separate from just enabling the
  // API in a Cloud project — the same kind of gate that kept LinkedIn/Pinterest as stubs before
  // they got real adapters, except Google's process is opaque and can take weeks with no
  // guarantee of approval. Stays a stub until that access is actually in hand to build against.
  google_business: {
    label: 'Google Business Profile',
    badge: 'GB',
    color: '#4285F4',
    status: 'stub',
    connect: 'manual',
    hidden: true,
  },

  // Legacy id kept valid so pre-existing rows (and the test suite, which uses 'twitter' as
  // its generic stub) keep working. Not offered anywhere in the UI.
  // Twitter/X stays unsupported on purpose — its posting API is paid.
  twitter: {
    label: 'X',
    badge: 'X',
    color: '#111111',
    status: 'unsupported',
    connect: 'manual',
    hidden: true,
  },
};

export const PLATFORM_IDS = Object.keys(PLATFORMS);

// Returns the publish adapter for a platform, or null if it isn't a 'live' platform
// (stub / unsupported / unknown) — the scheduler treats a null adapter as a no-op.
export function getAdapter(platformId) {
  const entry = PLATFORMS[platformId];
  return entry && entry.status === 'live' ? entry.adapter : null;
}

// Presentational view of the registry for server-rendered templates — no adapter modules,
// hidden and unlisted entries dropped.
export function connectablePlatforms() {
  return PLATFORM_IDS.filter((id) => !PLATFORMS[id].hidden && !PLATFORMS[id].unlisted).map((id) => {
    const { label, badge, color, status, connect, connectPath, hint } = PLATFORMS[id];
    return { id, label, badge, color, status, connect, connectPath, hint };
  });
}

// Every platform you can actually post to, including ones with no connect button of their
// own (Instagram rides the Facebook flow). For the marketing site's platform row.
export function livePlatforms() {
  return PLATFORM_IDS.filter((id) => PLATFORMS[id].status === 'live' && !PLATFORMS[id].unlisted).map((id) => {
    const { label, badge, color } = PLATFORMS[id];
    return { id, label, badge, color };
  });
}
