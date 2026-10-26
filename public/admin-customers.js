// Admin Customers: search by email, view one customer, and give or remove free access
// (routes/admin.js /api/admin/users*).

let currentUserId = null;
let currentUserIsAdmin = false;

function when(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

function day(value) {
  return value ? new Date(value).toLocaleDateString() : '—';
}

function emptyRow(columns, text) {
  return `<tr><td colspan="${columns}" class="empty">${escapeHtml(text)}</td></tr>`;
}

async function search(q) {
  const body = document.getElementById('customer-results');
  body.innerHTML = emptyRow(4, 'Searching…');
  try {
    const users = await apiJson(`/api/admin/users?q=${encodeURIComponent(q)}`);
    body.innerHTML = users.length
      ? users
          .map(
            (u) =>
              `<tr class="admin-row-link" data-user-id="${u.id}"><td>${escapeHtml(u.email)}${u.is_admin ? ' (admin)' : ''}${u.suspended_at ? ' <span class="admin-bad">(suspended)</span>' : ''}</td><td class="nowrap">${escapeHtml(
                u.plan
              )}</td><td class="nowrap">${escapeHtml(u.plan_status)}</td><td class="nowrap">${day(u.created_at)}</td></tr>`
          )
          .join('')
      : emptyRow(4, 'No customers match.');
  } catch (err) {
    body.innerHTML = emptyRow(4, 'Search failed.');
    showToast(err.message);
  }
}

function fact(label, value) {
  return `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`;
}

async function showCustomer(id) {
  currentUserId = id;
  const section = document.getElementById('customer-detail');
  try {
    const { user, accounts, recentPosts, postCounts, apiToken } = await apiJson(`/api/admin/users/${id}`);
    renderAccountActions(user, apiToken);
    document.getElementById('customer-title').textContent = user.email;
    const counts = Object.entries(postCounts).map(([s, n]) => `${n} ${s}`).join(', ') || 'none';
    document.getElementById('customer-facts').innerHTML = [
      fact('Plan', `${escapeHtml(user.plan)}${user.plan_interval ? ` (${escapeHtml(user.plan_interval)})` : ''}`),
      fact('Status', escapeHtml(user.plan_status)),
      fact('Renews / trial ends', day(user.plan_renews_at)),
      fact('Cancels', day(user.plan_cancels_at)),
      fact(
        'Stripe',
        user.stripeDashboardUrl
          ? `<a href="${escapeHtml(user.stripeDashboardUrl)}" target="_blank" rel="noopener">${escapeHtml(user.stripe_customer_id)} ↗</a>`
          : 'No Stripe customer'
      ),
      fact('Signed up', when(user.created_at)),
      fact('Email verified', user.email_verified_at ? day(user.email_verified_at) : 'No'),
      fact('Login', user.google_login ? 'Google' : 'Email & password'),
      fact('Posts', escapeHtml(counts)),
    ].join('');

    const accessNote = document.getElementById('customer-access-note');
    if (accessNote) accessNote.textContent = user.stripe_customer_id
      ? 'If this customer has a Stripe subscription, change their plan in Stripe instead — these buttons are refused for them.'
      : 'For review and test logins: gives the chosen plan without a Stripe subscription, or removes it.';

    currentUserIsAdmin = Boolean(user.is_admin);
    document.getElementById('customer-admin-note').textContent = currentUserIsAdmin
      ? 'Can open these admin pages, switch platforms, and give access or admin rights to others.'
      : 'Admins can open these admin pages, switch platforms, and give access or admin rights to others.';
    document.getElementById('customer-admin-toggle').textContent = currentUserIsAdmin ? 'Remove admin' : 'Make admin';

    document.getElementById('customer-accounts').innerHTML = accounts.length
      ? accounts
          .map(
            (a) =>
              `<tr><td class="nowrap">${escapeHtml(a.platform)}</td><td>${escapeHtml(a.display_name || '')}</td><td class="nowrap">${day(
                a.created_at
              )}</td><td>${a.needs_reconnect_at ? `<span class="admin-bad">Needs reconnect</span> ${escapeHtml(a.reconnect_reason || '')}` : 'OK'}</td></tr>`
          )
          .join('')
      : emptyRow(4, 'No connected accounts.');

    document.getElementById('customer-posts').innerHTML = recentPosts.length
      ? recentPosts
          .map(
            (p) =>
              `<tr><td class="nowrap">${when(p.updated_at)}</td><td class="nowrap">${escapeHtml(p.platform)}</td><td class="nowrap${
                p.status === 'failed' ? ' admin-bad' : ''
              }">${escapeHtml(p.status)}</td><td>${escapeHtml(p.content)}</td><td>${escapeHtml((p.error_message || '').slice(0, 200))}</td></tr>`
          )
          .join('')
      : emptyRow(5, 'No posts.');

    section.hidden = false;
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showToast(err.message);
  }
}

// Account and API token sections of the customer panel (routes/admin.js account actions).
let currentUser = null;

function renderAccountActions(user, apiToken) {
  currentUser = user;
  const status = [];
  status.push(user.suspended_at ? `Suspended since ${day(user.suspended_at)}: can't sign in, nothing of theirs publishes.` : 'Active.');
  status.push(user.email_verified_at ? 'Email verified.' : 'Email not verified yet.');
  document.getElementById('customer-account-status').textContent = status.join(' ');
  document.getElementById('customer-resend-verification').hidden = Boolean(user.email_verified_at);
  document.getElementById('customer-mark-verified').hidden = Boolean(user.email_verified_at);
  document.getElementById('customer-suspend').textContent = user.suspended_at ? 'Unsuspend' : 'Suspend';
  document.getElementById('customer-reset-created').hidden = true;

  document.getElementById('customer-token-status').textContent = apiToken
    ? `Has an API token, created ${day(apiToken.created_at)}, last used ${apiToken.last_used_at ? when(apiToken.last_used_at) : 'never'}. Revoke it if it may have leaked; they can make a new one in Settings.`
    : 'No API token.';
  document.getElementById('customer-token-revoke').hidden = !apiToken;
}

// Runs an account action, then reloads the panel (or, for a deletion, closes it).
async function accountAction({ confirm, confirmText, request, success, after }) {
  if (!currentUser) return;
  if (confirm && !(await confirmDialog(confirm, { confirmText }))) return;
  try {
    const result = await apiJson(`/api/admin/users/${currentUser.id}${request.path}`, {
      method: request.method,
      headers: { 'Content-Type': 'application/json' },
      body: request.body ? JSON.stringify(request.body) : undefined,
    });
    if (success) showToast(typeof success === 'function' ? success(result) : success, 'success');
    if (after) after(result);
    else showCustomer(currentUser.id);
  } catch (err) {
    showToast(err.message);
  }
}

document.getElementById('customer-reset-link').addEventListener('click', () =>
  accountAction({
    request: { path: '/password-reset-link', method: 'POST' },
    after: ({ url }) => {
      const input = document.getElementById('customer-reset-url');
      input.value = url;
      document.getElementById('customer-reset-created').hidden = false;
      input.select();
    },
  })
);

document.getElementById('customer-reset-copy').addEventListener('click', () => {
  const input = document.getElementById('customer-reset-url');
  navigator.clipboard
    .writeText(input.value)
    .then(() => showToast('Link copied.', 'success'))
    .catch(() => {
      input.select();
      showToast('Select the link and copy it with Ctrl+C.', 'warning');
    });
});

document.getElementById('customer-resend-verification').addEventListener('click', () =>
  accountAction({
    request: { path: '/verification-email', method: 'POST' },
    success: ({ emailConfigured }) =>
      emailConfigured
        ? `Verification email sent to ${currentUser.email}.`
        : "Email isn't set up on this server, so it was only logged. Use Mark email verified instead.",
  })
);

document.getElementById('customer-mark-verified').addEventListener('click', () =>
  accountAction({
    confirm: `Mark ${currentUser?.email}'s email as verified without them clicking a link?`,
    confirmText: 'Mark verified',
    request: { path: '/verify-email', method: 'POST' },
    success: 'Email marked as verified.',
  })
);

document.getElementById('customer-suspend').addEventListener('click', () => {
  const suspend = !currentUser?.suspended_at;
  accountAction({
    confirm: suspend
      ? `Suspend ${currentUser.email}? They're signed out at once, can't sign in or use their API token, and their scheduled posts fail instead of publishing. Nothing is deleted.`
      : `Unsuspend ${currentUser.email}? They can sign in again; posts that failed while suspended stay failed until retried.`,
    confirmText: suspend ? 'Suspend' : 'Unsuspend',
    request: { path: '/suspend', method: 'POST', body: { suspended: suspend } },
    success: suspend ? 'Account suspended.' : 'Account unsuspended.',
  });
});

document.getElementById('customer-delete').addEventListener('click', () =>
  accountAction({
    confirm: `Delete ${currentUser?.email} permanently? Their connected accounts, posts and media go too${
      currentUser?.stripe_customer_id ? ', and their Stripe subscription is cancelled' : ''
    }. This can't be undone.`,
    confirmText: 'Delete account',
    request: { path: '', method: 'DELETE' },
    success: 'Account deleted.',
    after: () => {
      document.getElementById('customer-detail').hidden = true;
      currentUserId = null;
      currentUser = null;
      const q = document.getElementById('customer-q').value.trim();
      search(q);
    },
  })
);

document.getElementById('customer-token-revoke').addEventListener('click', () =>
  accountAction({
    confirm: `Revoke ${currentUser?.email}'s API token? Anything using it (scripts, AI agents) stops working until they make a new one.`,
    confirmText: 'Revoke',
    request: { path: '/api-token', method: 'DELETE' },
    success: 'API token revoked.',
  })
);

async function toggleAdmin() {
  if (!currentUserId) return;
  const admin = !currentUserIsAdmin;
  const email = document.getElementById('customer-title').textContent;
  const ok = await confirmDialog(
    admin
      ? `Make ${email} an admin? They'll see every customer and can change platform and access settings.`
      : `Remove ${email}'s admin rights?`,
    { confirmText: admin ? 'Make admin' : 'Remove admin' }
  );
  if (!ok) return;
  try {
    await apiJson(`/api/admin/users/${currentUserId}/admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin }),
    });
    showToast(admin ? 'Admin rights given.' : 'Admin rights removed.', 'success');
    showCustomer(currentUserId);
  } catch (err) {
    showToast(err.message);
  }
}

async function setAccess(grant) {
  if (!currentUserId) return;
  const plan = document.getElementById('customer-access-plan').value;
  const email = document.getElementById('customer-title').textContent;
  const ok = await confirmDialog(
    grant
      ? `Give ${email} free ${plan} access, without a subscription?`
      : `Remove ${email}'s access? They won't be able to publish until they subscribe.`,
    { confirmText: grant ? 'Give access' : 'Remove access' }
  );
  if (!ok) return;
  try {
    await apiJson(`/api/admin/users/${currentUserId}/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant, plan }),
    });
    showToast(grant ? 'Access given.' : 'Access removed.', 'success');
    showCustomer(currentUserId);
  } catch (err) {
    showToast(err.message);
  }
}

