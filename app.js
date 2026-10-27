import express from 'express';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import cookieParser from 'cookie-parser';
import { doubleCsrf } from 'csrf-csrf';
import helmet from 'helmet';
import cors from 'cors';
import multer from 'multer';
import pinoHttp from 'pino-http';
import passport from './lib/passport.js';
import { logger } from './lib/logger.js';
import { pool } from './db/pool.js';
import usersRouter from './routes/users.js';
import authRouter from './routes/auth.js';
import socialAccountsRouter from './routes/socialAccounts.js';
import postsRouter from './routes/posts.js';
import uploadsRouter from './routes/uploads.js';
import { storageProviderName } from './lib/storage.js';
import postAnalyticsRouter from './routes/postAnalytics.js';
import mcpRouter from './routes/mcp.js';
import mastodonRouter from './routes/mastodon.js';
import facebookRouter from './routes/facebook.js';
import telegramRouter from './routes/telegram.js';
import youtubeRouter from './routes/youtube.js';
import tiktokRouter from './routes/tiktok.js';
import blueskyRouter from './routes/bluesky.js';
import threadsRouter from './routes/threads.js';
import metaCallbacksRouter from './routes/metaCallbacks.js';
import pinterestRouter from './routes/pinterest.js';
import linkedinRouter from './routes/linkedin.js';
import xRouter from './routes/x.js';
import onboardingRouter from './routes/onboarding.js';
import { isPlatformEnabled } from './lib/platforms.js';
import { ensurePlatformSettingsLoaded } from './lib/platformSettings.js';
import pagesRouter from './routes/pages.js';
import blogRouter from './routes/blog.js';
import { isBlogEnabled } from './lib/blog.js';
import { readInstanceSettings, resolveSettings, DEFAULT_SITE_NAME } from './lib/instanceSettings.js';
import { billingConfigured } from './lib/billing.js';
import { envConfigured, smtpConfigured } from './lib/config.js';
import analyticsRouter from './routes/analytics.js';
import adminRouter from './routes/admin.js';
import billingRouter from './routes/billing.js';
import billingWebhookRouter from './routes/billingWebhook.js';
import webhooksRouter from './routes/webhooks.js';
import { requireAuth, requireAdmin } from './middleware/auth.js';
import { requireCapability } from './middleware/planLimit.js';
import { apiLimiter } from './middleware/rateLimit.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PgSession = connectPgSimple(session);

const isProduction = process.env.NODE_ENV === 'production';
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (isProduction) {
  app.set('trust proxy', 1);
}

// Available to every view without each route needing to pass it — see isBlogEnabled() in
// lib/blog.js for why a self-hoster would turn this off.
app.locals.blogEnabled = isBlogEnabled();
// Defaults for views rendered without the per-request instance settings below (error pages).
app.locals.siteName = DEFAULT_SITE_NAME;
app.locals.publicSite = true;
app.locals.logoUrl = null;

// The legal name of whoever runs this instance, shown in public footers and the Terms/Privacy
// pages when set. Meta's business verification requires the operator's legal name on the site;
// a self-hoster's instance just leaves it unset.
app.locals.operatorName = process.env.OPERATOR_NAME?.trim() || null;

// Umami tracking (views/partials/analytics.ejs) only when both halves are really set.
app.locals.umamiWebsiteId =
  envConfigured('UMAMI_HOST') && envConfigured('UMAMI_WEBSITE_ID') ? process.env.UMAMI_WEBSITE_ID.trim() : null;
// Australian Business Number, shown next to the name. Accepts it with or without spaces and
// renders the standard "XX XXX XXX XXX" grouping; anything that isn't 11 digits is ignored.
const abnDigits = (process.env.OPERATOR_ABN || '').replace(/\D/g, '');
app.locals.operatorAbn =
  abnDigits.length === 11 ? abnDigits.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4') : null;

// Named in the privacy policy's sharing list when uploads go to a cloud bucket (lib/storage.js).
app.locals.storageProvider = storageProviderName();

// Appended as ?v= to every /*.js and /*.css link in views/. Static files are cached for 7
// days in production, so without this a deploy's new CSS/JS wouldn't reach returning
// visitors until their cache expired. Changes on every process start, i.e. every deploy.
app.locals.assetVersion = Date.now().toString(36);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'script-src': ["'self'"],
        // https: for connected accounts' profile pictures, which live on each platform's CDN
        // (and on any Mastodon instance's own domain, so they can't be allowlisted by host).
        // Images can't run code; the avatars are rendered with referrerpolicy="no-referrer".
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'media-src': ["'self'", 'blob:'],
        ...(isProduction ? {} : { 'upgrade-insecure-requests': null }),
      },
    },
  })
);
app.use(pinoHttp({ logger }));

