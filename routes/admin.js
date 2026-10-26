import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { billingConfigured, selfHosted, PAID_PLAN_IDS, subscriptionsFor, hasRunningSubscription } from '../lib/billing.js';
import { reconcileSubscriptions } from '../lib/billingSync.js';
import { setupChecks, schedulerStatus, publishingHealth, businessMetrics, storageStatus } from '../lib/adminStatus.js';
import { logProductEvent } from '../lib/activityLog.js';
import {
  PLATFORMS,
  PLATFORM_IDS,
  PLATFORM_CREDENTIAL_ENV,
  PLATFORM_SETUP,
  OPTIONAL_PLATFORM_ENV,
  isPlatformEnabled,
  platformCredentialsReady,
} from '../lib/platforms.js';
import { savePlatformSetting, clearPlatformSetting } from '../lib/platformSettings.js';
import { envConfigured, smtpConfigured } from '../lib/config.js';
import { createToken } from '../lib/tokens.js';
import { sendMail, sendTestMail } from '../lib/mailer.js';
import { deleteUserAccount, BillingUnavailableError } from '../lib/accounts.js';
import { listLocalBackups, runBackup, backupDir, deleteBackup } from '../lib/backup.js';
import { s3Enabled, saveMedia, deleteMedia } from '../lib/storage.js';
import { listServerErrors } from '../lib/errorLog.js';
import { checkAlerts, activeAlerts } from '../lib/alerts.js';
import { versionStatus } from '../lib/version.js';
import {
  SIGNUP_MODES,
  getSignupMode,
  setSignupMode,
  createInvite,
  inviteUrl,
  listInvites,
  revokeInvite,
} from '../lib/signups.js';
import {
  readInstanceSettings,
  resolveSettings,
  saveInstanceSetting,
  clearInstanceSetting,
  DEFAULT_SITE_NAME,
} from '../lib/instanceSettings.js';

const router = Router();

// POST /users/:id/access: grant (or take away) free access for a review or test login.
const accessSchema = z.object({
  grant: z.boolean(),
  plan: z.enum(PAID_PLAN_IDS).default('pro'),
});

// POST /users/:id/admin: make someone an admin, or take it away.
const adminRoleSchema = z.object({ admin: z.boolean() });

// POST /users/:id/suspend, POST /email/test.
const suspendSchema = z.object({ suspended: z.boolean() });
const testEmailSchema = z.object({ to: z.string().trim().toLowerCase().email().optional() });

// GET /failed-posts and POST /failed-posts/retry: failed posts across every customer.
const FAILED_POST_WINDOWS = { '1': 1, '24': 24, '168': 168 };
const failedPostsQuerySchema = z.object({
  hours: z.enum(Object.keys(FAILED_POST_WINDOWS)).default('24'),
  platform: z.string().max(40).optional(),
});
const retrySchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) });

// POST /signups: who may create an account. POST /invites: a one-time signup link.
const signupModeSchema = z.object({ mode: z.enum(SIGNUP_MODES) });
const inviteSchema = z.object({ note: z.string().trim().max(200).optional() });

// POST /settings: site name (null = back to the default) and the public website switch
// ('default' = follow the instance type: on when hosted with Stripe, off when self-hosted).
const settingsSchema = z
  .object({
    site_name: z.string().trim().min(1).max(40).nullable().optional(),
    public_site: z.enum(['on', 'off', 'default']).optional(),
    alert_emails: z.enum(['on', 'off']).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'nothing to change' });

// POST /platforms/:id: switch a platform on or off, or `reset` it to its registry default.
const platformSwitchSchema = z.union([z.object({ enabled: z.boolean() }), z.object({ reset: z.literal(true) })]);

