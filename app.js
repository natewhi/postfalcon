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
import postAnalyticsRouter from './routes/postAnalytics.js';
import mcpRouter from './routes/mcp.js';
import mastodonRouter from './routes/mastodon.js';
import facebookRouter from './routes/facebook.js';
import telegramRouter from './routes/telegram.js';
import youtubeRouter from './routes/youtube.js';
import tiktokRouter from './routes/tiktok.js';
import blueskyRouter from './routes/bluesky.js';
import threadsRouter from './routes/threads.js';
import pinterestRouter from './routes/pinterest.js';
import linkedinRouter from './routes/linkedin.js';
import pagesRouter from './routes/pages.js';
import blogRouter from './routes/blog.js';
import { isBlogEnabled } from './lib/blog.js';
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

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'script-src': ["'self'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:'],
        ...(isProduction ? {} : { 'upgrade-insecure-requests': null }),
      },
    },
  })
);
app.use(pinoHttp({ logger }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProduction ? '7d' : '5m' }));

// Stripe webhook needs the raw request body for signature verification, so it's mounted
// ahead of express.json() (and ahead of csrfProtection — it authenticates by signature,
// not a cookie/session).
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }), billingWebhookRouter);

// Same reasoning as the webhook above, minus the signature check: the analytics proxy just
// relays whatever the tracking script sends, so it forwards the exact raw bytes rather than
// parsing and re-serializing JSON. Also ahead of csrfProtection — it's not under /api and
// isn't cookie/session-authenticated at all.
app.use('/stats', express.raw({ type: '*/*', limit: '256kb' }), analyticsRouter);

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
app.use('/api/mastodon', requireAuth, mastodonRouter);
app.use('/api/facebook', requireAuth, facebookRouter);
app.use('/api/telegram', requireAuth, telegramRouter);
app.use('/api/youtube', requireAuth, youtubeRouter);
app.use('/api/tiktok', requireAuth, tiktokRouter);
app.use('/api/bluesky', requireAuth, blueskyRouter);
app.use('/api/threads', requireAuth, threadsRouter);
app.use('/api/pinterest', requireAuth, pinterestRouter);
app.use('/api/linkedin', requireAuth, linkedinRouter);
app.use('/api/billing', requireAuth, billingRouter);
app.use('/api/v1/social-accounts', requireAuth, apiLimiter, socialAccountsRouter);
app.use('/api/v1/posts', requireAuth, apiLimiter, postsRouter);
app.use('/api/v1/analytics', requireAuth, apiLimiter, postAnalyticsRouter);
app.use('/api/v1/webhooks', requireAuth, apiLimiter, requireCapability('webhooks'), webhooksRouter);
app.use('/api/admin', requireAdmin, adminRouter);

if (isBlogEnabled()) {
  app.use('/blog', blogRouter);
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
  req.log.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'internal_server_error' });
});

export default app;
