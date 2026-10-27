// The dashboard's "Get started" checklist. Each step is worked out from what the user has
// actually done, so it ticks itself off however they did it (the app, the API or an agent):
//   account  connected at least one social account
//   post     scheduled (or published) at least one post; drafts don't count
//   agent    optional: created an API token for an AI assistant
// The card shows until both required steps are done or the user closes it
// (users.onboarding_dismissed_at, migration 032).
import { pool } from '../db/pool.js';
import { PLATFORMS, PLATFORM_CREDENTIAL_ENV, isPlatformOffered, platformCredentialsReady } from './platforms.js';
import { selfHosted } from './billing.js';
import { smtpConfigured } from './config.js';
import { readInstanceSettings } from './instanceSettings.js';
import { listLocalBackups } from './backup.js';

// The platforms that connect in about a minute with no developer app of the user's own.
const QUICK_PLATFORMS = ['mastodon', 'bluesky', 'telegram'];

export async function onboardingStatus(userId) {
  const { rows } = await pool.query(
    `SELECT u.onboarding_dismissed_at IS NOT NULL AS dismissed,
            EXISTS (SELECT 1 FROM social_accounts a WHERE a.user_id = u.id) AS account,
            EXISTS (SELECT 1 FROM posts p WHERE p.user_id = u.id AND p.status <> 'draft') AS post,
            EXISTS (SELECT 1 FROM api_tokens t WHERE t.user_id = u.id) AS agent
       FROM users u
      WHERE u.id = $1`,
    [userId]
  );
  const { dismissed, account, post, agent } = rows[0] ?? {};
  const complete = Boolean(account && post);
  return {
    account: Boolean(account),
    post: Boolean(post),
    agent: Boolean(agent),
    complete,
    dismissed: Boolean(dismissed),
    show: !dismissed && !complete,
    quickPlatforms: QUICK_PLATFORMS.filter(isPlatformOffered).map((id) => PLATFORMS[id].label),
  };
}

export async function dismissOnboarding(userId) {
  await pool.query('UPDATE users SET onboarding_dismissed_at = now() WHERE id = $1', [userId]);
}

// Admins only: "Finish setting up your server", the few things a fresh install still needs.
// Cheap checks only (no Stripe calls) since it runs on every dashboard load; Admin -> Overview
// has the full list. Each step is independent, so every unfinished one keeps its link.
//   signups    self-hosted only: who can sign up has been chosen (instance_settings.signup_mode)
//   email      SMTP is configured, so password resets and alerts get sent
//   platforms  at least one platform that needs a developer app has its keys
//   backup     a database backup exists
export async function adminSetupStatus(user) {
  if (!user.is_admin) return null;
  const [{ rows }, settings, backups] = await Promise.all([
    pool.query('SELECT admin_setup_dismissed_at IS NOT NULL AS dismissed FROM users WHERE id = $1', [user.id]),
    readInstanceSettings(),
    listLocalBackups().catch(() => []),
  ]);
  const steps = [];
  if (selfHosted()) steps.push({ id: 'signups', done: 'signup_mode' in settings });
  steps.push({ id: 'email', done: smtpConfigured() });
  steps.push({
    id: 'platforms',
    done: Object.entries(PLATFORM_CREDENTIAL_ENV).some(([id, key]) => key && platformCredentialsReady(id)),
  });
  steps.push({ id: 'backup', done: backups.length > 0 });
  const doneCount = steps.filter((s) => s.done).length;
  const dismissed = Boolean(rows[0]?.dismissed);
  return {
    steps,
    doneCount,
    complete: doneCount === steps.length,
    dismissed,
    show: !dismissed && doneCount < steps.length,
  };
}

export async function dismissAdminSetup(userId) {
  await pool.query('UPDATE users SET admin_setup_dismissed_at = now() WHERE id = $1', [userId]);
}