document.getElementById('customer-search').addEventListener('submit', (e) => {
  e.preventDefault();
  search(document.getElementById('customer-q').value.trim());
});

document.getElementById('customer-results').addEventListener('click', (e) => {
  const row = e.target.closest('[data-user-id]');
  if (row) showCustomer(Number(row.dataset.userId));
});

document.getElementById('customer-grant')?.addEventListener('click', () => setAccess(true));
document.getElementById('customer-revoke')?.addEventListener('click', () => setAccess(false));
document.getElementById('customer-admin-toggle').addEventListener('click', toggleAdmin);

search('');

// Sign-ups: the instance's open / invite-only / closed setting and its invite links
// (routes/admin.js /api/admin/signups, /api/admin/invites).
async function loadSignups() {
  const select = document.getElementById('signup-mode');
  try {
    const { mode, invites } = await apiJson('/api/admin/signups');
    select.value = mode;
    select.disabled = false;
    const now = Date.now();
    document.getElementById('invite-rows').innerHTML = invites.length
      ? invites
          .map((i) => {
            const status = i.used_at
              ? `Used by ${escapeHtml(i.used_by_email || 'a deleted account')} ${day(i.used_at)}`
              : new Date(i.expires_at).getTime() < now
                ? 'Expired'
                : 'Unused';
            const revoke = i.used_at ? '' : `<button type="button" class="btn-secondary" data-revoke-invite="${i.id}">Revoke</button>`;
            return `<tr><td>${escapeHtml(i.note || '')}</td><td class="nowrap">${day(i.created_at)}</td><td class="nowrap">${day(
              i.expires_at
            )}</td><td>${status}</td><td>${revoke}</td></tr>`;
          })
          .join('')
      : emptyRow(5, 'No invite links yet.');
  } catch (err) {
    showToast(err.message);
  }
}

