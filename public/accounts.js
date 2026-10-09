async function loadAccounts() {
  const list = document.getElementById('accounts-list');
  list.innerHTML = '<li class="loading"><span class="spinner"></span> Loading accounts…</li>';
  try {
    const accounts = await apiJson('/api/v1/social-accounts');
    let reconnectTargets = {};
    try {
      reconnectTargets = JSON.parse(list.dataset.reconnect || '{}');
    } catch {
      // fall back to no Reconnect buttons
    }
    list.innerHTML =
      accounts
        .map((a) => {
          const issue = accountConnectionIssue(a);
          const target = reconnectTargets[a.platform];
          const days = a.token_expires_at
            ? Math.max(0, Math.ceil((new Date(a.token_expires_at).getTime() - Date.now()) / 86400000))
            : null;
          const pill =
            issue === 'reconnect'
              ? `<span class="account-issue account-issue-reconnect" title="${escapeHtml(a.reconnect_reason || '')}">Needs reconnecting</span>`
              : issue === 'expiring'
                ? `<span class="account-issue account-issue-expiring">${days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`}</span>`
                : '';
          return `
      <li class="${issue ? 'has-issue' : ''}">
        ${accountAvatarHtml(a)}
        <span class="content">
          ${escapeHtml(a.display_name)}
          ${pill}
        </span>
        ${issue && target ? `<a class="btn-link account-reconnect" href="${escapeHtml(target)}">Reconnect</a>` : ''}
        <button data-id="${a.id}" class="delete-btn">Remove</button>
      </li>
    `;
        })
        .join('') ||
      '<li class="empty">No accounts connected yet &mdash; connect one below to start scheduling posts.</li>';

    list.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener(
        'click',
        withLoading(btn, 'Removing…', async () => {
          const ok = await confirmDialog('Remove this account? All of its scheduled and past posts will be deleted too.', {
            confirmText: 'Remove',
          });
          if (!ok) return;
          try {
            await apiJson(`/api/v1/social-accounts/${btn.dataset.id}`, { method: 'DELETE' });
            loadAccounts();
            loadSidebarAccounts();
          } catch (err) {
            showToast(err.message);
          }
        })
      );
    });
  } catch (err) {
    list.innerHTML = '<li class="empty">Failed to load accounts.</li>';
    showToast(err.message);
  }
}

// The placeholder-account form is only rendered when there are stub platforms to add.
const accountForm = document.getElementById('account-form');
accountForm?.addEventListener(
  'submit',
  withLoading(accountForm.querySelector('button[type="submit"]'), 'Adding…', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await apiJson('/api/v1/social-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: form.platform.value, display_name: form.display_name.value }),
      });
      form.reset();
      loadAccounts();
      loadSidebarAccounts();
    } catch (err) {
      showToast(err.message);
    }
  })
);

const telegramForm = document.getElementById('telegram-connect-form');
telegramForm?.addEventListener(
  'submit',
  withLoading(telegramForm.querySelector('button[type="submit"]'), 'Connecting…', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await apiJson('/api/telegram/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: form.token.value.trim(), chat_id: form.chat_id.value.trim() }),
      });
      form.reset();
      showToast('Telegram channel connected.', 'success');
      loadAccounts();
      loadSidebarAccounts();
    } catch (err) {
      showToast(err.message);
    }
  })
);

const blueskyForm = document.getElementById('bluesky-connect-form');
blueskyForm?.addEventListener(
  'submit',
  withLoading(blueskyForm.querySelector('button[type="submit"]'), 'Connecting…', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await apiJson('/api/bluesky/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: form.handle.value.trim(), app_password: form.app_password.value.trim() }),
      });
      form.reset();
      showToast('Bluesky account connected.', 'success');
      loadAccounts();
      loadSidebarAccounts();
    } catch (err) {
      showToast(err.message);
    }
  })
);

if (new URLSearchParams(location.search).get('error') === 'plan_limit') {
  showToast('Some accounts were not connected — your plan’s account limit was reached.', 'error', '/pricing');
  history.replaceState(null, '', location.pathname);
}

loadAccounts();