// The old 'twitter' id is only a test placeholder (lib/platforms.js); keep it out of the admin list.
const ADMIN_PLATFORM_IDS = PLATFORM_IDS.filter((id) => id !== 'twitter');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function parsePaging(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.pageSize, 10) || DEFAULT_PAGE_SIZE));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// Builds a "$1 AND $2 AND ..." WHERE clause plus its param list from a list of
// [condition, value] pairs, skipping any pair whose value is empty.
function buildWhere(conditions) {
  const clauses = [];
  const params = [];
  for (const [sql, value] of conditions) {
    if (value === undefined || value === null || value === '') continue;
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// Shared shape across the three endpoints below: a handful of optional equality/range
// filters over a paginated, most-recent-first list, with a count for the pager.
async function paginatedQuery(req, res, { select, from, conditions, orderBy }) {
  const { page, pageSize, offset } = parsePaging(req);
  const { where, params } = buildWhere(conditions);

  const countResult = await pool.query(`SELECT COUNT(*) FROM ${from} ${where}`, params);
  const rowsResult = await pool.query(
    `SELECT ${select} FROM ${from} ${where} ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );

  res.json({ rows: rowsResult.rows, total: Number(countResult.rows[0].count), page, pageSize });
}

router.get(
  '/auth-events',
  asyncHandler(async (req, res) => {
    const { email, eventType, from, to } = req.query;
    await paginatedQuery(req, res, {
      select: '*',
      from: 'auth_events',
      conditions: [
        ['email ILIKE ?', email ? `%${email}%` : undefined],
        ['event_type = ?', eventType],
        ['created_at >= ?', from],
        ['created_at <= ?', to],
      ],
      orderBy: 'created_at DESC',
    });
  })
);

router.get(
  '/page-visits',
  asyncHandler(async (req, res) => {
    const { email, path, from, to } = req.query;
    await paginatedQuery(req, res, {
      select: 'pv.*, u.email',
      from: 'page_visits pv LEFT JOIN users u ON u.id = pv.user_id',
      conditions: [
        ['u.email ILIKE ?', email ? `%${email}%` : undefined],
        ['pv.path ILIKE ?', path ? `%${path}%` : undefined],
        ['pv.created_at >= ?', from],
        ['pv.created_at <= ?', to],
      ],
      orderBy: 'pv.created_at DESC',
    });
  })
);

router.get(
  '/product-events',
  asyncHandler(async (req, res) => {
    const { email, eventName, from, to } = req.query;
    await paginatedQuery(req, res, {
      select: 'pe.*, u.email',
      from: 'product_events pe LEFT JOIN users u ON u.id = pe.user_id',
      conditions: [
        ['u.email ILIKE ?', email ? `%${email}%` : undefined],
        ['pe.event_name = ?', eventName],
        ['pe.created_at >= ?', from],
        ['pe.created_at <= ?', to],
      ],
      orderBy: 'pe.created_at DESC',
    });
  })
);

// Every account's billing state as Postfalcon holds it (the webhook-maintained copy of Stripe).
router.get(
  '/billing',
  asyncHandler(async (req, res) => {
    const { email, status } = req.query;
    await paginatedQuery(req, res, {
      select: `id, email, plan, plan_status, plan_renews_at, plan_cancels_at, stripe_customer_id, is_admin, created_at`,
      from: 'users',
      conditions: [
        ['email ILIKE ?', email ? `%${email}%` : undefined],
        ['plan_status = ?', status],
      ],
      orderBy: 'created_at DESC',
    });
  })
);

// Runs the nightly billing reconciliation now: re-reads every subscriber from Stripe and
// corrects any account that has drifted. Returns how many were checked/corrected.
router.post(
  '/billing/reconcile',
  asyncHandler(async (req, res) => {
    if (!billingConfigured()) {
      return res.status(503).json({ error: 'billing_unavailable', message: 'Billing is not configured on this server.' });
    }
    res.json(await reconcileSubscriptions());
  })
);

// Everything on the Overview page in one call. Each part is independent: one failing (Stripe
// or the bucket unreachable) comes back as { error } instead of failing the whole page.
router.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const parts = { setup: setupChecks, scheduler: schedulerStatus, publishing: publishingHealth, business: businessMetrics, storage: storageStatus };
    const entries = await Promise.all(
      Object.entries(parts).map(async ([key, load]) => {
        try {
          return [key, await load()];
        } catch (err) {
          req.log.error({ err, part: key }, 'admin overview part failed');
          return [key, { error: err.message }];
        }
      })
    );
    res.json(Object.fromEntries(entries));
  })
);

// Setup help for the Platforms page: PLATFORM_SETUP with callback URLs made absolute, and which
// of the platform's .env keys are filled in (never their values).
function setupFor(id) {
  const setup = PLATFORM_SETUP[id];
  if (!setup) return null;
  return {
    console: setup.console,
    callbackUrls: setup.callbacks.map((path) => `${process.env.BASE_URL}${path}`),
    env: setup.env.map((name) => ({ name, set: envConfigured(name), optional: OPTIONAL_PLATFORM_ENV.has(name) })),
    steps: setup.steps,
  };
}

// Every platform with its on/off state, whether its app credentials are set, and how many
// accounts and scheduled posts would be affected by switching it off.
router.get(
  '/platforms',
  asyncHandler(async (req, res) => {
    const [{ rows: saved }, { rows: accounts }, { rows: scheduled }] = await Promise.all([
      pool.query('SELECT platform, enabled, updated_at FROM platform_settings'),
      pool.query('SELECT platform, COUNT(*)::int AS n FROM social_accounts GROUP BY platform'),
      pool.query(
        `SELECT sa.platform, COUNT(*)::int AS n FROM posts p JOIN social_accounts sa ON sa.id = p.social_account_id
         WHERE p.status = 'scheduled' GROUP BY sa.platform`
      ),
    ]);
    const savedBy = Object.fromEntries(saved.map((r) => [r.platform, r]));
    const accountsBy = Object.fromEntries(accounts.map((r) => [r.platform, r.n]));
    const scheduledBy = Object.fromEntries(scheduled.map((r) => [r.platform, r.n]));
    res.json(
      ADMIN_PLATFORM_IDS.map((id) => {
        const entry = PLATFORMS[id];
        return {
          id,
          label: entry.label,
          built: entry.status === 'live',
          enabled: isPlatformEnabled(id),
          defaultEnabled: entry.status === 'live' && !entry.unlisted,
          switchedAt: savedBy[id]?.updated_at ?? null,
          sharesConnectWith: id === 'instagram' ? 'facebook' : id === 'facebook' ? 'instagram' : null,
          credentialsNeeded: PLATFORM_CREDENTIAL_ENV[id],
          credentialsSet: platformCredentialsReady(id),
          connectedAccounts: accountsBy[id] ?? 0,
          scheduledPosts: scheduledBy[id] ?? 0,
          setup: setupFor(id),
        };
      })
    );
  })
);

router.post(
  '/platforms/:id',
  validate(platformSwitchSchema),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!ADMIN_PLATFORM_IDS.includes(id)) return res.status(404).json({ error: 'not found' });
    if ('reset' in req.body) {
      await clearPlatformSetting(id);
    } else {
      if (req.body.enabled && PLATFORMS[id].status !== 'live') {
        return res.status(400).json({ error: 'not_built', message: `${PLATFORMS[id].label} isn't built yet, so it can't be switched on.` });
      }
      await savePlatformSetting(id, req.body.enabled, req.user.id);
    }
    await logProductEvent(req.user.id, 'platform_switched', { platform: id, ...req.body }).catch((err) =>
      req.log.error({ err }, 'failed to record product event')
    );
    res.json({ id, enabled: isPlatformEnabled(id) });
  })
);

// Customer lookup: search by email (newest first).
router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const { rows } = await pool.query(
      `SELECT id, email, plan, plan_status, is_admin, suspended_at, created_at FROM users
       WHERE ($1 = '' OR email ILIKE '%' || $1 || '%')
       ORDER BY created_at DESC LIMIT 25`,
      [q]
    );
    res.json(rows);
  })
);

function stripeDashboardUrl(customerId) {
  if (!customerId) return null;
  const test = (process.env.STRIPE_SECRET_KEY || '').includes('_test_');
  return `https://dashboard.stripe.com/${test ? 'test/' : ''}customers/${customerId}`;
}

// One customer, for support: account, billing, connected channels, recent posts.
router.get(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await pool.query(
      `SELECT id, email, created_at, email_verified_at, google_id IS NOT NULL AS google_login, is_admin, suspended_at,
              plan, plan_status, plan_interval, plan_renews_at, plan_cancels_at, stripe_customer_id
       FROM users WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    const user = rows[0];
    const [accounts, posts, counts, apiToken] = await Promise.all([
      pool.query(
        `SELECT id, platform, display_name, needs_reconnect_at, reconnect_reason, created_at
         FROM social_accounts WHERE user_id = $1 ORDER BY created_at`,
        [id]
      ),
      pool.query(
        `SELECT p.id, p.status, p.content, p.scheduled_for, p.posted_at, p.updated_at, p.error_message, sa.platform
         FROM posts p JOIN social_accounts sa ON sa.id = p.social_account_id
         WHERE p.user_id = $1 ORDER BY p.updated_at DESC LIMIT 20`,
        [id]
      ),
      pool.query(`SELECT status, COUNT(*)::int AS n FROM posts WHERE user_id = $1 GROUP BY status`, [id]),
      pool.query('SELECT created_at, last_used_at FROM api_tokens WHERE user_id = $1', [id]),
    ]);
    res.json({
      user: { ...user, stripeDashboardUrl: stripeDashboardUrl(user.stripe_customer_id) },
      accounts: accounts.rows,
      recentPosts: posts.rows.map((p) => ({ ...p, content: p.content.slice(0, 140) })),
      postCounts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
      apiToken: apiToken.rows[0] ?? null,
    });
  })
);

// Admin rights, without SQL. An admin can't remove their own, so an instance always keeps at
// least one admin (the first account on a fresh install is made one by migration 028).
router.post(
  '/users/:id/admin',
  validate(adminRoleSchema),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    if (id === Number(req.user.id) && !req.body.admin) {
      return res.status(409).json({
        error: 'own_admin',
        message: "You can't remove your own admin rights. Ask another admin to do it.",
      });
    }
    const { rows } = await pool.query('UPDATE users SET is_admin = $2 WHERE id = $1 RETURNING id, email, is_admin', [
      id,
      req.body.admin,
    ]);
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    await logProductEvent(id, 'admin_role_changed', { admin: req.body.admin, by: req.user.id }).catch((err) =>
      req.log.error({ err }, 'failed to record product event')
    );
    res.json(rows[0]);
  })
);

// Sign-ups: the instance-wide mode (open / invite / closed) and the invite links behind
// invite-only (lib/signups.js). The link is returned once, at creation; only its hash is kept.
router.get(
  '/signups',
  asyncHandler(async (req, res) => {
    const [mode, invites] = await Promise.all([getSignupMode(), listInvites()]);
    res.json({ mode, invites });
  })
);

router.post(
  '/signups',
  validate(signupModeSchema),
  asyncHandler(async (req, res) => {
    await setSignupMode(req.body.mode, req.user.id);
    await logProductEvent(req.user.id, 'signup_mode_changed', { mode: req.body.mode }).catch((err) =>
      req.log.error({ err }, 'failed to record product event')
    );
    res.json({ mode: req.body.mode });
  })
);

router.post(
  '/invites',
  validate(inviteSchema),
  asyncHandler(async (req, res) => {
    const { invite, token } = await createInvite({ note: req.body.note || null, userId: req.user.id });
    res.status(201).json({ ...invite, url: inviteUrl(token) });
  })
);

router.delete(
  '/invites/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    if (!(await revokeInvite(id))) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  })
);

// Instance settings (Admin -> Settings, lib/instanceSettings.js).
async function settingsResponse() {
  const stored = await readInstanceSettings();
  const { siteName, publicSite, publicSiteSaved, logoUrl } = resolveSettings(stored);
  return {
    siteName,
    logoUrl,
    siteNameDefault: DEFAULT_SITE_NAME,
    publicSite,
    publicSiteDefault: !selfHosted(),
    publicSiteSaved,
    selfHosted: selfHosted(),
    alertEmails: stored.alert_emails !== 'off',
  };
}

router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    res.json(await settingsResponse());
  })
);

router.post(
  '/settings',
  validate(settingsSchema),
  asyncHandler(async (req, res) => {
    const { site_name: siteName, public_site: publicSite } = req.body;
    if (siteName === null) await clearInstanceSetting('site_name');
    else if (siteName !== undefined) await saveInstanceSetting('site_name', siteName, req.user.id);
    if (publicSite === 'default') await clearInstanceSetting('public_site');
    else if (publicSite !== undefined) await saveInstanceSetting('public_site', publicSite, req.user.id);
    if (req.body.alert_emails !== undefined) await saveInstanceSetting('alert_emails', req.body.alert_emails, req.user.id);
    await logProductEvent(req.user.id, 'instance_settings_changed', req.body).catch((err) =>
      req.log.error({ err }, 'failed to record product event')
    );
    res.json(await settingsResponse());
  })
);

// The site logo (Admin -> Settings). PNG, JPEG or WebP only, never SVG: an SVG can carry script,
// and served from this origin it would run if opened directly. Whatever comes in is redrawn by
// sharp as a 256px square PNG (which also drops metadata) and stored with the other media, so it
// survives redeploys and lives in the bucket when there is one. The previous file is removed.
const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (LOGO_TYPES.has(file.mimetype)) return cb(null, true);
    const err = new Error('The logo must be a PNG, JPEG or WebP image.');
    err.status = 400;
    cb(err);
  },
}).single('logo');

async function removeLogoFile(name, log) {
  if (typeof name === 'string') await deleteMedia(name).catch((err) => log.warn({ err }, 'could not delete old logo'));
}

router.post(
  '/settings/logo',
  uploadLogo,
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Choose an image to upload.' });
    let png;
    try {
      png = await sharp(req.file.buffer)
        .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
    } catch {
      return res.status(400).json({ error: 'bad_image', message: "That file couldn't be read as an image." });
    }
    const name = `${crypto.randomUUID()}.png`;
    await saveMedia(name, png, 'image/png');
    const { logo: previous } = await readInstanceSettings();
    await saveInstanceSetting('logo', name, req.user.id);
    await removeLogoFile(previous, req.log);
    await logAdminAction(req, req.user.id, 'instance_logo_changed');
    res.json(await settingsResponse());
  })
);

router.delete(
  '/settings/logo',
  asyncHandler(async (req, res) => {
    const { logo: previous } = await readInstanceSettings();
    await clearInstanceSetting('logo');
    await removeLogoFile(previous, req.log);
    res.json(await settingsResponse());
  })
);

// Account actions for support, so none of them needs SQL or the user's own inbox: a password
// reset link to hand over (no SMTP on this server, or "the email never came"), verification,
// suspension, deleting the account, and revoking a leaked API token. A reset link, suspension or
// deletion is refused for another admin (remove their admin rights first; otherwise one admin
// could take over another's account) and for yourself (use the normal forgot-password page).
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function findUser(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return null;
  }
  const { rows } = await pool.query(
    'SELECT id, email, is_admin, email_verified_at, suspended_at FROM users WHERE id = $1',
    [id]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  return { ...rows[0], id: Number(rows[0].id) };
}

// pg returns BIGINT ids as strings, hence Number() on both sides.
function refuseSelfOrAdmin(req, res, user, action) {
  if (user.id === Number(req.user.id)) {
    res.status(409).json({ error: 'own_account', message: `You can't ${action} your own account from here.` });
    return true;
  }
  if (user.is_admin) {
    res.status(409).json({ error: 'is_admin', message: `Remove their admin rights before you ${action} this account.` });
    return true;
  }
  return false;
}

function logAdminAction(req, userId, event, details = {}) {
  return logProductEvent(userId, event, { ...details, by: req.user.id }).catch((err) =>
    req.log.error({ err }, 'failed to record product event')
  );
}

router.post(
  '/users/:id/password-reset-link',
  asyncHandler(async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    if (refuseSelfOrAdmin(req, res, user, 'make a password reset link for')) return;
    // A day rather than the emailed link's hour: it goes through the admin first.
    const token = await createToken(user.id, 'password_reset', ONE_DAY_MS);
    await logAdminAction(req, user.id, 'admin_password_reset_link');
    res.status(201).json({
      url: `${process.env.BASE_URL}/reset-password?token=${token}`,
      expires_at: new Date(Date.now() + ONE_DAY_MS),
    });
  })
);

router.post(
  '/users/:id/verification-email',
  asyncHandler(async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    if (user.email_verified_at) {
      return res.status(409).json({ error: 'already_verified', message: 'This email is already verified.' });
    }
    const token = await createToken(user.id, 'email_verification', ONE_DAY_MS);
    const verifyUrl = `${process.env.BASE_URL}/api/auth/verify-email?token=${token}`;
    await sendMail({ to: user.email, subject: 'Verify your Postfalcon email', text: `Verify your email: ${verifyUrl}` });
    // emailConfigured false = it was only logged; the page says so rather than claiming "sent".
    res.json({ emailConfigured: smtpConfigured() });
  })
);

router.post(
  '/users/:id/verify-email',
  asyncHandler(async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    const { rows } = await pool.query(
      'UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1 RETURNING email_verified_at',
      [user.id]
    );
    await logAdminAction(req, user.id, 'admin_email_verified');
    res.json({ email_verified_at: rows[0].email_verified_at });
  })
);

