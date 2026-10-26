import { pool } from '../db/pool.js';
import { PLANS, PLAN_IDS, BILLING_INTERVALS, billingConfigured, selfHosted, priceIdForPlan } from './billing.js';
import { getSignupMode } from './signups.js';
import { pendingMigrations } from './version.js';
import { schedulerHeartbeat } from './schedulerHeartbeat.js';
import { mediaUsage, s3Enabled } from './storage.js';
import { PLATFORMS as PLATFORMS_REGISTRY, PLATFORM_IDS, PLATFORM_CREDENTIAL_ENV, isPlatformEnabled } from './platforms.js';
import { listLocalBackups } from './backup.js';

// The data behind the admin Overview page (views/admin-overview.ejs): setup warnings, publishing
// health, business numbers and storage. Read-only. Nothing here returns a secret value — only
// whether a setting is present, or which mode it implies.

function isSet(value) {
  return Boolean(value && value.trim() && value.trim() !== 'change-me' && !value.includes('change-me'));
}


// level: 'error' (broken — fix it), 'warn' (temporary or test setting — fix before real
// customers), 'ok'. Ordered worst first by the caller.
export async function setupChecks() {
  const checks = [];
  const add = (level, title, detail) => checks.push({ level, title, detail });
  const env = process.env;

  if (env.NODE_ENV !== 'production') add('warn', 'Not running in production mode', 'NODE_ENV is not "production": cookies aren\'t marked secure.');
  if (!isSet(env.SESSION_SECRET) || env.SESSION_SECRET.trim().length < 16) {
    add('error', 'SESSION_SECRET is weak', 'Replace it with a long random string (openssl rand -hex 32), then restart. Everyone will be signed out once.');
  }
  if (!/^https:\/\//.test(env.BASE_URL || '')) add('error', 'BASE_URL is not https', `OAuth callbacks and media links use BASE_URL (${env.BASE_URL || 'unset'}).`);

  const stripeKey = env.STRIPE_SECRET_KEY || '';
  if (!billingConfigured()) {
    add(
      'ok',
      'Self-hosted mode: billing is off',
      'No STRIPE_SECRET_KEY, so every account can publish with no plan or channel limits. Add a key to sell plans.'
    );
  } else {
    if (stripeKey.includes('_test_')) {
      add('warn', 'Stripe is in TEST mode', 'Payments are fake. Before launch: live key in .env, then npm run stripe:setup.');
    } else {
      add('ok', 'Stripe is in live mode', 'Real payments are being taken.');
    }
    if (!isSet(env.STRIPE_WEBHOOK_SECRET)) {
      add('error', 'Stripe webhook secret missing', 'Without STRIPE_WEBHOOK_SECRET no payment ever unlocks an account.');
    }
    const missing = [];
    for (const plan of PLAN_IDS) {
      for (const interval of BILLING_INTERVALS) {
        try {
          if (!(await priceIdForPlan(plan, interval))) missing.push(`${PLANS[plan].name} ${interval}`);
        } catch {
          missing.push(`${PLANS[plan].name} ${interval} (Stripe unreachable)`);
        }
      }
    }
    if (missing.length) add('error', 'Stripe prices missing', `${missing.join(', ')} — run npm run stripe:setup.`);
    if (env.STRIPE_REQUIRE_TERMS !== 'true') {
      add(stripeKey.includes('_live_') ? 'warn' : 'ok', 'Checkout Terms tickbox is off', 'Turn on STRIPE_REQUIRE_TERMS=true once live (after saving the Terms URL in Stripe).');
    }
  }

  if (/sandbox/i.test(env.PINTEREST_API_BASE || '')) {
    add('warn', 'Pinterest is using the API sandbox', 'Pins go to the sandbox, not real boards. Remove PINTEREST_API_BASE once Standard access is approved.');
  }
  if (isSet(env.PINTEREST_SANDBOX_TOKEN)) {
    add('warn', 'Pinterest sandbox token is set', 'Every Pin uses the developer token. Remove PINTEREST_SANDBOX_TOKEN once Standard access is approved, then reconnect.');
  }

  const pending = await pendingMigrations();
  if (pending.length) {
    add(
      'error',
      'Database changes not applied',
      `${pending.join(', ')}. Run npm run migrate (Docker does this when the app starts), then restart.`
    );
  }

  const backups = await listLocalBackups();
  const newest = backups[0];
  if (!newest) {
    add('error', 'No database backup yet', 'Run npm run backup on the server once (it then runs nightly at 03:30).');
  } else if (Date.now() - newest.at.getTime() > 2 * 86400000) {
    add('error', 'Database backups have stopped', `Newest is from ${newest.at.toISOString().slice(0, 10)}. Check the logs for "database backup failed".`);
  } else {
    add('ok', 'Database is backed up', `Newest ${newest.at.toISOString().slice(0, 16).replace('T', ' ')} UTC${s3Enabled() ? ', also copied to the bucket' : ' (server disk only)'}.`);
  }

  const smtp = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'].every((k) => isSet(env[k]));
  if (!smtp) {
    // Optional on a private self-hosted server; a hosted one can't do without password resets.
    add(
      selfHosted() ? 'warn' : 'error',
      'Email is not configured',
      'SMTP_* is incomplete: verification and password-reset emails are only logged, never sent.'
    );
  }
  if (!s3Enabled()) add('ok', 'Media is stored on the server disk', 'S3_BUCKET is unset.');

  // Live platforms, whether each is switched on (admin Platforms page) and has its app credentials.
  const platforms = PLATFORM_IDS.filter((id) => PLATFORMS_REGISTRY[id].status === 'live').map((id) => {
    const key = PLATFORM_CREDENTIAL_ENV[id];
    return { name: PLATFORMS_REGISTRY[id].label, enabled: isPlatformEnabled(id), configured: !key || isSet(env[key]) };
  });
  const waiting = platforms.filter((p) => p.enabled && !p.configured).map((p) => p.name);
  if (waiting.length) {
    add(
      'warn',
      `Hidden until their app keys are set: ${waiting.join(', ')}`,
      'Switched on, but not offered to users until their keys are in .env. Admin → Platforms → "How to set up" has the steps; or switch them off.'
    );
  }

  if (selfHosted() && (await getSignupMode()) === 'open') {
    add(
      'warn',
      'Anyone can sign up',
      'Fine on a private network. On a public address, choose invite-only or closed in Admin → Customers → Sign-ups.'
    );
  }

  const order = { error: 0, warn: 1, ok: 2 };
  checks.sort((a, b) => order[a.level] - order[b.level]);
  return { checks, platforms };
}

export async function schedulerStatus() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS overdue, MIN(scheduled_for) AS oldest
     FROM posts WHERE status = 'scheduled' AND scheduled_for < now() - interval '5 minutes'`
  );
  const { rows: stuck } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM posts WHERE status = 'posting' AND updated_at < now() - interval '15 minutes'`
  );
  return {
    ...schedulerHeartbeat,
    overduePosts: rows[0].overdue,
    oldestOverdue: rows[0].oldest,
    stuckPosting: stuck[0].n,
  };
}