// The admin's platform on/off switches (lib/platformSettings.js) must be in memory before any
// page or connect route decides what to offer. Loaded once; a failure is retried next request.
app.use((req, res, next) => {
  ensurePlatformSettingsLoaded().then(() => next(), next);
});

// Blocks a platform's connect routes while it's switched off (admin Platforms page), so a
// saved or typed connect URL can't bypass the switch. Open if any of `ids` is enabled.
function platformGate(...ids) {
  return (req, res, next) => {
    if (ids.some(isPlatformEnabled)) return next();
    const message = "This platform isn't available right now.";
    res.status(404).format({
      json: () => res.json({ error: 'platform_unavailable', message }),
      default: () => res.type('text').send(message),
    });
  };
}
app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProduction ? '7d' : '5m' }));
// Uploaded media that isn't on local disk: streamed from the S3 bucket when S3_BUCKET is set
// (lib/storage.js), otherwise falls through to the 404 handler as before.
app.use('/uploads', uploadsRouter);

// Stripe webhook needs the raw request body for signature verification, so it's mounted
// ahead of express.json() (and ahead of csrfProtection — it authenticates by signature,
// not a cookie/session).
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }), billingWebhookRouter);

// Same reasoning as the webhook above, minus the signature check: the analytics proxy just
// relays whatever the tracking script sends, so it forwards the exact raw bytes rather than
// parsing and re-serializing JSON. Also ahead of csrfProtection — it's not under /api and
// isn't cookie/session-authenticated at all.
app.use('/stats', express.raw({ type: '*/*', limit: '256kb' }), analyticsRouter);

// Meta's Threads uninstall / data-deletion callbacks: server-to-server form POSTs carrying a
// signed_request HMAC'd with the app secret, so (like the Stripe webhook) ahead of
// csrfProtection and with no session auth. See routes/metaCallbacks.js.
app.use('/api/meta', express.urlencoded({ extended: false, limit: '16kb' }), metaCallbacksRouter);

app.use(express.json({ limit: '100kb' }));
app.use(
  session({
    store: new PgSession({ pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      secure: isProduction,
    },
  })
);
app.use(passport.initialize());
app.use(passport.session());
// Lets views/partials/sidebar.ejs show the Admin link to admins only. Purely a convenience:
// /admin/* and /api/admin/* enforce requireAdmin themselves (404 for everyone else).
app.use((req, res, next) => {
  res.locals.isAdmin = Boolean(req.user?.is_admin);
  // False in self-hosted mode (no Stripe key): views drop pricing, trial and billing UI.
  res.locals.billingEnabled = billingConfigured();
  // Hides "Continue with Google" on login/signup when this instance has no Google OAuth app.
  res.locals.googleSignIn = envConfigured('GOOGLE_CLIENT_ID');
  // No SMTP = verification emails are only logged, so don't nag people to click one.
  res.locals.emailEnabled = smtpConfigured();
  next();
});

// Admin -> Settings (lib/instanceSettings.js): the site name, and whether the public website
// (landing page, blog) is shown. Only page requests need them; API, MCP and media skip it.
const NO_INSTANCE_SETTINGS = /^\/(api|mcp|stats|uploads|health)(\/|$)/;
app.use((req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) || NO_INSTANCE_SETTINGS.test(req.path)) return next();
  readInstanceSettings()
    .then((stored) => {
      const { siteName, publicSite, logoUrl } = resolveSettings(stored);
      res.locals.siteName = siteName;
      res.locals.logoUrl = logoUrl;
      res.locals.publicSite = publicSite;
      res.locals.blogEnabled = publicSite && isBlogEnabled();
      next();
    }, next);
});
app.use(cookieParser());

// No getSessionIdentifier: Passport (lib/passport.js's SessionManager) regenerates the session
// — i.e. issues a new req.sessionID — on both login AND logout, to guard against session
// fixation. Binding the CSRF hash to req.sessionID (as csrf-csrf's docs suggest as an optional
// hardening) means a token issued right around either boundary can validate against the wrong
// session ID and get rejected, which is exactly what breaks the log-out-then-log-back-in flow.
// The double-submit pattern's actual protection doesn't depend on this: an attacker can't read
// the httpOnly secret cookie to forge the matching header, regardless of session binding.
const { doubleCsrfProtection, generateToken } = doubleCsrf({
  getSecret: () => process.env.SESSION_SECRET,
  cookieName: isProduction ? '__Host-postfalcon.csrf-token' : 'postfalcon.csrf-token',
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
  },
});