router.post(
  '/users/:id/suspend',
  validate(suspendSchema),
  asyncHandler(async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    if (req.body.suspended && refuseSelfOrAdmin(req, res, user, 'suspend')) return;
    const { rows } = await pool.query(
      req.body.suspended
        ? 'UPDATE users SET suspended_at = COALESCE(suspended_at, now()) WHERE id = $1 RETURNING suspended_at'
        : 'UPDATE users SET suspended_at = NULL WHERE id = $1 RETURNING suspended_at',
      [user.id]
    );
    await logAdminAction(req, user.id, req.body.suspended ? 'admin_suspended' : 'admin_unsuspended');
    res.json({ suspended_at: rows[0].suspended_at });
  })
);

router.delete(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    if (refuseSelfOrAdmin(req, res, user, 'delete')) return;
    try {
      // Recorded against the admin, since the deleted account's own rows go with it.
      await deleteUserAccount(user.id, {
        log: req.log,
        beforeDelete: (email) => logAdminAction(req, req.user.id, 'admin_deleted_account', { email, userId: user.id }),
      });
    } catch (err) {
      if (!(err instanceof BillingUnavailableError)) throw err;
      return res.status(503).json({ error: 'billing_unavailable', message: `${err.message} Try again in a few minutes.` });
    }
    // The same notice as deleting your own account, so nobody's account just disappears.
    await sendMail({
      to: user.email,
      subject: 'Your Postfalcon account was deleted',
      text: 'Your account and all its data were deleted by the site administrator. Reply to this email if you think this was a mistake.',
    }).catch((err) => req.log.warn({ err }, 'could not send account deletion notice'));
    res.status(204).end();
  })
);

