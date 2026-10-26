import { envConfigured } from './config.js';
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
import * as xAdapter from './platforms/x.js';

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
    hint: 'Connect via Pinterest. Pins always need an image (no text-only posts); choose their board after connecting.',
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
    // Unlisted = off by default, so a self-hoster without a LinkedIn developer app (which needs a
    // Company Page) never offers it; switched on per instance from Admin -> Platforms.
    unlisted: true,
    adapter: linkedinAdapter,
  },

  x: {
    label: 'X',
    badge: 'X',
    color: '#111111',
    status: 'live',
    connect: 'oauth',
    connectPath: '/api/x/connect',
    hint: 'Connect your X account. Text and up to 4 images per post; no video yet.',
    // Unlisted until there's an X developer app on a paid API plan: X charges for posting
    // access. Remove the flag (and set X_CLIENT_ID/SECRET) to launch it.
    unlisted: true,
    adapter: xAdapter,
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
  // its generic stub) keep working. Not offered anywhere in the UI. The real X integration
  // lives under the separate 'x' id above.
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

// The env var holding each platform's app credentials (null = needs none), for the admin pages'
// "credentials missing" warnings.
export const PLATFORM_CREDENTIAL_ENV = {
  facebook: 'FACEBOOK_APP_ID',
  instagram: 'FACEBOOK_APP_ID',
  mastodon: null,
  youtube: 'GOOGLE_CLIENT_ID',
  tiktok: 'TIKTOK_CLIENT_KEY',
  telegram: null,
  bluesky: null,
  threads: 'THREADS_CLIENT_ID',
  pinterest: 'PINTEREST_APP_ID',
  linkedin: 'LINKEDIN_CLIENT_ID',
  x: 'X_CLIENT_ID',
};

// How to get each platform working on a new instance, shown on Admin -> Platforms: where to
// create the developer app, the callback URL(s) to register there (paths, joined to BASE_URL by
// the admin route), the .env keys it produces, and the catches worth knowing up front.
// `console: null` = nothing to register; users bring their own credentials.
export const PLATFORM_SETUP = {
  facebook: {
    console: 'https://developers.facebook.com/apps',
    callbacks: ['/api/facebook/callback'],
    env: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET', 'FACEBOOK_CONFIG_ID'],
    steps:
      'Create a Business-type Meta app with Facebook Login for Business and add the callback under Valid OAuth Redirect URIs. FACEBOOK_CONFIG_ID is the login configuration\'s id. Other people can only connect after Meta\'s App Review approves the Pages and Instagram permissions (and business verification).',
  },
  instagram: {
    console: 'https://developers.facebook.com/apps',
    callbacks: ['/api/facebook/callback'],
    env: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'],
    steps:
      "Uses the Facebook app: Instagram professional accounts linked to a Facebook Page connect through it. Add instagram_basic and instagram_content_publish to that app's App Review.",
  },
  mastodon: {
    console: null,
    callbacks: [],
    env: [],
    steps: 'Nothing to set up: Postfalcon registers itself with each Mastodon server the first time someone from it connects.',
  },
  youtube: {
    console: 'https://console.cloud.google.com/apis/credentials',
    callbacks: ['/api/youtube/callback', '/api/auth/google/callback'],
    env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    steps:
      'Enable the YouTube Data API v3, then create an OAuth client of type "Web application" with both callbacks (the second is for Sign in with Google). Until Google verifies the app only test users you list can connect, and uploads are forced private until the YouTube API audit passes.',
  },
  tiktok: {
    console: 'https://developers.tiktok.com/apps',
    callbacks: ['/api/tiktok/callback'],
    env: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
    steps:
      "Add Login Kit and the Content Posting API, and use the app's Production key and secret, not the Sandbox pair. Posts can only be private until TikTok's Direct Post audit passes.",
  },
  telegram: {
    console: null,
    callbacks: [],
    env: [],
    steps: 'Nothing to set up: each user makes a bot with @BotFather, adds it to their channel as an admin, and pastes its token.',
  },
  bluesky: {
    console: null,
    callbacks: [],
    env: [],
    steps: 'Nothing to set up: users connect with their handle and an app password from Bluesky\'s settings.',
  },
  threads: {
    console: 'https://developers.facebook.com/apps',
    callbacks: ['/api/threads/callback'],
    env: ['THREADS_CLIENT_ID', 'THREADS_CLIENT_SECRET'],
    steps:
      'A separate Meta app with the Threads use case; add the callback under Redirect Callback URLs. Other people can only connect after App Review approves threads_basic and threads_content_publish.',
  },
  pinterest: {
    console: 'https://developers.pinterest.com/apps/',
    callbacks: ['/api/pinterest/callback'],
    env: ['PINTEREST_APP_ID', 'PINTEREST_APP_SECRET'],
    steps:
      'New apps get Trial access, which can only create Pins in the API sandbox; apply for Standard access to post real Pins. Users pick the board for their Pins on the Accounts page.',
  },
  linkedin: {
    console: 'https://www.linkedin.com/developers/apps',
    callbacks: ['/api/linkedin/callback'],
    env: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
    steps:
      'The app must be linked to a LinkedIn Company Page (verify it from the app\'s Settings tab). Add the "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn" products; both are approved instantly.',
  },
  x: {
    console: 'https://developer.x.com/en/portal/dashboard',
    callbacks: ['/api/x/callback'],
    env: ['X_CLIENT_ID', 'X_CLIENT_SECRET'],
    steps: 'Turn on OAuth 2.0 as a "Web App" (confidential client). Posting through the X API needs a paid X API plan.',
  },
};

// On/off switches set from the admin Platforms page (platform_settings table, loaded by
// lib/platformSettings.js). A platform with no saved switch falls back to the registry:
// enabled unless `unlisted`. In memory, which is safe because there's one app process
// (ecosystem.config.cjs instances: 1).
const enabledOverrides = new Map();

export function setPlatformOverrides(rows) {
  enabledOverrides.clear();
  for (const { platform, enabled } of rows) enabledOverrides.set(platform, enabled);
}

// Whether a platform is offered: on the connect page and the marketing site, and through its
// connect route. Only live platforms (with an adapter) can be enabled.
export function isPlatformEnabled(platformId) {
  const entry = PLATFORMS[platformId];
  if (!entry || entry.status !== 'live') return false;
  return enabledOverrides.has(platformId) ? enabledOverrides.get(platformId) : !entry.unlisted;
}

// The .env keys a platform needs are filled in (always true for one that needs none).
export function platformCredentialsReady(platformId) {
  const key = PLATFORM_CREDENTIAL_ENV[platformId];
  return !key || envConfigured(key);
}

// What users are actually offered (Accounts page, landing page): switched on AND its keys are
// set. On a fresh install, a platform that's on by default but has no developer app yet stays
// out of sight instead of showing a Connect button that can only fail.
export function isPlatformOffered(platformId) {
  return isPlatformEnabled(platformId) && platformCredentialsReady(platformId);
}

// Switched off from the admin page. Paused platforms also stop publishing (scheduler.js) —
// unlike the default "unlisted" state, which only means "not offered yet".
export function isPlatformPaused(platformId) {
  return enabledOverrides.get(platformId) === false;
}

// Returns the publish adapter for a platform, or null if it isn't a 'live' platform
// (stub / unsupported / unknown) — the scheduler treats a null adapter as a no-op.
export function getAdapter(platformId) {
  const entry = PLATFORMS[platformId];
  return entry && entry.status === 'live' ? entry.adapter : null;
}

// Presentational view of the registry for server-rendered templates — no adapter modules,
// hidden and switched-off entries dropped. Stubs stay (shown as "not yet available").
export function connectablePlatforms() {
  return PLATFORM_IDS.filter(
    (id) => !PLATFORMS[id].hidden && (PLATFORMS[id].status !== 'live' ? !PLATFORMS[id].unlisted : isPlatformOffered(id))
  ).map((id) => {
    const { label, badge, color, status, connect, connectPath, hint } = PLATFORMS[id];
    return { id, label, badge, color, status, connect, connectPath, hint };
  });
}

// Every platform you can actually post to, including ones with no connect button of their
// own (Instagram rides the Facebook flow). For the marketing site's platform row.
export function livePlatforms() {
  return PLATFORM_IDS.filter((id) => isPlatformOffered(id)).map((id) => {
    const { label, badge, color } = PLATFORMS[id];
    return { id, label, badge, color };
  });
}