document.getElementById('signup-mode-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { mode } = await apiJson('/api/admin/signups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: document.getElementById('signup-mode').value }),
    });
    const labels = { open: 'Anyone can sign up.', invite: 'Sign-ups need an invite link.', closed: 'Sign-ups are closed.' };
    showToast(labels[mode], 'success');
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const noteInput = document.getElementById('invite-note');
  try {
    const invite = await apiJson('/api/admin/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: noteInput.value.trim() || undefined }),
    });
    const urlInput = document.getElementById('invite-url');
    urlInput.value = invite.url;
    document.getElementById('invite-created').hidden = false;
    urlInput.select();
    noteInput.value = '';
    loadSignups();
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('invite-copy').addEventListener('click', async () => {
  const input = document.getElementById('invite-url');
  try {
    await navigator.clipboard.writeText(input.value);
    showToast('Invite link copied.', 'success');
  } catch {
    input.select();
    showToast('Select the link and copy it with Ctrl+C.', 'warning');
  }
});

document.getElementById('invite-rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-revoke-invite]');
  if (!btn) return;
  const ok = await confirmDialog('Revoke this invite link? Nobody will be able to sign up with it.', { confirmText: 'Revoke' });
  if (!ok) return;
  try {
    await apiJson(`/api/admin/invites/${btn.dataset.revokeInvite}`, { method: 'DELETE' });
    loadSignups();
  } catch (err) {
    showToast(err.message);
  }
});

loadSignups();