router.delete(
  '/users/:id/api-token',
  asyncHandler(async (req, res) => {
    const user = await findUser(req, res);
    if (!user) return;
    const { rowCount } = await pool.query('DELETE FROM api_tokens WHERE user_id = $1', [user.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'not found', message: 'This customer has no API token.' });
    await logAdminAction(req, user.id, 'admin_api_token_revoked');
    res.status(204).end();
  })
);

// Overview -> Email: sends a real message and reports the SMTP server's answer.
router.post(
  '/email/test',
  validate(testEmailSchema),
  asyncHandler(async (req, res) => {
    const to = req.body.to || req.user.email;
    try {
      res.json({ ok: true, ...(await sendTestMail(to)) });
    } catch (err) {
      req.log.warn({ err }, 'test email failed');
      res.status(502).json({ ok: false, error: 'email_failed', message: err.message });
    }
  })
);

// Overview -> Backups: the kept database backups, one on demand, and downloading one.
router.get(
  '/backups',
  asyncHandler(async (req, res) => {
    res.json({ dir: backupDir(), copiedToBucket: s3Enabled(), backups: await listLocalBackups() });
  })
);

router.post(
  '/backups',
  asyncHandler(async (req, res) => {
    try {
      const result = await runBackup();
      await logAdminAction(req, req.user.id, 'admin_backup_run', { name: result.name });
      res.status(201).json(result);
    } catch (err) {
      req.log.error({ err }, 'database backup failed');
      res.status(500).json({ error: 'backup_failed', message: err.message });
    }
  })
);

