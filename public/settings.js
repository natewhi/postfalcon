async function loadApiTokenStatus() {
  const statusEl = document.getElementById('api-token-status');
  const generateBtn = document.getElementById('api-token-generate');
  const revokeBtn = document.getElementById('api-token-revoke');
  try {
    const status = await apiJson('/api/auth/api-token');
    if (status.exists) {
      const created = `created ${new Date(status.created_at).toLocaleDateString()}`;
      const used = status.last_used_at ? `last used ${new Date(status.last_used_at).toLocaleString()}` : 'not used yet';
      statusEl.textContent = `Token active — ${created}, ${used}.`;
      generateBtn.textContent = 'Regenerate token';
      revokeBtn.hidden = false;
    } else {
      statusEl.textContent = 'No API token yet.';
      generateBtn.textContent = 'Generate API token';
      revokeBtn.hidden = true;
    }
  } catch (err) {
    statusEl.textContent = 'Failed to load token status.';
    showToast(err.message);
  }
}

const generateTokenBtn = document.getElementById('api-token-generate');
generateTokenBtn.addEventListener(
  'click',
  withLoading(generateTokenBtn, 'Generating…', async () => {
    if (generateTokenBtn.textContent === 'Regenerate token') {
      const ok = await confirmDialog(
        'This invalidates the current token — any connected agent will need the new one. Continue?',
        { confirmText: 'Regenerate' }
      );
      if (!ok) return;
    }
    try {
      const result = await apiJson('/api/auth/api-token', { method: 'POST' });
      document.getElementById('api-token-value').value = result.token;
      document.getElementById('api-token-reveal').hidden = false;
      loadApiTokenStatus();
    } catch (err) {
      showToast(err.message);
    }
  })
);

document.getElementById('api-token-copy').addEventListener('click', async () => {
  const input = document.getElementById('api-token-value');
  input.select();
  await navigator.clipboard.writeText(input.value);
  showToast('Copied to clipboard.', 'success');
});

const revokeTokenBtn = document.getElementById('api-token-revoke');
revokeTokenBtn.addEventListener(
  'click',
  withLoading(revokeTokenBtn, 'Revoking…', async () => {
    const ok = await confirmDialog('Revoke your API token? Any connected agent will stop working until you generate a new one.', {
      confirmText: 'Revoke',
    });
    if (!ok) return;
    try {
      await apiJson('/api/auth/api-token', { method: 'DELETE' });
      document.getElementById('api-token-reveal').hidden = true;
      loadApiTokenStatus();
      showToast('Token revoked.', 'success');
    } catch (err) {
      showToast(err.message);
    }
  })
);

loadApiTokenStatus();

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

// Where the subscription stands, in words. A cancelled-at-period-end subscription keeps
// working until cancelsAt, so that comes first; renewsAt is the trial's end while trialing.
function billingStatusLine(s) {
  if (s.cancelsAt) return `Cancelled — you keep access until ${formatDate(s.cancelsAt)}, and won't be charged again.`;
  switch (s.planStatus) {
    case 'trialing':
      return s.renewsAt ? `Free trial — your first payment is on ${formatDate(s.renewsAt)}.` : 'Free trial.';
    case 'active':
      return s.renewsAt ? `Renews ${formatDate(s.renewsAt)}.` : '';
    case 'past_due':
      return 'Your last payment failed — update your card in Manage billing to keep publishing.';
    case 'incomplete':
      return 'Not started — choose a plan to start your free trial.';
    case 'canceled':
      return 'Your subscription has ended — choose a plan to start publishing again.';
    default:
      return '';
  }
}

async function loadPlan() {
  const summary = document.getElementById('plan-summary');
  const manageBtn = document.getElementById('manage-billing-btn');
  try {
    const s = await apiJson('/api/billing/status');
    const accountsLimit = s.limits.accounts === null ? 'unlimited' : s.limits.accounts;
    const postsLimit = s.limits.scheduledPosts === null ? 'unlimited' : s.limits.scheduledPosts;
    let line = `${s.planName} plan — ${s.usage.accounts}/${accountsLimit} connected accounts, ${s.usage.scheduledPosts}/${postsLimit} scheduled posts.`;
    line += ` ${billingStatusLine(s)}`;
    summary.textContent = line.trim();
    manageBtn.hidden = !s.hasBillingAccount;

    if (s.capabilities && s.capabilities.webhooks) {
      document.getElementById('webhooks-section').hidden = false;
      loadWebhooks();
    }
  } catch (err) {
    summary.textContent = 'Failed to load plan details.';
    showToast(err.message);
  }
}

