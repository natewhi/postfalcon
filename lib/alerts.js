import { pool } from '../db/pool.js';
import { sendMail } from './mailer.js';
import { logger } from './logger.js';
import { listLocalBackups } from './backup.js';
import { countServerErrorsSince } from './errorLog.js';
import { schedulerHeartbeat } from './schedulerHeartbeat.js';
import { readInstanceSettings } from './instanceSettings.js';
import { PLATFORMS } from './platforms.js';

// Emails the admins when something that needs a person goes wrong, so nobody has to be watching
// Admin -> Overview to find out. scheduler.js runs checkAlerts() every 10 minutes (and Overview's
// "Check now" runs it on demand). Each kind of problem has a key in admin_alerts (migration 031):
// announced once when it starts, reminded every REMIND_HOURS while it lasts, and reported once
// when it clears. All of it goes to every admin in one email per run. Admin -> Settings can turn
// the emails off (alert_emails = 'off'); the problems are still tracked and shown on Overview.
//
// The scheduler runs in this same process, so "the app is down" can't be reported from here:
// that needs an outside uptime check (README). What this catches is the app running but not
// doing its job.

const REMIND_HOURS = 24;
const OVERDUE_MINUTES = 10;
const FAILURE_BURST = 5; // failed posts on one platform within an hour
const ERROR_SPIKE = 20; // server errors within an hour
const BACKUP_STALE_HOURS = 36;

async function overduePosts() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM posts
     WHERE status = 'scheduled' AND scheduled_for < now() - make_interval(mins => $1)`,
    [OVERDUE_MINUTES]
  );
  return rows[0].n;
}

async function stuckPosting() {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM posts WHERE status = 'posting' AND updated_at < now() - interval '15 minutes'"
  );
  return rows[0].n;
}

async function failureBursts() {
  const { rows } = await pool.query(
    `SELECT sa.platform, COUNT(*)::int AS n FROM posts p JOIN social_accounts sa ON sa.id = p.social_account_id
     WHERE p.status = 'failed' AND p.updated_at > now() - interval '1 hour'
     GROUP BY sa.platform HAVING COUNT(*) >= $1`,
    [FAILURE_BURST]
  );
  return rows;
}

// Stale only once the server has been around long enough to have taken one (nightly at 03:30).
async function backupProblem() {
  const newest = (await listLocalBackups())[0];
  const staleBefore = Date.now() - BACKUP_STALE_HOURS * 3600000;
  if (newest) {
    return newest.at.getTime() < staleBefore ? `The newest backup is from ${newest.at.toISOString().slice(0, 16).replace('T', ' ')} UTC.` : null;
  }
  const { rows } = await pool.query('SELECT MIN(created_at) AS first FROM users');
  return rows[0].first && new Date(rows[0].first).getTime() < staleBefore ? 'There is no database backup at all.' : null;
}

// Everything wrong right now, as { key, title, detail }.
export async function currentProblems() {
  const problems = [];
  const [overdue, stuck, bursts, backup, errors] = await Promise.all([
    overduePosts(),
    stuckPosting(),
    failureBursts(),
    backupProblem(),
    countServerErrorsSince(new Date(Date.now() - 3600000)),
  ]);

  if (overdue > 0) {
    problems.push({
      key: 'overdue_posts',
      title: `${overdue} scheduled post${overdue === 1 ? ' is' : 's are'} overdue`,
      detail: `Posts are more than ${OVERDUE_MINUTES} minutes past their time and haven't been sent. The scheduler may be failing: see Admin -> Overview and Activity -> Server errors.`,
    });
  }
  if (stuck > 0) {
    problems.push({
      key: 'stuck_posting',
      title: `${stuck} post${stuck === 1 ? ' has' : 's have'} been "posting" for over 15 minutes`,
      detail: 'Publishing started but never finished, usually because the app restarted mid-send. Check whether they went out, then retry or delete them.',
    });
  }
  if (schedulerHeartbeat.lastError) {
    problems.push({
      key: 'scheduler_error',
      title: 'The scheduler is failing',
      detail: `Its last run failed: ${schedulerHeartbeat.lastError}`,
    });
  }
  for (const { platform, n } of bursts) {
    const label = PLATFORMS[platform]?.label ?? platform;
    problems.push({
      key: `failures_${platform}`,
      title: `${n} ${label} posts failed in the last hour`,
      detail: `Usually ${label} itself having trouble, an expired developer app, or changed API rules. Admin -> Overview lists the reasons.`,
    });
  }
  if (backup) {
    problems.push({
      key: 'backups_stale',
      title: 'Database backups have stopped',
      detail: `${backup} Backups run nightly at 03:30; check Activity -> Server errors for "database backup failed", or use Back up now on Overview.`,
    });
  }
  if (errors >= ERROR_SPIKE) {
    problems.push({
      key: 'server_errors',
      title: `${errors} server errors in the last hour`,
      detail: 'Something is failing repeatedly. Admin -> Activity -> Server errors has the details.',
    });
  }
  return problems;
}