router.get(
  '/backups/:name',
  asyncHandler(async (req, res) => {
    // Only a file the listing knows about: no paths, nothing outside the backup directory.
    const backup = (await listLocalBackups()).find((b) => b.name === req.params.name);
    if (!backup) return res.status(404).json({ error: 'not found' });
    res.download(path.join(backupDir(), backup.name), backup.name);
  })
);

router.delete(
  '/backups/:name',
  asyncHandler(async (req, res) => {
    const result = await deleteBackup(req.params.name);
    if (!result) return res.status(404).json({ error: 'not found' });
    await logAdminAction(req, req.user.id, 'admin_backup_deleted', result);
    res.json(result);
  })
);

// Activity -> Server errors (lib/errorLog.js) and Overview -> Alerts (lib/alerts.js).
router.get(
  '/errors',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json(await listServerErrors({ limit }));
  })
);

router.get(
  '/alerts',
  asyncHandler(async (req, res) => {
    const { alert_emails: setting } = await readInstanceSettings();
    res.json({ alerts: await activeAlerts(), emailsOn: setting !== 'off', emailConfigured: smtpConfigured() });
  })
);

// Runs the same check as the 10-minute job now, emailing anything new.
router.post(
  '/alerts/check',
  asyncHandler(async (req, res) => {
    const result = await checkAlerts();
    res.json({ ...result, alerts: await activeAlerts() });
  })
);

