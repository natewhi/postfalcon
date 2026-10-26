// Admin Overview: renders GET /api/admin/overview (lib/adminStatus.js). Each part can come back
// as { error } on its own, so one unreachable service doesn't blank the page.

function when(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

function ago(value) {
  if (!value) return 'never';
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function bytes(n) {
  if (n == null) return '—';
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function checkItem(level, title, detail) {
  return `<li class="admin-check admin-check-${level}"><span class="admin-check-badge">${
    { error: 'Fix', warn: 'Check', ok: 'OK' }[level]
  }</span><div><strong>${escapeHtml(title)}</strong>${detail ? `<p>${escapeHtml(detail)}</p>` : ''}</div></li>`;
}

function tile(label, value, sub = '') {
  return `<div class="an-tile"><span class="an-tile-label">${escapeHtml(label)}</span><span class="an-tile-value">${escapeHtml(
    String(value)
  )}</span>${sub ? `<span class="an-tile-sub">${escapeHtml(sub)}</span>` : ''}</div>`;
}

function rowsOrEmpty(rows, columns, empty) {
  if (!rows.length) return `<tr><td colspan="${columns}" class="empty">${escapeHtml(empty)}</td></tr>`;
  return rows.join('');
}

function partError(part) {
  return part?.error ? `Couldn't load: ${part.error}` : null;
}

function renderSetup(setup) {
  const list = document.getElementById('setup-checks');
  if (partError(setup)) {
    list.innerHTML = checkItem('error', 'Setup checks failed', partError(setup));
    return;
  }
  list.innerHTML = setup.checks.map((c) => checkItem(c.level, c.title, c.detail)).join('');
  document.getElementById('setup-platforms').innerHTML = setup.platforms
    .map((p) => {
      const note = !p.enabled ? ' (off)' : !p.configured ? ' (no credentials)' : '';
      return `<span class="admin-chip ${p.enabled && p.configured ? 'is-on' : 'is-off'}">${p.enabled ? '✓' : '✕'} ${escapeHtml(p.name)}${note}</span>`;
    })
    .join('');
}

function renderScheduler(s) {
  const list = document.getElementById('scheduler-status');
  if (partError(s)) {
    list.innerHTML = checkItem('error', 'Scheduler status failed', partError(s));
    return;
  }
  const items = [];
  const lastTickMs = s.lastTickAt ? Date.now() - new Date(s.lastTickAt).getTime() : null;
  if (!s.startedAt) {
    items.push(checkItem('error', 'Scheduler is not running in this process', 'Posts will not publish. Check pm2 for the app process.'));
  } else if (lastTickMs === null || lastTickMs > 3 * 60 * 1000) {
    items.push(checkItem(s.lastTickAt ? 'error' : 'warn', `Last run ${ago(s.lastTickAt)}`, `It should run every minute. Started ${when(s.startedAt)}.`));
  } else {
    items.push(checkItem('ok', `Running — last run ${ago(s.lastTickAt)}`, `Started ${when(s.startedAt)}.`));
  }
  if (s.lastError) items.push(checkItem('error', 'Last run failed', s.lastError));
  if (s.overduePosts) {
    items.push(checkItem('error', `${s.overduePosts} post(s) overdue`, `Scheduled but not sent; oldest due ${when(s.oldestOverdue)}.`));
  }
  if (s.stuckPosting) {
    items.push(checkItem('warn', `${s.stuckPosting} post(s) stuck publishing`, 'In "posting" for over 15 minutes, usually after a restart mid-upload.'));
  }
  list.innerHTML = items.join('');
}

function renderPublishing(p) {
  const err = partError(p);
  document.getElementById('publishing-by-platform').innerHTML = err
    ? `<tr><td colspan="3" class="empty">${escapeHtml(err)}</td></tr>`
    : rowsOrEmpty(
        p.byPlatform.map(
          (r) =>
            `<tr><td>${escapeHtml(r.platform)}</td><td class="nowrap">${r.posted}</td><td class="nowrap${r.failed ? ' admin-bad' : ''}">${r.failed}</td></tr>`
        ),
        3,
        'Nothing published or failed in the last 24 hours.'
      );
  if (err) return;
  document.getElementById('publishing-reconnect').innerHTML = rowsOrEmpty(
    p.needsReconnect.map(
      (a) =>
        `<tr><td class="nowrap">${when(a.needs_reconnect_at)}</td><td class="nowrap">${escapeHtml(a.platform)}</td><td>${escapeHtml(
          a.display_name || ''
        )}</td><td>${escapeHtml(a.email)}</td><td>${escapeHtml((a.reconnect_reason || '').slice(0, 200))}</td></tr>`
    ),
    5,
    'None.'
  );
}

function renderBusiness(b) {
  const tiles = document.getElementById('business-tiles');
  if (partError(b)) {
    tiles.innerHTML = tile('Error', '!', partError(b));
    return;
  }
  const rate = b.trials.conversionRate == null ? '—' : `${Math.round(b.trials.conversionRate * 100)}%`;
  const mix = Object.entries(b.planMix).map(([name, n]) => `${name} ${n}`).join(' · ');
  tiles.innerHTML = [
    tile('Est. monthly revenue', `$${b.mrrUsd.toFixed(2)}`, mix || 'No paying customers yet'),
    tile('Paying customers', b.paying, b.past_due ? `${b.past_due} with a failed payment` : ''),
    tile('On free trial', b.trialing),
    tile('Trial → paid', rate, `${b.trials.converted} of ${b.trials.ended} finished trials (90 days)`),
    tile('Signups', b.signups_7d, `last 7 days · ${b.signups_30d} in 30 days`),
    tile('Cancellations', b.canceledThisMonth, `ended this month · ${b.cancelling} cancelling at period end`),
  ].join('');
  document.getElementById('business-note').textContent =
    `${b.accounts_total} accounts in total, ${b.never_started} never started a trial. Counts exclude admins and logins given access by hand; revenue uses list prices (a yearly plan counts as a twelfth).`;
}

function renderStorage(s) {
  const tiles = document.getElementById('storage-tiles');
  if (partError(s)) {
    tiles.innerHTML = tile('Error', '!', partError(s));
    return;
  }
  const parts = [tile('On the server disk', bytes(s.local.bytes), `${s.local.files} files`)];
  if (s.bucket) {
    const pct = Math.round((s.bucket.bytes / s.bucketFreeBytes) * 100);
    parts.push(tile('In the bucket', bytes(s.bucket.bytes), `${s.bucket.files} files · ${pct}% of the free 10 GB`));
  }
  parts.push(tile('Media attached to posts', s.mediaRows, `kept ${s.retentionDays} days after posting`));
  tiles.innerHTML = parts.join('');
  document.getElementById('storage-note').textContent = s.bucket
    ? `Bucket size is checked at most once an hour (last ${when(s.bucket.checkedAt)}). Daily download use isn't available through the storage API — see Caps & Alerts in Backblaze.`
    : 'No bucket configured: media lives on the server disk.';
}

// Alerts (lib/alerts.js): what admins have been (or will be) emailed about.
function renderAlerts({ alerts, emailsOn, emailConfigured }) {
  document.getElementById('alerts-list').innerHTML = alerts.length
    ? alerts.map((a) => checkItem('error', a.title, `${a.detail || ''} Since ${when(a.active_since)}.`)).join('')
    : checkItem('ok', 'No problems right now', '');
  let note = 'Checked every 10 minutes; admins are emailed when a problem starts, daily while it lasts, and when it clears.';
  if (!emailsOn) note = 'Checked every 10 minutes. Alert emails are off (Admin → Settings), so problems only show here.';
  else if (!emailConfigured) note += " Email isn't set up on this server, so they're only written to the log.";
  document.getElementById('alerts-note').textContent = note;
}

async function loadAlerts() {
  try {
    renderAlerts(await apiJson('/api/admin/alerts'));
  } catch (err) {
    document.getElementById('alerts-list').innerHTML = checkItem('warn', "Couldn't load alerts", err.message);
  }
}

const alertsBtn = document.getElementById('alerts-check');
alertsBtn.addEventListener(
  'click',
  withLoading(alertsBtn, 'Checking…', async () => {
    try {
      const result = await apiJson('/api/admin/alerts/check', { method: 'POST' });
      const { alerts } = result;
      const { emailsOn, emailConfigured } = await apiJson('/api/admin/alerts');
      renderAlerts({ alerts, emailsOn, emailConfigured });
      const sent = result.emailedTo.length ? ` Emailed ${result.emailedTo.length} admin(s).` : '';
      showToast(`${alerts.length ? `${alerts.length} problem(s) found.` : 'No problems found.'}${sent}`, alerts.length ? 'warning' : 'success');
    } catch (err) {
      showToast(err.message);
    }
  })
);

// Failed posts across customers (GET /api/admin/failed-posts), retried one at a time or all shown.
let failedPostIds = [];

async function loadFailedPosts() {
  const body = document.getElementById('publishing-failures');
  const params = new URLSearchParams({ hours: document.getElementById('failed-hours').value });
  const platform = document.getElementById('failed-platform').value;
  if (platform) params.set('platform', platform);
  try {
    const posts = await apiJson(`/api/admin/failed-posts?${params}`);
    failedPostIds = posts.map((f) => f.id);
    const retryAll = document.getElementById('failed-retry-all');
    retryAll.disabled = posts.length === 0;
    retryAll.textContent = posts.length ? `Retry all ${posts.length} shown` : 'Retry all shown';
    body.innerHTML = rowsOrEmpty(
      posts.map(
        (f) =>
          `<tr><td class="nowrap">${when(f.updated_at)}</td><td class="nowrap">${escapeHtml(f.platform)}</td><td>${escapeHtml(
            f.display_name || ''
          )}</td><td>${escapeHtml(f.email)}</td><td>${escapeHtml((f.error_message || '').slice(0, 300))}</td><td class="nowrap"><button type="button" class="btn-secondary" data-retry-post="${
            f.id
          }">Retry</button></td></tr>`
      ),
      6,
      'No failed posts in this window.'
    );
  } catch (err) {
    body.innerHTML = `<tr><td colspan="6" class="empty">Couldn't load failed posts: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function retryPosts(ids, confirmMessage) {
  if (confirmMessage && !(await confirmDialog(confirmMessage, { confirmText: 'Retry' }))) return;
  try {
    const { retried } = await apiJson('/api/admin/failed-posts/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    showToast(`${retried.length} post${retried.length === 1 ? '' : 's'} queued again; they go out within a minute.`, 'success');
    loadFailedPosts();
  } catch (err) {
    showToast(err.message);
  }
}

const failedPlatform = document.getElementById('failed-platform');
failedPlatform.innerHTML += Object.keys(PLATFORM_META)
  .filter((id) => id !== 'twitter')
  .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`)
  .join('');
document.getElementById('failed-hours').addEventListener('change', loadFailedPosts);
failedPlatform.addEventListener('change', loadFailedPosts);
document.getElementById('failed-retry-all').addEventListener('click', () =>
  retryPosts(
    failedPostIds,
    `Retry all ${failedPostIds.length} failed posts shown? They go out on the next scheduler run, for every customer they belong to.`
  )
);
document.getElementById('publishing-failures').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-retry-post]');
  if (btn) retryPosts([Number(btn.dataset.retryPost)]);
});

// Version (lib/version.js): running commit vs the project's GitHub main, and migrations.
function shortCommit(sha) {
  return sha ? sha.slice(0, 7) : 'unknown';
}

async function loadVersion() {
  const list = document.getElementById('version-status');
  try {
    const v = await apiJson('/api/admin/version');
    const items = [];
    const up = v.upstream;
    if (up.disabled) {
      items.push(checkItem('ok', `Running ${shortCommit(v.commit)}`, 'Update check is off (UPDATE_CHECK=false).'));
    } else if (up.error) {
      items.push(checkItem('warn', `Running ${shortCommit(v.commit)}`, `Couldn't check ${up.repo} for updates: ${up.error}.`));
    } else if (up.behindBy === 0) {
      items.push(checkItem('ok', `Up to date (${shortCommit(v.commit)})`, `Same as ${up.repo} main.`));
    } else {
      const behind = up.behindBy ? `${up.behindBy} commit${up.behindBy === 1 ? '' : 's'} behind` : 'Not the latest version';
      items.push(
        checkItem(
          'warn',
          `${behind}: running ${shortCommit(v.commit)}, latest is ${shortCommit(up.latestCommit)} (${when(up.latestDate)})`,
          'To update: git pull, then docker compose up -d --build (Docker) or scripts/deploy.sh (pm2). See README → Updating.'
        )
      );
    }
    items.push(
      v.pendingMigrations.length
        ? checkItem('error', 'Database changes not applied', `${v.pendingMigrations.join(', ')}. Run npm run migrate, then restart.`)
        : checkItem('ok', 'Database is up to date', 'Every migration is applied.')
    );
    list.innerHTML = items.join('');
  } catch (err) {
    list.innerHTML = checkItem('warn', "Couldn't read the version", err.message);
  }
}

// Backups: every kept file with a download link, and a backup on demand (routes/admin.js).
async function loadBackups() {
  const body = document.getElementById('backup-rows');
  try {
    const { dir, copiedToBucket, backups } = await apiJson('/api/admin/backups');
    document.getElementById('backup-dir').textContent = dir;
    document.getElementById('backups-note').textContent = `Nightly at 03:30 (server time); the last 7 are kept in ${dir}${
      copiedToBucket ? ' and copied to the bucket' : ' on this server only — set S3_BUCKET to keep copies off it too'
    }.`;
    body.innerHTML = rowsOrEmpty(
      backups.map(
        (b) =>
          `<tr><td><code>${escapeHtml(b.name)}</code></td><td class="nowrap">${escapeHtml(when(b.at))} (${escapeHtml(
            ago(b.at)
          )})</td><td class="nowrap">${escapeHtml(bytes(b.bytes))}</td><td class="nowrap"><a href="/api/admin/backups/${encodeURIComponent(
            b.name
          )}" download>Download</a></td></tr>`
      ),
      4,
      'No backups yet. Take one now.'
    );
  } catch (err) {
    body.innerHTML = `<tr><td colspan="4" class="empty">Couldn't list backups: ${escapeHtml(err.message)}</td></tr>`;
  }
}

const backupBtn = document.getElementById('backup-now');
backupBtn.addEventListener(
  'click',
  withLoading(backupBtn, 'Backing up…', async () => {
    try {
      const result = await apiJson('/api/admin/backups', { method: 'POST' });
      showToast(`Backed up (${bytes(result.bytes)})${result.uploaded ? ', and copied to the bucket' : ''}.`, 'success');
      loadBackups();
    } catch (err) {
      showToast(`Backup failed: ${err.message}`);
    }
  })
);

// Email: a real test message, with the mail server's reply shown as-is.
const testEmailForm = document.getElementById('test-email-form');
testEmailForm.addEventListener(
  'submit',
  withLoading(testEmailForm.querySelector('button'), 'Sending…', async (e) => {
    e.preventDefault();
    const result = document.getElementById('test-email-result');
    const to = document.getElementById('test-email-to').value.trim();
    result.textContent = '';
    try {
      const sent = await apiJson('/api/admin/email/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(to ? { to } : {}),
      });
      result.textContent = `Sent from ${sent.from} to ${sent.to}. The mail server said: ${sent.response || 'OK'}. Check that inbox (and its spam folder).`;
    } catch (err) {
      result.textContent = `Not sent: ${err.message}`;
    }
  })
);

async function loadOverview() {
  loadBackups();
  loadAlerts();
  loadFailedPosts();
  loadVersion();
  try {
    const data = await apiJson('/api/admin/overview');
    renderSetup(data.setup);
    renderScheduler(data.scheduler);
    renderPublishing(data.publishing);
    renderBusiness(data.business);
    renderStorage(data.storage);
    document.getElementById('overview-loading').hidden = true;
    document.getElementById('overview-content').hidden = false;
  } catch (err) {
    document.getElementById('overview-loading').textContent = 'Failed to load the overview.';
    showToast(err.message);
  }
}

const refreshBtn = document.getElementById('overview-refresh');
refreshBtn.addEventListener('click', withLoading(refreshBtn, 'Refreshing…', loadOverview));
loadOverview();