export async function publishingHealth() {
  const [byPlatform, recentFailures, reconnect] = await Promise.all([
    pool.query(
      `SELECT sa.platform,
              COUNT(*) FILTER (WHERE p.status = 'posted' AND p.posted_at > now() - interval '24 hours')::int AS posted,
              COUNT(*) FILTER (WHERE p.status = 'failed' AND p.updated_at > now() - interval '24 hours')::int AS failed
       FROM posts p JOIN social_accounts sa ON sa.id = p.social_account_id
       WHERE p.updated_at > now() - interval '24 hours'
       GROUP BY sa.platform ORDER BY failed DESC, posted DESC`
    ),
    pool.query(
      `SELECT p.id, p.updated_at, p.error_message, sa.platform, sa.display_name, u.email
       FROM posts p JOIN social_accounts sa ON sa.id = p.social_account_id JOIN users u ON u.id = p.user_id
       WHERE p.status = 'failed' AND p.updated_at > now() - interval '24 hours'
       ORDER BY p.updated_at DESC LIMIT 25`
    ),
    pool.query(
      `SELECT sa.id, sa.platform, sa.display_name, sa.needs_reconnect_at, sa.reconnect_reason, u.email
       FROM social_accounts sa JOIN users u ON u.id = sa.user_id
       WHERE sa.needs_reconnect_at IS NOT NULL ORDER BY sa.needs_reconnect_at DESC LIMIT 50`
    ),
  ]);
  return { byPlatform: byPlatform.rows, recentFailures: recentFailures.rows, needsReconnect: reconnect.rows };
}