// Overview -> Version (lib/version.js): the running commit, how far behind GitHub it is, and
// any migrations not applied.
router.get(
  '/version',
  asyncHandler(async (req, res) => {
    res.json(await versionStatus());
  })
);

// Overview -> Failed posts: every customer's failures in a window, optionally one platform, so
// that after an outage (a platform down for an hour) they can all be retried at once. Retrying
// is what a customer's own retry does: back to 'scheduled', so the next scheduler run sends it
// (a post still failing for its own reasons simply fails again). A week at most, since media of
// failed posts is cleaned up after MEDIA_RETENTION_DAYS.
router.get(
  '/failed-posts',
  asyncHandler(async (req, res) => {
    const parsed = failedPostsQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
    const { hours, platform } = parsed.data;
    const { rows } = await pool.query(
      `SELECT p.id, p.updated_at, p.content, p.error_message, sa.platform, sa.display_name, u.email
       FROM posts p JOIN social_accounts sa ON sa.id = p.social_account_id JOIN users u ON u.id = p.user_id
       WHERE p.status = 'failed' AND p.updated_at > now() - make_interval(hours => $1)
         AND ($2::text IS NULL OR sa.platform = $2)
       ORDER BY p.updated_at DESC LIMIT 500`,
      [FAILED_POST_WINDOWS[hours], platform || null]
    );
    res.json(rows.map((r) => ({ ...r, content: r.content.slice(0, 140) })));
  })
);