async function adminEmails() {
  const { rows } = await pool.query('SELECT email FROM users WHERE is_admin AND suspended_at IS NULL ORDER BY id');
  return rows.map((r) => r.email);
}

function emailBody({ raised, reminded, resolved }) {
  const section = (heading, alerts, withDetail) =>
    alerts.length
      ? `${heading}\n\n${alerts.map((a) => `- ${a.title}${withDetail && a.detail ? `\n  ${a.detail}` : ''}`).join('\n\n')}\n\n`
      : '';
  return (
    section('New problems:', raised, true) +
    section(`Still going on (reminder every ${REMIND_HOURS} hours):`, reminded, true) +
    section('Resolved:', resolved, false) +
    `Admin -> Overview: ${process.env.BASE_URL}/admin/overview\n`
  );
}

function subjectFor({ raised, reminded, resolved }) {
  const active = [...raised, ...reminded];
  if (active.length === 1) return `Problem on ${process.env.BASE_URL}: ${active[0].title}`;
  if (active.length > 1) return `${active.length} problems on ${process.env.BASE_URL}`;
  return `Resolved on ${process.env.BASE_URL}: ${resolved.map((a) => a.title).join('; ')}`;
}

// Compares what's wrong now with what admins were last told, records the difference, and emails
// it. Returns what happened (for Overview's "Check now" and the tests).
export async function checkAlerts() {
  const problems = await currentProblems();
  const now = new Date();
  const remindBefore = new Date(now.getTime() - REMIND_HOURS * 3600000);
  const { rows: active } = await pool.query('SELECT * FROM admin_alerts WHERE resolved_at IS NULL');
  const activeByKey = new Map(active.map((a) => [a.key, a]));
  const raised = [];
  const reminded = [];
  const resolved = [];

  for (const problem of problems) {
    const existing = activeByKey.get(problem.key);
    if (!existing) {
      await pool.query(
        `INSERT INTO admin_alerts (key, title, detail, active_since, notified_at, resolved_at)
         VALUES ($1, $2, $3, $4, NULL, NULL)
         ON CONFLICT (key) DO UPDATE SET title = EXCLUDED.title, detail = EXCLUDED.detail,
           active_since = EXCLUDED.active_since, notified_at = NULL, resolved_at = NULL`,
        [problem.key, problem.title, problem.detail, now]
      );
      raised.push(problem);
    } else {
      // Keep the wording current (e.g. the count) without restarting the alert.
      await pool.query('UPDATE admin_alerts SET title = $2, detail = $3 WHERE key = $1', [
        problem.key,
        problem.title,
        problem.detail,
      ]);
      if (!existing.notified_at || existing.notified_at < remindBefore) reminded.push(problem);
    }
  }
  const currentKeys = new Set(problems.map((p) => p.key));
  for (const alert of active) {
    if (currentKeys.has(alert.key)) continue;
    await pool.query('UPDATE admin_alerts SET resolved_at = $2 WHERE key = $1', [alert.key, now]);
    // Only worth an email if admins were told it had started.
    if (alert.notified_at) resolved.push(alert);
  }

  const changes = { raised, reminded, resolved };
  let emailedTo = [];
  if (raised.length || reminded.length || resolved.length) {
    const { alert_emails: setting } = await readInstanceSettings();
    if (setting !== 'off') {
      emailedTo = await adminEmails();
      if (emailedTo.length) {
        try {
          await sendMail({ to: emailedTo.join(', '), subject: subjectFor(changes), text: emailBody(changes) });
        } catch (err) {
          // Not marked as notified, so the next run tries again.
          logger.warn({ err }, 'could not email admin alerts');
          emailedTo = [];
        }
      }
    }
    const notifiedKeys = [...raised, ...reminded].map((a) => a.key);
    if (emailedTo.length && notifiedKeys.length) {
      await pool.query('UPDATE admin_alerts SET notified_at = $2 WHERE key = ANY($1)', [notifiedKeys, now]);
    }
  }
  return { raised: raised.map((a) => a.key), reminded: reminded.map((a) => a.key), resolved: resolved.map((a) => a.key), emailedTo };
}

export async function activeAlerts() {
  const { rows } = await pool.query(
    'SELECT key, title, detail, active_since, notified_at FROM admin_alerts WHERE resolved_at IS NULL ORDER BY active_since'
  );
  return rows;
}