// Business numbers. "Paying" and "trialing" count only Stripe-backed subscriptions (a renewal
// date set by the webhook), so review/test logins set to active by hand and admins don't
// inflate them. Monthly revenue is an estimate from list prices: a yearly plan counts as a
// twelfth, and discounts/coupons aren't reflected.
export async function businessMetrics() {
  const { rows: [counts] } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS signups_7d,
       COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS signups_30d,
       COUNT(*)::int AS accounts_total,
       COUNT(*) FILTER (WHERE billed AND plan_status = 'trialing')::int AS trialing,
       COUNT(*) FILTER (WHERE billed AND plan_status IN ('active', 'past_due'))::int AS paying,
       COUNT(*) FILTER (WHERE billed AND plan_status = 'past_due')::int AS past_due,
       COUNT(*) FILTER (WHERE plan_cancels_at IS NOT NULL AND plan_status <> 'canceled')::int AS cancelling,
       COUNT(*) FILTER (WHERE plan_status = 'incomplete')::int AS never_started
     FROM (SELECT *, (stripe_customer_id IS NOT NULL AND plan_renews_at IS NOT NULL AND NOT is_admin) AS billed FROM users) u`
  );

  const { rows: paying } = await pool.query(
    `SELECT plan, plan_interval, COUNT(*)::int AS n FROM users
     WHERE stripe_customer_id IS NOT NULL AND plan_renews_at IS NOT NULL AND NOT is_admin
       AND plan_status IN ('active', 'past_due')
     GROUP BY plan, plan_interval`
  );
  let mrr = 0;
  const planMix = {};
  for (const row of paying) {
    const plan = PLANS[row.plan];
    if (!plan) continue;
    mrr += row.n * (row.plan_interval === 'yearly' ? plan.priceUsdYearly / 12 : plan.priceUsd);
    planMix[plan.name] = (planMix[plan.name] ?? 0) + row.n;
  }

  // Trials started in the last 90 days (from the plan_changed events the billing sync logs),
  // and how those whose trial is over turned out.
  const { rows: [trials] } = await pool.query(
    `WITH started AS (
       SELECT DISTINCT user_id FROM product_events
       WHERE event_name = 'plan_changed' AND metadata->>'status' = 'trialing' AND created_at > now() - interval '90 days'
     )
     SELECT COUNT(*)::int AS started,
            COUNT(*) FILTER (WHERE u.plan_status <> 'trialing')::int AS ended,
            COUNT(*) FILTER (WHERE u.plan_status IN ('active', 'past_due'))::int AS converted
     FROM started s JOIN users u ON u.id = s.user_id`
  );

  const { rows: [churn] } = await pool.query(
    `SELECT COUNT(DISTINCT user_id)::int AS n FROM product_events
     WHERE event_name = 'plan_changed' AND metadata->>'status' = 'canceled' AND created_at >= date_trunc('month', now())`
  );

  return {
    ...counts,
    mrrUsd: Math.round(mrr * 100) / 100,
    planMix,
    trials: { ...trials, conversionRate: trials.ended ? trials.converted / trials.ended : null },
    canceledThisMonth: churn.n,
  };
}

export async function storageStatus() {
  const usage = await mediaUsage();
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM post_media');
  return {
    ...usage,
    mediaRows: rows[0].n,
    retentionDays: Number(process.env.MEDIA_RETENTION_DAYS) || 30,
    bucketFreeBytes: 10 * 1024 ** 3,
  };
}