const manageBillingBtn = document.getElementById('manage-billing-btn');
manageBillingBtn.addEventListener(
  'click',
  withLoading(manageBillingBtn, 'Opening…', async () => {
    try {
      const { url } = await apiJson('/api/billing/portal', { method: 'POST' });
      window.location.href = url;
    } catch (err) {
      showToast(err.message);
    }
  })
);

if (new URLSearchParams(location.search).get('checkout') === 'success') {
  showToast('Subscription active — thanks!', 'success');
  history.replaceState(null, '', location.pathname);
  // Stripe's webhook usually lands a moment after the redirect back here, so the first
  // loadPlan() below can still show the pre-checkout state. Look again shortly.
  setTimeout(loadPlan, 3000);
  setTimeout(loadPlan, 8000);
}

loadPlan();

async function loadWebhooks() {
  const list = document.getElementById('webhooks-list');
  try {
    const hooks = await apiJson('/api/v1/webhooks');
    if (hooks.length === 0) {
      list.innerHTML = '<li class="empty">No webhooks yet.</li>';
      return;
    }
    list.innerHTML = hooks
      .map((h) => {
        const last = h.last_delivery_at
          ? `last delivery ${new Date(h.last_delivery_at).toLocaleString()} (HTTP ${h.last_delivery_status ?? '—'})`
          : 'no deliveries yet';
        return `
          <li>
            <div class="webhook-row">
              <span class="webhook-url">${escapeHtml(h.url)}</span>
              <span class="hint">${escapeHtml(h.events.join(', '))} — ${escapeHtml(last)}</span>
            </div>
            <button type="button" class="delete-btn" data-id="${h.id}">Remove</button>
          </li>`;
      })
      .join('');
    list.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener(
        'click',
        withLoading(btn, 'Removing…', async () => {
          const ok = await confirmDialog('Remove this webhook?', { confirmText: 'Remove' });
          if (!ok) return;
          try {
            await apiJson(`/api/v1/webhooks/${btn.dataset.id}`, { method: 'DELETE' });
            loadWebhooks();
          } catch (err) {
            showToast(err.message);
          }
        })
      );
    });
  } catch (err) {
    list.innerHTML = '<li class="empty">Failed to load webhooks.</li>';
    showToast(err.message);
  }
}

const webhookAddForm = document.getElementById('webhook-add-form');
webhookAddForm.addEventListener(
  'submit',
  withLoading(webhookAddForm.querySelector('button[type="submit"]'), 'Adding…', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      const hook = await apiJson('/api/v1/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: form.url.value }),
      });
      document.getElementById('webhook-secret-value').value = hook.secret;
      document.getElementById('webhook-secret-reveal').hidden = false;
      form.reset();
      loadWebhooks();
    } catch (err) {
      showToast(err.message);
    }
  })
);

document.getElementById('webhook-secret-copy').addEventListener('click', async () => {
  const input = document.getElementById('webhook-secret-value');
  input.select();
  await navigator.clipboard.writeText(input.value);
  showToast('Copied to clipboard.', 'success');
});

const changePasswordForm = document.getElementById('change-password-form');
changePasswordForm.addEventListener(
  'submit',
  withLoading(changePasswordForm.querySelector('button[type="submit"]'), 'Updating…', async (e) => {
    e.preventDefault();
    const form = e.target;
    if (form.newPassword.value !== form.confirmNewPassword.value) {
      showToast("New password and confirmation don't match.");
      return;
    }
    try {
      // form.currentPassword doesn't exist at all for a Google-only account setting its first
      // password (see views/settings.ejs) — optional chaining leaves it undefined, which
      // JSON.stringify drops, matching the backend's optional currentPassword field.
      await apiJson('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: form.currentPassword?.value, newPassword: form.newPassword.value }),
      });
      form.reset();
      showToast('Password updated. Other logged-in sessions have been signed out.', 'success');
    } catch (err) {
      showToast(err.message);
    }
  })
);

const deleteAccountForm = document.getElementById('delete-account-form');
deleteAccountForm.addEventListener(
  'submit',
  withLoading(deleteAccountForm.querySelector('button[type="submit"]'), 'Deleting…', async (e) => {
    e.preventDefault();
    const form = e.target;
    const ok = await confirmDialog('This permanently deletes your account and everything in it. Are you sure?', {
      confirmText: 'Delete my account',
    });
    if (!ok) return;
    try {
      await apiJson('/api/auth/delete-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: form.password?.value }),
      });
      window.location.href = '/login';
    } catch (err) {
      showToast(err.message);
    }
  })
);