router.post(
  '/failed-posts/retry',
  validate(retrySchema),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE posts SET status = 'scheduled'
       WHERE id = ANY($1) AND status = 'failed' AND updated_at > now() - interval '7 days'
       RETURNING id`,
      [req.body.ids]
    );
    await logProductEvent(req.user.id, 'admin_posts_retried', { count: rows.length }).catch((err) =>
      req.log.error({ err }, 'failed to record product event')
    );
    res.json({ retried: rows.map((r) => Number(r.id)) });
  })
);

// Free access for a review or test login, or taking it away, without SQL on the server. Refused
// for anyone with a running Stripe subscription: Stripe is the source of truth for them, and the
// webhook / nightly reconciliation would undo the change anyway.
router.post(
  '/users/:id/access',
  validate(accessSchema),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await pool.query('SELECT id, stripe_customer_id FROM users WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });

    if (rows[0].stripe_customer_id && billingConfigured()) {
      if (hasRunningSubscription(await subscriptionsFor(rows[0].stripe_customer_id))) {
        return res.status(409).json({
          error: 'has_subscription',
          message: 'This customer has a Stripe subscription. Change their plan in Stripe instead.',
        });
      }
    }

    const { grant, plan } = req.body;
    const { rows: updated } = await pool.query(
      grant
        ? `UPDATE users SET plan = $2, plan_status = 'active', plan_renews_at = NULL, plan_cancels_at = NULL
           WHERE id = $1 RETURNING id, email, plan, plan_status`
        : `UPDATE users SET plan_status = 'canceled', plan_cancels_at = NULL WHERE id = $1
           RETURNING id, email, plan, plan_status`,
      grant ? [id, plan] : [id]
    );
    await logProductEvent(id, 'admin_access_changed', { grant, plan: grant ? plan : undefined, by: req.user.id }).catch(
      (err) => req.log.error({ err }, 'failed to record product event')
    );
    res.json(updated[0]);
  })
);

export default router;
