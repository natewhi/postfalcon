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
              `<tr class="admin-row-link" data-user-id="${u.id}"><td>${escapeHtml(u.email)}${u.is_admin ? ' (admin)' : ''}</td><td class="nowrap">${escapeHtml(
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
    const { user, accounts, recentPosts, postCounts } = await apiJson(`/api/admin/users/${id}`);
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