// Requests authenticated via a Bearer api_token (MCP/agent access) can't be forged by a
// browser CSRF attack the way cookie-based sessions can, since a cross-origin page can't
// attach a custom Authorization header without a CORS preflight this server won't approve.
// Skipped entirely in tests so the existing supertest suite doesn't need to fetch a token
// for every mutating request (matches the same NODE_ENV=test skip authLimiter already uses).
function csrfProtection(req, res, next) {
  if (process.env.NODE_ENV === 'test' || req.headers.authorization) {
    return next();
  }
  doubleCsrfProtection(req, res, next);
}

app.get('/api/csrf-token', (req, res) => {
  req.session.csrfInit = true;
  // overwrite: true — always mint a fresh token rather than trying to validate-and-reuse
  // whatever CSRF cookie the browser happens to still be carrying. Reuse-with-validation
  // (the default) throws if that cookie doesn't check out, e.g. a leftover cookie from
  // before a logout (logout only touches the session cookie, not this one) — and since this
  // handler isn't wrapped in asyncHandler, an uncaught throw here made this endpoint itself
  // return 403 invalid_csrf_token instead of a token, breaking every request after it.
  res.json({ csrfToken: generateToken(req, res, true) });
});

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS now');
    res.json({ status: 'ok', db: 'connected', time: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

// The versioned, publicly-documented resource API (see /api-docs) — the surface external
// scripts/agents (including the bundled MCP server) are meant to integrate against. CORS is
// open here since Bearer auth isn't cookie-based and can't be forged cross-origin; everything
// else stays same-origin only. Mounted ahead of csrfProtection below: a cross-origin preflight
// OPTIONS request never carries the Authorization header (that's the point of preflight), so
// it wouldn't hit csrfProtection's Bearer-auth exemption — cors() must short-circuit it first.
const publicApiCors = cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Authorization', 'Content-Type'],
});
app.use('/api/v1', publicApiCors);

// Remote MCP endpoint — same Bearer api_token as /api/v1, so a token generated once in
// Settings works for both. Not mounted under /api: it isn't versioned REST, and it has its own
// CORS policy (set inside routes/mcp.js) rather than /api/v1's.
app.use('/mcp', mcpRouter);

app.use('/api', csrfProtection);
app.use('/api/users', usersRouter);
app.use('/api/auth', authRouter);
app.use('/api/mastodon', requireAuth, platformGate('mastodon'), mastodonRouter);
app.use('/api/facebook', requireAuth, platformGate('facebook', 'instagram'), facebookRouter);
app.use('/api/telegram', requireAuth, platformGate('telegram'), telegramRouter);
app.use('/api/youtube', requireAuth, platformGate('youtube'), youtubeRouter);
app.use('/api/tiktok', requireAuth, platformGate('tiktok'), tiktokRouter);
app.use('/api/bluesky', requireAuth, platformGate('bluesky'), blueskyRouter);
app.use('/api/threads', requireAuth, platformGate('threads'), threadsRouter);
app.use('/api/pinterest', requireAuth, platformGate('pinterest'), pinterestRouter);
app.use('/api/linkedin', requireAuth, platformGate('linkedin'), linkedinRouter);
app.use('/api/x', requireAuth, platformGate('x'), xRouter);
app.use('/api/billing', requireAuth, billingRouter);
app.use('/api/onboarding', requireAuth, onboardingRouter);
app.use('/api/v1/social-accounts', requireAuth, apiLimiter, socialAccountsRouter);
app.use('/api/v1/posts', requireAuth, apiLimiter, postsRouter);
app.use('/api/v1/analytics', requireAuth, apiLimiter, postAnalyticsRouter);
app.use('/api/v1/webhooks', requireAuth, apiLimiter, requireCapability('webhooks'), webhooksRouter);
app.use('/api/admin', requireAdmin, adminRouter);

if (isBlogEnabled()) {
  // Also 404 while Admin -> Settings has the public website off.
  app.use('/blog', (req, res, next) => (res.locals.blogEnabled ? next() : res.status(404).render('404')), blogRouter);
}
app.use('/', pagesRouter);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'not found' });
  }
  res.status(404).render('404');
});

app.use((err, req, res, next) => {
  if (err.code === '23505') {
    return res.status(409).json({ error: 'already exists' });
  }
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ error: 'invalid_csrf_token' });
  }
  if (err instanceof multer.MulterError || err.status === 400) {
    return res.status(400).json({ error: err.message });
  }
  // The media bucket (lib/storage.js) failed or hit its daily cap: not a bug in the request.
  if (err.code === 'storage_unavailable') {
    req.log.error({ err: err.cause ?? err }, 'media storage error');
    return res.status(503).json({ error: 'storage_unavailable', message: err.message });
  }
  req.log.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'internal_server_error' });
});

export default app;
